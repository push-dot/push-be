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
import base64
import json
import os
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PARITY = Path(os.environ.get("PARITY_DIR") or ROOT.parent / "core-api" / "test" / "parity")
NOW_NS = 1_792_670_400 * 1_000_000_000
TOKEN = "parity-token"
sys.path.insert(0, str(ROOT / "src"))


def idempotency_key(index: int) -> str:
    return f"00000000-0000-4000-8000-{index:012d}"


async def rows(url: str, sql: str) -> list[dict]:
    import asyncpg
    conn = await asyncpg.connect(url)
    try:
        return [{k: (None if v is None else str(v)) for k, v in dict(r).items()} for r in await conn.fetch(sql)]
    finally:
        await conn.close()


async def seed(url: str, storage: str) -> None:
    import asyncpg
    conn = await asyncpg.connect(url)
    try:
        await conn.execute((PARITY / "seed.sql").read_text())
        images = Path(storage) / "images"
        images.mkdir(parents=True, exist_ok=True)
        for row in await conn.fetch("SELECT key, content FROM upload_images"):
            (images / row["key"]).write_bytes(bytes(row["content"]))
    finally:
        await conn.close()


def freeze_datetime() -> None:
    from datetime import datetime, timezone

    frozen = datetime.fromtimestamp(NOW_NS // 1_000_000_000, timezone.utc)

    class Frozen(datetime):
        @classmethod
        def now(cls, tz=None):
            return frozen if tz else frozen.replace(tzinfo=None)

        @classmethod
        def utcnow(cls):
            return frozen.replace(tzinfo=None)

    import app.api.routers.evidence as evidence_routes
    import app.infrastructure.google_client as google_client
    evidence_routes.datetime = Frozen
    google_client.datetime = Frozen


def mock_http(rules: list[dict]):
    import httpx

    def handler(request):
        url = str(request.url)
        for rule in rules:
            if rule["method"] == request.method and url.startswith(rule["url"]):
                return httpx.Response(rule.get("status", 200), json=rule.get("body"))
        return httpx.Response(599, json={"error": "no parity rule for " + url})

    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def request_kwargs(case: dict, headers: dict) -> dict:
    body = case.get("body")
    if body is None:
        return {"headers": headers}
    if "multipart" in body:
        part = body["multipart"]
        files = None
        if part.get("file"):
            f = part["file"]
            files = {"file": (f["name"], base64.b64decode(f["base64"]), f["type"])}
        return {"headers": headers, "data": part.get("fields") or {}, "files": files}
    return {"headers": headers, "json": body}


def answer(res) -> dict:
    if 300 <= res.status_code < 400:
        return {"location": res.headers.get("location")}
    kind = res.headers.get("content-type", "")
    if not res.content:
        return {"body": None}
    if kind.startswith("application/json"):
        return {"body": res.json()}
    return {"contentType": kind, "base64": base64.b64encode(res.content).decode()}


def main() -> None:
    group = sys.argv[1]
    url = os.environ["PARITY_PG_URL"]
    os.environ.update({
        "DATABASE_URL": url, "DB_DRIVER": "asyncpg", "PG_TRANSPORT": "tcp",
        "RUN_MIGRATIONS": "0", "QUEUE_BACKEND": "redis", "CHECKPOINTER": "memory",
        "APP_ENV": "production", "BLOB_STORE": "db", "STORAGE_DIR": tempfile.mkdtemp(),
    })
    os.environ.pop("AI_SHARED_SECRET", None)
    env_file = PARITY / f"{group}.env.json"
    if env_file.exists():
        os.environ.update(json.loads(env_file.read_text()))
    asyncio.run(seed(url, os.environ["STORAGE_DIR"]))
    time.time_ns = lambda: NOW_NS

    from fastapi.testclient import TestClient

    from app.main import create_app
    freeze_datetime()

    cases = json.loads((PARITY / f"{group}.cases.json").read_text())
    golden = []
    http_file = PARITY / f"{group}.http.json"
    with TestClient(create_app(), follow_redirects=False) as client:
        if http_file.exists():
            client.app.state.deps.google.gapi._client = mock_http(json.loads(http_file.read_text()))
        for index, case in enumerate(cases):
            if case.get("sql"):
                golden.append({"name": case["name"], "status": 0, "body": asyncio.run(rows(url, case["sql"]))})
                continue
            headers = {"x-request-id": "parity"}
            if case.get("auth", True):
                headers["authorization"] = "Bearer " + TOKEN
            if case["method"] in ("POST", "PATCH", "PUT"):
                headers["idempotency-key"] = idempotency_key(index)
            res = client.request(case["method"], case["path"], **request_kwargs(case, headers))
            golden.append({"name": case["name"], "status": res.status_code, **answer(res)})
    (PARITY / f"{group}.golden.json").write_text(json.dumps(golden, ensure_ascii=False, indent=1) + "\n")
    print(f"{group}: {len(golden)} cases")


if __name__ == "__main__":
    main()
