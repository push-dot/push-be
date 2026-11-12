from datetime import timedelta

from app.domain.chat_turns import compaction
from app.queue.credits import ShortBalance, available_micro, lock_owner, release_job, unless_busy

RETENTION = timedelta(days=30)
STATS_WINDOW = timedelta(hours=24)
# A stream attached to a job closes at its terminal event, so after this no reader is between two
# token rows when they merge.
COMPACT_AFTER = timedelta(minutes=10)
COMPACT_BATCH = 200
# Orphan threads erased per maintenance pass (SWEEP_S, 15 minutes). An orphan is a thread whose run
# wrote checkpoints after the thread was deleted. While fewer than this many wait, each goes in the
# first pass after its run ends, and a run ends within its deadline (JOB_DEADLINE_CHAT_S).
CHECKPOINT_SWEEP_BATCH = 500

# Statuses are literal so the planner can use ai_jobs_finished_uncompacted_idx (0057).
# A bot's turns are its chat history: they stay until the bot is deleted or its chat is cleared, which
# cascade from the thread. Only bot turns are compacted, so a compacted job is one of them. Notify jobs
# of a bot thread and every other job keep the 30-day rule.
_PURGE_FINISHED = (
    "DELETE FROM ai_jobs j WHERE j.status IN ('DONE', 'FAILED', 'DEAD', 'CANCELLED') "
    "AND NOT (j.checkpoint ? 'compacted') AND j.updated_at < $1 "
    "AND NOT (j.type = 'chat' AND EXISTS (SELECT 1 FROM conversations c "
    "WHERE c.id = j.conversation_id AND c.bot_id IS NOT NULL))"
)
_UNCOMPACTED_BOT_TURNS = (
    "SELECT j.id FROM ai_jobs j WHERE j.status IN ('DONE', 'FAILED', 'DEAD', 'CANCELLED') "
    "AND NOT (j.checkpoint ? 'compacted') AND j.updated_at < $1 AND j.type = 'chat' "
    "AND EXISTS (SELECT 1 FROM conversations c WHERE c.id = j.conversation_id AND c.bot_id IS NOT NULL) "
    "ORDER BY j.updated_at LIMIT $2"
)
# Takes the job's row lock, so an admin retry of the same job waits for the compaction.
_MARK_COMPACTED = (
    "UPDATE ai_jobs SET checkpoint = checkpoint || jsonb_build_object('compacted', true) "
    "WHERE id = $1 AND status IN ('DONE', 'FAILED', 'DEAD', 'CANCELLED') AND NOT (checkpoint ? 'compacted') "
    "RETURNING id"
)
_TURN_ROWS = "SELECT id, type, payload FROM chat_events WHERE job_id = $1 ORDER BY id"
_SET_TEXT = "UPDATE chat_events SET payload = jsonb_set(payload, '{text}', to_jsonb($2::text)) WHERE id = $1"
_DROP_ROWS = "DELETE FROM chat_events WHERE id = ANY($1::bigint[])"


def _iso(value):
    return value.isoformat().replace("+00:00", "Z") if value is not None else None


class AdminJobs:
    def __init__(self, conn):
        self.conn = conn

    async def close(self) -> None:
        await self.conn.close()

    async def dead_jobs(self, status: str, limit: int) -> list[dict]:
        rows = await self.conn.fetch(
            "SELECT id, type, status, error, attempts, updated_at FROM ai_jobs "
            "WHERE status = $1 ORDER BY updated_at DESC LIMIT $2", status, limit)
        return [{"id": str(r["id"]), "type": r["type"], "status": r["status"], "error": r["error"],
                 "attempts": r["attempts"], "updatedAt": _iso(r["updated_at"])} for r in rows]

    async def retry(self, job_id, now) -> bool:
        """Requeue a DEAD or FAILED job. Its released hold is reserved again under the owner row lock, like a charged
        enqueue, and only when the available balance covers it (ShortBalance otherwise, nothing changed)."""
        async with self.conn.transaction():
            hold = await self.conn.fetchrow(
                "SELECT user_id, company_id, amount_micro FROM credit_reservations "
                "WHERE job_id = $1 AND status = 'RELEASED'", job_id)
            if hold is not None:
                await lock_owner(self.conn, hold["user_id"], hold["company_id"])
            row = await self.conn.fetchrow(
                "UPDATE ai_jobs SET status = 'QUEUED', attempts = 0, error = NULL, heartbeat_at = NULL, "
                "run_after = $2, updated_at = $2 WHERE id = $1 AND status IN ('DEAD', 'FAILED') RETURNING queue",
                job_id, now)
            if row is None:
                return False
            if hold is not None:
                # shortcut: no month grant here (core-api owns the tier rules), so a retry in a month the owner has not
                # used yet can be short until their next billing read or send.
                if await available_micro(self.conn, hold["user_id"], hold["company_id"]) < int(hold["amount_micro"]):
                    raise ShortBalance()
                await self.conn.execute(
                    "UPDATE credit_reservations SET status = 'RESERVED', settled_micro = NULL, updated_at = $2 "
                    "WHERE job_id = $1 AND status = 'RELEASED'", job_id, now)
            await self.conn.execute("INSERT INTO outbox (job_id, queue) VALUES ($1, $2)", job_id, row["queue"])
        return True

    async def cancel(self, job_id, now) -> bool:
        tag = await self.conn.execute(
            "UPDATE ai_jobs SET status = 'CANCELLED', updated_at = $2 "
            "WHERE id = $1 AND status IN ('QUEUED', 'RETRY', 'RUNNING')", job_id, now)
        if tag.endswith(" 0"):
            return False
        await unless_busy(release_job(self.conn, job_id, now))
        return True

    async def type_stats(self, now) -> dict:
        rows = await self.conn.fetch(
            "SELECT type, "
            "percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM started_at - created_at)) AS wait_p50, "
            "percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM started_at - created_at)) AS wait_p95, "
            "percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM updated_at - started_at)) "
            "FILTER (WHERE status = 'DONE') AS run_p50, "
            "percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM updated_at - started_at)) "
            "FILTER (WHERE status = 'DONE') AS run_p95, "
            "count(*) FILTER (WHERE status IN ('FAILED', 'DEAD'))::float / greatest(count(*) FILTER "
            "(WHERE status IN ('DONE', 'FAILED', 'DEAD')), 1) AS fail_rate, "
            "count(*) FILTER (WHERE status = 'DEAD') AS dead "
            "FROM ai_jobs WHERE created_at >= $1 GROUP BY type", now - STATS_WINDOW)
        return {r["type"]: {
            "waitP50": _num(r["wait_p50"]), "waitP95": _num(r["wait_p95"]),
            "runP50": _num(r["run_p50"]), "runP95": _num(r["run_p95"]),
            "failRate": round(float(r["fail_rate"] or 0), 4), "dead": int(r["dead"]),
        } for r in rows}

    async def neon_stats(self) -> dict:
        size = await self.conn.fetchval("SELECT pg_database_size(current_database())")
        nodes = await self.conn.fetchval(
            "SELECT CASE WHEN to_regclass('rag_nodes') IS NULL THEN 0 ELSE "
            "(SELECT reltuples::bigint FROM pg_class WHERE oid = to_regclass('rag_nodes')) END")
        return {"dbSizeBytes": int(size or 0), "ragNodes": max(int(nodes or 0), 0)}

    async def open_billing_alerts(self) -> int:
        # Before migration 0042 the table is missing; the other db conditions must still be evaluated.
        try:
            count = await self.conn.fetchval(
                "SELECT count(*) FROM billing_alerts WHERE resolved_at IS NULL")
        except Exception as exc:
            if getattr(exc, "sqlstate", None) != "42P01":
                raise
            return 0
        return int(count or 0)

    async def expire_approvals(self, now) -> None:
        await self.conn.execute(
            "UPDATE approvals SET status = 'EXPIRED', updated_at = $1 "
            "WHERE status = 'PENDING' AND expires_at < $1", now)

    async def purge_finished(self, now) -> int:
        tag = await self.conn.execute(_PURGE_FINISHED, now - RETENTION)
        await self.conn.execute(
            "DELETE FROM outbox WHERE dispatched_at IS NOT NULL AND dispatched_at < $1", now - RETENTION)
        return int(tag.split()[-1])

    async def compact_finished(self, now) -> int:
        """Rewrites finished bot turns to the rows a reader needs (chat_turns.compaction), once each."""
        jobs = await self.conn.fetch(_UNCOMPACTED_BOT_TURNS, now - COMPACT_AFTER, COMPACT_BATCH)
        compacted = 0
        for job in jobs:
            async with self.conn.transaction():
                if await self.conn.fetchrow(_MARK_COMPACTED, job["id"]) is None:
                    continue
                merged, dropped = compaction([dict(row) for row in await self.conn.fetch(_TURN_ROWS, job["id"])])
                for row_id, text in merged.items():
                    await self.conn.execute(_SET_TEXT, row_id, text)
                if dropped:
                    await self.conn.execute(_DROP_ROWS, dropped)
            compacted += 1
        return compacted

    async def sweep_orphan_checkpoints(self) -> int:
        """Erases the model memory of deleted threads that the delete's trigger could not see (0057).
        Raises when the LangGraph checkpointer is set up and one of its tables is missing."""
        return int(await self.conn.fetchval("SELECT sweep_orphan_checkpoints($1)", CHECKPOINT_SWEEP_BATCH))


def _num(value) -> float | None:
    return None if value is None else round(float(value), 3)
