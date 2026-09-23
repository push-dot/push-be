from __future__ import annotations
import asyncio
import hashlib
import json
import os
import statistics
import sys
import time
from pathlib import Path
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.db import DB, create_pool, run_migrations
from app.domain.services.experiment import ExperimentService

N_USERS = 2000
RESULTS_CALLS = 200
BASE_URL = os.environ.get("BASE_URL", "http://localhost:8080")
DEV_TOKEN = os.environ.get("DEV_AUTH_TOKEN", "devtoken")

SPECS = [
    {"key": "home-greeting", "variants": ["A", "B"],
     "exclusion_group": "home-hero"},
    {"key": "home-cta", "variants": ["A", "B"],
     "exclusion_group": "home-hero"},
    {"key": "stream-render", "variants": ["A", "B"],
     "exclusion_group": "chat-core"},
    {"key": "approval-surface", "variants": ["A", "B"],
     "exclusion_group": "chat-core"},
]

PROPENSITY = {
    "home-greeting": {"A": 0.20, "B": 0.32},
    "home-cta": {"A": 0.10, "B": 0.10},
}

NEUTRAL_PROPENSITY = 0.5


def converts(user_id, key, variant) -> bool:
    p = PROPENSITY.get(key, {}).get(variant, NEUTRAL_PROPENSITY)
    h = int(hashlib.sha256(f"{user_id}:{key}:conv".encode()).hexdigest(), 16)
    return (h % 1000) / 1000 < p


def aborts(user_id, key) -> bool:
    h = int(hashlib.sha256(f"{user_id}:{key}:abort".encode()).hexdigest(), 16)
    return key == "stream-render" and h % 10 == 0


async def main() -> None:
    pool = await create_pool(os.environ["DATABASE_URL"])
    db = DB(pool)
    await run_migrations(pool, str(Path(__file__).resolve().parent.parent
                                 / "migrations"))
    svc = ExperimentService(db)
    await svc.seed(SPECS)

    users = [uuid4() for _ in range(N_USERS)]
    await pool.executemany(
        "INSERT INTO users (id, provider, provider_subject, display_name) "
        "VALUES ($1, 'sim', $2, 'sim') ON CONFLICT DO NOTHING",
        [(u, str(u)) for u in users])

    enrolled = {}
    violations = 0
    for u in users:
        keys_enrolled = []
        seen_groups = set()
        for spec in SPECS:
            key = spec["key"]
            a = await svc.assignment(u, key)
            if not a.enrolled:
                continue
            if spec["exclusion_group"] in seen_groups:
                violations += 1
            seen_groups.add(spec["exclusion_group"])
            keys_enrolled.append(key)
            await svc.record_event(u, key, "exposure")
            if aborts(u, key):
                await svc.record_event(u, key, "aborted")
            if converts(u, key, a.variant):
                await svc.record_event(u, key, "conversion")
        for key in keys_enrolled:
            enrolled[key] = enrolled.get(key, 0) + 1

    print("exclusion violations:", violations)
    print("enrolled per experiment:", enrolled)

    for spec in SPECS:
        res = await svc.results(spec["key"])
        print(json.dumps(res))

    import httpx
    lat = []
    async with httpx.AsyncClient(base_url=BASE_URL) as client:
        for _ in range(RESULTS_CALLS):
            t0 = time.perf_counter()
            r = await client.get(
                "/api/v1/experiments/home-greeting/results",
                headers={"Authorization": f"Bearer {DEV_TOKEN}"})
            lat.append((time.perf_counter() - t0) * 1000)
            r.raise_for_status()
    lat.sort()
    p95 = lat[int(len(lat) * 0.95) - 1]
    print(f"results p50={lat[len(lat)//2]:.2f}ms "
          f"p95={p95:.2f}ms n={len(lat)}")

    counts = await pool.fetch(
        "SELECT experiment_key, variant, event, COUNT(*) n "
        "FROM experiment_events GROUP BY 1,2,3 ORDER BY 1,2,3")
    for r in counts:
        print(dict(r))
    await pool.close()


if __name__ == "__main__":
    asyncio.run(main())
