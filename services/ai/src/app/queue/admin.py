from datetime import timedelta

from app.queue.credits import release_job

FINISHED = ("DONE", "FAILED", "DEAD", "CANCELLED")
RETENTION = timedelta(days=30)
STATS_WINDOW = timedelta(hours=24)


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
        async with self.conn.transaction():
            row = await self.conn.fetchrow(
                "UPDATE ai_jobs SET status = 'QUEUED', attempts = 0, error = NULL, heartbeat_at = NULL, "
                "run_after = $2, updated_at = $2 WHERE id = $1 AND status IN ('DEAD', 'FAILED') RETURNING queue",
                job_id, now)
            if row is None:
                return False
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
        await release_job(self.conn, job_id, now)
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

    async def purge_finished(self, now) -> int:
        tag = await self.conn.execute(
            "DELETE FROM ai_jobs WHERE status = ANY($1::text[]) AND updated_at < $2",
            list(FINISHED), now - RETENTION)
        await self.conn.execute(
            "DELETE FROM outbox WHERE dispatched_at IS NOT NULL AND dispatched_at < $1", now - RETENTION)
        return int(tag.split()[-1])


def _num(value) -> float | None:
    return None if value is None else round(float(value), 3)
