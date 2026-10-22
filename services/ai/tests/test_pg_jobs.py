import os

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
            "CREATE TABLE jobs ("
            "id uuid PRIMARY KEY, type text NOT NULL, queue text NOT NULL, "
            "status text NOT NULL, run_after timestamptz NOT NULL, "
            "heartbeat_at timestamptz NULL, updated_at timestamptz NOT NULL)")
        await conn.execute(
            "CREATE TABLE outbox ("
            "id bigserial PRIMARY KEY, job_id uuid NOT NULL, queue text NOT NULL, "
            "dispatched_at timestamptz NULL)")
        await conn.execute(
            "INSERT INTO jobs (id, type, queue, status, run_after, updated_at) "
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
            "UPDATE jobs SET status = 'RUNNING', heartbeat_at = $2 WHERE id = $1",
            CHAT, NOW)
        running = await db.running_jobs()
        assert running[0]["type"] == "chat"
        await db.mark_retry([CHAT], NOW)
        status = await conn.fetchval("SELECT status FROM jobs WHERE id = $1", CHAT)
        assert status == "RETRY"
        again = await db.pending_jobs(NOW)
        assert [row["id"] for row in again] == [CHAT]
    finally:
        await conn.close()
        await maint.execute(f'DROP DATABASE IF EXISTS "{name}"')
        await maint.close()
