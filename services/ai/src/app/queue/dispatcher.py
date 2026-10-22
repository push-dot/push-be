import asyncio
import contextlib
import hmac
import logging
import os
from dataclasses import dataclass
from uuid import UUID

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from app.clock import utcnow
from app.queue.admin import AdminJobs
from app.queue.alerts import db_conditions, redis_conditions
from app.queue.config import ALERT_S, SWEEP_S, heartbeat_limits, visibility_limits
from app.queue.streams import StreamQueue

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class DispatchStats:
    dispatched: int
    promoted: int
    requeued: int
    rehydrated: int


class PgJobs(AdminJobs):

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
            "SELECT id, type, heartbeat_at FROM ai_jobs WHERE status = 'RUNNING'")
        return [_row(row, "id", "type", "heartbeat_at") for row in rows]

    async def mark_retry(self, ids, now) -> None:
        await self.conn.execute(
            "UPDATE ai_jobs SET status = 'RETRY', run_after = $1, updated_at = $1 "
            "WHERE status = 'RUNNING' AND id = ANY($2::uuid[])",
            now, list(ids))

    async def pending_jobs(self, now):
        rows = await self.conn.fetch(
            "SELECT id, queue, updated_at FROM ai_jobs "
            "WHERE status IN ('QUEUED', 'RETRY', 'PENDING') AND run_after <= $1",
            now)
        return [_row(row, "id", "queue", "updated_at") for row in rows]


def _row(row, *keys):
    return {key: row[key] for key in keys}


class Dispatcher:
    def __init__(self, queue: StreamQueue, open_db, secret: str, *,
                 admin_token: str = "", now=utcnow, alerts=None):
        self.queue = queue
        self.open_db = open_db
        self.secret = secret
        self.admin_token = admin_token
        self.now = now
        self.alerts = alerts
        self.db_conditions: dict = {}

    async def run_once(self, now, *, maintain: bool = False) -> DispatchStats:
        db = await self.open_db()
        try:
            requeued = await self._requeue_stale(db, now)
            promoted = await self.queue.promote_due(now)
            dispatched = await self._dispatch_outbox(db, now)
            rehydrated = await self._rehydrate(db, now)
            stats = DispatchStats(dispatched, promoted, requeued, rehydrated)
            if maintain:
                await db.purge_finished(now)
                self.db_conditions = db_conditions(stats, await db.neon_stats())
            return stats
        finally:
            await db.close()

    async def check_alerts(self, now) -> None:
        if self.alerts is None:
            return
        await self.alerts.evaluate({**await redis_conditions(self.queue, now), **self.db_conditions}, now)

    async def run_forever(self) -> None:
        import uvicorn
        app = kick_app(self)
        port = int(os.environ.get("DISPATCH_PORT", "8091"))
        server = uvicorn.Server(uvicorn.Config(app, host="0.0.0.0", port=port, log_level="info"))
        stop = asyncio.Event()

        async def every(seconds: int, fn) -> None:
            while not stop.is_set():
                try:
                    await asyncio.wait_for(stop.wait(), seconds)
                except TimeoutError:
                    try:
                        await fn(self.now())
                    except Exception:
                        logger.exception("dispatcher periodic task failed")

        tasks = [
            asyncio.create_task(every(SWEEP_S, lambda now: self.run_once(now, maintain=True))),
            asyncio.create_task(every(ALERT_S, self.check_alerts)),
        ]
        try:
            await server.serve()
        finally:
            stop.set()
            for task in tasks:
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await task

    async def _requeue_stale(self, db, now) -> int:
        ids = []
        for row in await db.running_jobs():
            beat = row["heartbeat_at"]
            if beat is None:
                continue
            limits = heartbeat_limits()
            limit = limits.get(row["type"], limits["chat"])
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
        delayed = await self.queue.delayed_job_ids()
        present: dict[str, set[str]] = {}
        limits = visibility_limits()
        added = 0
        for row in await db.pending_jobs(now):
            job_id = str(row["id"])
            queue = row["queue"]
            if job_id in delayed:
                continue
            updated = row.get("updated_at")
            if updated is None:
                continue
            limit = limits.get(queue, limits["q:chat"])
            if (now - updated).total_seconds() < limit:
                continue
            if queue not in present:
                present[queue] = await self.queue.job_ids(queue)
            if job_id in present[queue]:
                continue
            await self.queue.add(queue, UUID(job_id))
            present[queue].add(job_id)
            added += 1
        return added


def kick_app(dispatcher: Dispatcher) -> FastAPI:
    from app.api.routers.admin_queue import admin_router

    app = FastAPI()
    app.include_router(admin_router(dispatcher))

    @app.get("/healthz")
    async def healthz():
        return {"ok": True}

    @app.post("/internal/kick")
    async def kick(request: Request):
        header = request.headers.get("x-push-dispatch-secret") or ""
        if not _secret_ok(header, dispatcher.secret):
            return JSONResponse(status_code=401, content={"error": {"code": "UNAUTHORIZED"}})
        await dispatcher.run_once(dispatcher.now())
        return JSONResponse(status_code=200, content={"data": {"ok": True}})

    return app


def _secret_ok(header: str, secret: str) -> bool:
    if not secret or not header or len(header) != len(secret):
        return False
    return hmac.compare_digest(header, secret)
