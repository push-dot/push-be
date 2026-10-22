"""Count SQL this process sends while the chat worker is idle.

    cd services/ai
    DB_DRIVER=asyncpg DATABASE_URL=postgres://... python scripts/idle_db_probe.py

IDLE_PROBE_S defaults to 130. Needs the service dependencies
(`pip install -e '.[local]'`), not the test extra.

Do not point this at a database that has PENDING chat jobs.
claim() will mark one PENDING row RUNNING and this script does not run it.
"""

from __future__ import annotations

import asyncio
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

os.environ.setdefault("DB_DRIVER", "asyncpg")

from app.db import DB, POOL_IDLE_S, create_pool
from app.domain.services.conversation import ConversationService
from app.infrastructure.store_chat_jobs import ChatJobStore


class CountingPool:
    def __init__(self, inner):
        self._inner = inner
        self.queries = 0

    def __getattr__(self, name):
        return getattr(self._inner, name)

    async def execute(self, *args, **kwargs):
        self.queries += 1
        return await self._inner.execute(*args, **kwargs)

    async def fetch(self, *args, **kwargs):
        self.queries += 1
        return await self._inner.fetch(*args, **kwargs)

    async def fetchrow(self, *args, **kwargs):
        self.queries += 1
        return await self._inner.fetchrow(*args, **kwargs)

    async def fetchval(self, *args, **kwargs):
        self.queries += 1
        return await self._inner.fetchval(*args, **kwargs)


async def _main() -> int:
    url = os.environ.get("DATABASE_URL", "").strip()
    if not url:
        print("DATABASE_URL is required", file=sys.stderr)
        return 2
    seconds = float(os.environ.get("IDLE_PROBE_S", "130"))
    pool = await create_pool(url)
    counter = CountingPool(pool)
    svc = ConversationService.__new__(ConversationService)
    svc.jobs = ChatJobStore(DB(counter))
    svc._inflight = set()
    svc._wake = asyncio.Event()
    started = time.monotonic()
    task = asyncio.create_task(svc._worker_loop())
    try:
        await asyncio.sleep(seconds)
    finally:
        task.cancel()
        with_cancel = asyncio.gather(task, return_exceptions=True)
        await with_cancel
    elapsed = time.monotonic() - started
    queries = counter.queries
    await asyncio.sleep(POOL_IDLE_S + 5)
    size = pool.get_size() if hasattr(pool, "get_size") else -1
    await pool.close()
    qpm = queries / elapsed * 60 if elapsed else 0.0
    print(
        f"queries={queries} duration_s={elapsed:.1f} "
        f"qpm={qpm:.2f} pool_size_after_idle={size}")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(_main()))
