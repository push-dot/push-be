"""Record the Python API's answers for a parity group.

    cd services/ai
    PARITY_PG_URL=postgresql://push:pw@localhost:55432/parity \\
      python scripts/record_parity.py applications

Needs a scratch database with every migration applied. The script wipes it,
loads services/core-api/test/parity/seed.sql, freezes the clock at
2026-10-22T12:00:00Z, sends each request in <group>.cases.json through the
FastAPI app, and writes <group>.golden.json next to it. Never point it at a
database you care about.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PARITY = ROOT.parent / "core-api" / "test" / "parity"
NOW_NS = 1_792_670_400 * 1_000_000_000
TOKEN = "parity-token"
sys.path.insert(0, str(ROOT / "src"))


def idempotency_key(index: int) -> str:
    return f"00000000-0000-4000-8000-{index:012d}"


async def seed(url: str) -> None:
    import asyncpg
    conn = await asyncpg.connect(url)
    try:
        await conn.execute((PARITY / "seed.sql").read_text())
    finally:
        await conn.close()


def main() -> None:
    group = sys.argv[1]
    url = os.environ["PARITY_PG_URL"]
    os.environ.update({
        "DATABASE_URL": url, "DB_DRIVER": "asyncpg", "PG_TRANSPORT": "tcp",
        "RUN_MIGRATIONS": "0", "QUEUE_BACKEND": "redis", "CHECKPOINTER": "memory",
        "APP_ENV": "production",
    })
    os.environ.pop("AI_SHARED_SECRET", None)
    asyncio.run(seed(url))
    time.time_ns = lambda: NOW_NS

    from fastapi.testclient import TestClient

    from app.main import create_app

    cases = json.loads((PARITY / f"{group}.cases.json").read_text())
    golden = []
    with TestClient(create_app()) as client:
        for index, case in enumerate(cases):
            headers = {"authorization": "Bearer " + TOKEN, "x-request-id": "parity"}
            if case["method"] in ("POST", "PATCH", "PUT"):
                headers["idempotency-key"] = idempotency_key(index)
            kwargs = {"headers": headers}
            if case.get("body") is not None:
                kwargs["json"] = case["body"]
            res = client.request(case["method"], case["path"], **kwargs)
            body = res.json() if res.content else None
            golden.append({"name": case["name"], "status": res.status_code, "body": body})
    (PARITY / f"{group}.golden.json").write_text(json.dumps(golden, ensure_ascii=False, indent=1) + "\n")
    print(f"{group}: {len(golden)} cases")


if __name__ == "__main__":
    main()
