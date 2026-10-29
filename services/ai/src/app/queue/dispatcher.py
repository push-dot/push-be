import asyncio
import contextlib
import hmac
import logging
import os
from dataclasses import dataclass
from datetime import timedelta
from uuid import UUID

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from app.account_purge import purge_deleted
from app.clock import utcnow
from app.queue.admin import AdminJobs
from app.ratelimit import sweep
from app.queue.alerts import db_conditions, redis_conditions
from app.queue.config import ALERT_S, QUEUE_GROUPS, SWEEP_S, heartbeat_limits, visibility_limits
from app.queue.streams import StreamQueue

logger = logging.getLogger(__name__)

BATCH = 500
# A finished job whose reservation is still RESERVED this long after is reconciled.
RECONCILE_AFTER_S = 300


@dataclass(frozen=True)
class DispatchStats:
    dispatched: int
    promoted: int
    requeued: int
    rehydrated: int


class PgJobs(AdminJobs):

    async def pending_outbox(self):
        rows = await self.conn.fetch(
            "SELECT id, job_id, queue FROM outbox WHERE dispatched_at IS NULL ORDER BY id LIMIT $1", BATCH)
        return [_row(row, "id", "job_id", "queue") for row in rows]

    async def mark_dispatched(self, ids, at) -> None:
        await self.conn.execute(
            "UPDATE outbox SET dispatched_at = $1 WHERE id = ANY($2::bigint[])",
            at, list(ids))

    async def running_jobs(self):
        rows = await self.conn.fetch(
            "SELECT id, type, heartbeat_at FROM ai_jobs WHERE status = 'RUNNING'")
        return [_row(row, "id", "type", "heartbeat_at") for row in rows]

    async def mark_retry(self, ids, now) -> list[dict]:
        """Requeue jobs whose worker died; a lost heartbeat costs an attempt, so a job
        that keeps killing its worker ends DEAD (reservation released) instead of looping."""
        rows = await self.conn.fetch(
            "WITH stale AS ("
            "UPDATE ai_jobs SET attempts = attempts + 1, run_after = $1, updated_at = $1, "
            "status = CASE WHEN attempts + 1 >= max_attempts THEN 'DEAD' ELSE 'RETRY' END "
            "WHERE status = 'RUNNING' AND id = ANY($2::uuid[]) RETURNING id, queue, status), "
            "released AS ("
            "UPDATE credit_reservations r SET status = 'RELEASED', updated_at = $1 FROM stale s "
            "WHERE r.job_id = s.id AND s.status = 'DEAD' AND r.status = 'RESERVED') "
            "SELECT id, queue, status FROM stale",
            now, list(ids))
        return [_row(row, "id", "queue", "status") for row in rows]

    async def pending_jobs(self, now):
        rows = await self.conn.fetch(
            "SELECT id, queue, updated_at FROM ai_jobs "
            "WHERE status IN ('QUEUED', 'RETRY') AND run_after <= $1 ORDER BY run_after LIMIT $2",
            now, BATCH)
        return [_row(row, "id", "queue", "updated_at") for row in rows]

    async def reconcile_credits(self, now) -> int:
        """Close reservations left RESERVED when a worker died between finish and settle."""
        row = await self.conn.fetchrow(
            "WITH settled AS ("
            "UPDATE credit_reservations r SET status = 'SETTLED', updated_at = $1, settled_micro = "
            "(SELECT COALESCE(SUM(u.cost_micro_credits), 0) FROM ai_usage u "
            "WHERE u.job_id = r.job_id AND u.status = 'SETTLED') "
            "FROM ai_jobs j WHERE j.id = r.job_id AND r.status = 'RESERVED' AND j.status = 'DONE' "
            "AND j.updated_at < $2 RETURNING 1), "
            "released AS ("
            "UPDATE credit_reservations r SET status = 'RELEASED', updated_at = $1 "
            "FROM ai_jobs j WHERE j.id = r.job_id AND r.status = 'RESERVED' "
            "AND j.status IN ('FAILED', 'DEAD', 'CANCELLED') AND j.updated_at < $2 RETURNING 1) "
            "SELECT (SELECT count(*) FROM settled) + (SELECT count(*) FROM released) AS n",
            now, now - timedelta(seconds=RECONCILE_AFTER_S))
        return int(row["n"]) if row else 0


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
        # The kick endpoint and the periodic sweep must not dispatch concurrently.
        self._pass = asyncio.Lock()

    async def run_once(self, now, *, maintain: bool = False) -> DispatchStats:
        async with self._pass:
            return await self._run_once(now, maintain)

    async def _run_once(self, now, maintain: bool) -> DispatchStats:
        db = await self.open_db()
        try:
            requeued = await self._requeue_stale(db, now)
            promoted = await self.queue.promote_due(now)
            dispatched = await self._dispatch_outbox(db, now)
            rehydrated = await self._rehydrate(db, now)
            stats = DispatchStats(dispatched, promoted, requeued, rehydrated)
            if maintain:
                await db.reconcile_credits(now)
                await db.purge_finished(now)
                await db.expire_approvals(now)
                pool = getattr(db, "conn", None)
                storage = os.environ.get("STORAGE_DIR") or None
                await sweep(pool)
                await purge_deleted(pool, storage)
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
        limits = heartbeat_limits()
        for row in await db.running_jobs():
            beat = row["heartbeat_at"]
            if beat is None:
                continue
            limit = limits.get(row["type"], limits["chat"])
            if (now - beat).total_seconds() >= limit:
                ids.append(row["id"])
        if not ids:
            return 0
        # The dead worker's message may already be acked by a reclaimer that saw
        # RUNNING, so re-add explicitly instead of waiting for a rehydrate.
        for row in await db.mark_retry(ids, now):
            if row["status"] == "DEAD":
                await self.queue.dead(row["id"], "heartbeat lost")
            else:
                await self.queue.add(row["queue"], UUID(str(row["id"])))
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
                present[queue] = await self.queue.live_job_ids(queue, QUEUE_GROUPS.get(queue, "ai"))
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
