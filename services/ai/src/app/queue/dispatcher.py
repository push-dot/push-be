import asyncio
import contextlib
import hmac
import os
from dataclasses import dataclass
from uuid import UUID

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from app.clock import utcnow
from app.queue.config import HEARTBEAT_LIMIT_S, SWEEP_S
from app.queue.streams import StreamQueue


@dataclass(frozen=True)
class DispatchStats:
    dispatched: int
    promoted: int
    requeued: int
    rehydrated: int


class PgJobs:
    def __init__(self, conn):
        self.conn = conn

    async def close(self) -> None:
        await self.conn.close()

    async def pending_outbox(self):
        rows = await self.conn.fetch(
            "SELECT id, job_id, queue FROM outbox WHERE dispatched_at IS NULL ORDER BY id")
        return [_row(row, "id", "job_id", "queue") for row in rows]

    async def mark_dispatched(self, ids, at) -> None:
        await self.conn.execute(
            "UPDATE outbox SET dispatched_at = $1 WHERE id = ANY($2::bigint[])",
            at, list(ids))

    async def running_jobs(self):
        rows = await self.conn.fetch(
            "SELECT id, type, heartbeat_at FROM jobs WHERE status = 'RUNNING'")
        return [_row(row, "id", "type", "heartbeat_at") for row in rows]

    async def mark_retry(self, ids, now) -> None:
        await self.conn.execute(
            "UPDATE jobs SET status = 'RETRY', run_after = $1, updated_at = $1 "
            "WHERE status = 'RUNNING' AND id = ANY($2::uuid[])",
            now, list(ids))

    async def pending_jobs(self, now):
        rows = await self.conn.fetch(
            "SELECT id, queue FROM jobs WHERE status IN ('QUEUED', 'RETRY') AND run_after <= $1",
            now)
        return [_row(row, "id", "queue") for row in rows]


def _row(row, *keys):
    return {key: row[key] for key in keys}


class Dispatcher:
    def __init__(self, queue: StreamQueue, open_db, secret: str):
        self.queue = queue
        self.open_db = open_db
        self.secret = secret

    async def run_once(self, now) -> DispatchStats:
        db = await self.open_db()
        try:
            requeued = await self._requeue_stale(db, now)
            promoted = await self.queue.promote_due(now)
            dispatched = await self._dispatch_outbox(db, now)
            rehydrated = await self._rehydrate(db, now)
            return DispatchStats(dispatched, promoted, requeued, rehydrated)
        finally:
            await db.close()

    async def run_forever(self) -> None:
        import uvicorn
        app = kick_app(self)
        port = int(os.environ.get("DISPATCH_PORT", "8091"))
        server = uvicorn.Server(uvicorn.Config(app, host="0.0.0.0", port=port, log_level="info"))
        stop = asyncio.Event()

        async def sweep() -> None:
            while not stop.is_set():
                try:
                    await asyncio.wait_for(stop.wait(), SWEEP_S)
                except TimeoutError:
                    await self.run_once(utcnow())

        task = asyncio.create_task(sweep())
        try:
            await server.serve()
        finally:
            stop.set()
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task

    async def _requeue_stale(self, db, now) -> int:
        ids = []
        for row in await db.running_jobs():
            beat = row["heartbeat_at"]
            if beat is None:
                continue
            limit = HEARTBEAT_LIMIT_S.get(row["type"], HEARTBEAT_LIMIT_S["chat"])
            if (now - beat).total_seconds() >= limit:
                ids.append(row["id"])
        if ids:
            await db.mark_retry(ids, now)
        return len(ids)

    async def _dispatch_outbox(self, db, now) -> int:
        rows = await db.pending_outbox()
        for row in rows:
            await self.queue.add(row["queue"], UUID(str(row["job_id"])))
        if rows:
            await db.mark_dispatched([row["id"] for row in rows], now)
        return len(rows)

    async def _rehydrate(self, db, now) -> int:
        grouped: dict[str, list] = {}
        for row in await db.pending_jobs(now):
            grouped.setdefault(row["queue"], []).append(row["id"])
        added = 0
        for queue, ids in grouped.items():
            if await self.queue.redis.xlen(queue) != 0:
                continue
            for job_id in ids:
                await self.queue.add(queue, UUID(str(job_id)))
                added += 1
        return added


def kick_app(dispatcher: Dispatcher) -> FastAPI:
    app = FastAPI()

    @app.post("/internal/kick")
    async def kick(request: Request):
        header = request.headers.get("x-push-dispatch-secret") or ""
        if not _secret_ok(header, dispatcher.secret):
            return JSONResponse(status_code=401, content={"error": {"code": "UNAUTHORIZED"}})
        await dispatcher.run_once(utcnow())
        return JSONResponse(status_code=200, content={"data": {"ok": True}})

    return app


def _secret_ok(header: str, secret: str) -> bool:
    if not secret or not header or len(header) != len(secret):
        return False
    return hmac.compare_digest(header, secret)
