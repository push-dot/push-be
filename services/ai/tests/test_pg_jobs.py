import os
from datetime import timedelta
from uuid import UUID

import pytest

from app.queue.dispatcher import PgJobs
from tests.test_queue_dispatcher import CHAT, NOW


@pytest.mark.asyncio
async def test_pg_jobs_sql_round_trip():
    asyncpg = pytest.importorskip("asyncpg")
    name = f"push_pgjobs_{os.getpid()}"
    try:
        maint = await asyncpg.connect(user="cyjoon", database="postgres", host="/tmp")
    except Exception as err:
        pytest.skip(f"local postgres unavailable: {err}")
    await maint.execute(f'DROP DATABASE IF EXISTS "{name}"')
    await maint.execute(f'CREATE DATABASE "{name}"')
    conn = await asyncpg.connect(user="cyjoon", database=name, host="/tmp")
    try:
        await conn.execute(
            "CREATE TABLE ai_jobs ("
            "id uuid PRIMARY KEY, type text NOT NULL, queue text NOT NULL, "
            "status text NOT NULL, run_after timestamptz NOT NULL, "
            "attempts int NOT NULL DEFAULT 0, max_attempts int NOT NULL DEFAULT 2, "
            "heartbeat_at timestamptz NULL, updated_at timestamptz NOT NULL)")
        await conn.execute(
            "CREATE TABLE credit_reservations ("
            "job_id uuid PRIMARY KEY, amount_micro bigint NOT NULL, status text NOT NULL, "
            "settled_micro bigint NULL, updated_at timestamptz NULL)")
        await conn.execute(
            "CREATE TABLE ai_usage (id uuid PRIMARY KEY, job_id uuid NULL, "
            "cost_micro_credits bigint NOT NULL, status text NOT NULL)")
        await conn.execute(
            "CREATE TABLE outbox ("
            "id bigserial PRIMARY KEY, job_id uuid NOT NULL, queue text NOT NULL, "
            "dispatched_at timestamptz NULL)")
        await conn.execute(
            "INSERT INTO ai_jobs (id, type, queue, status, run_after, updated_at) "
            "VALUES ($1, 'chat', 'q:chat', 'QUEUED', $2, $2)",
            CHAT, NOW)
        await conn.execute("INSERT INTO outbox (job_id, queue) VALUES ($1, 'q:chat')", CHAT)
        db = PgJobs(conn)
        pending = await db.pending_outbox()
        assert len(pending) == 1
        assert str(pending[0]["job_id"]) == str(CHAT)
        assert pending[0]["queue"] == "q:chat"
        await db.mark_dispatched([pending[0]["id"]], NOW)
        assert await db.pending_outbox() == []
        queued = await db.pending_jobs(NOW)
        assert [row["id"] for row in queued] == [CHAT]
        await conn.execute(
            "UPDATE ai_jobs SET status = 'RUNNING', heartbeat_at = $2 WHERE id = $1",
            CHAT, NOW)
        running = await db.running_jobs()
        assert running[0]["type"] == "chat"
        await conn.execute(
            "INSERT INTO credit_reservations (job_id, amount_micro, status) VALUES ($1, 80, 'RESERVED')", CHAT)
        assert await db.mark_retry([CHAT], NOW) == [{"id": CHAT, "queue": "q:chat", "status": "RETRY"}]
        again = await db.pending_jobs(NOW)
        assert [row["id"] for row in again] == [CHAT]
        # The second lost heartbeat exhausts max_attempts=2: DEAD and the hold is released.
        await conn.execute("UPDATE ai_jobs SET status = 'RUNNING' WHERE id = $1", CHAT)
        assert (await db.mark_retry([CHAT], NOW))[0]["status"] == "DEAD"
        held = await conn.fetchval("SELECT status FROM credit_reservations WHERE job_id = $1", CHAT)
        assert held == "RELEASED"
        # Reconcile: a DONE job whose settle never ran is settled at actual usage.
        await conn.execute(
            "UPDATE credit_reservations SET status = 'RESERVED' WHERE job_id = $1", CHAT)
        await conn.execute("UPDATE ai_jobs SET status = 'DONE', updated_at = $2 WHERE id = $1",
                           CHAT, NOW - timedelta(hours=1))
        await conn.execute(
            "INSERT INTO ai_usage (id, job_id, cost_micro_credits, status) VALUES ($1, $2, 30, 'SETTLED')",
            UUID(int=7), CHAT)
        assert await db.reconcile_credits(NOW) == 1
        row = await conn.fetchrow("SELECT status, settled_micro FROM credit_reservations WHERE job_id = $1", CHAT)
        assert (row["status"], row["settled_micro"]) == ("SETTLED", 30)
        assert await db.reconcile_credits(NOW) == 0
    finally:
        await conn.close()
        await maint.execute(f'DROP DATABASE IF EXISTS "{name}"')
        await maint.close()
