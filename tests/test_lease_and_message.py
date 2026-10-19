"""Quota leases stay under the shared cap, and enqueue stores the user message."""

from __future__ import annotations

import asyncio
import os
import socket
from uuid import uuid4

import pytest

from app.infrastructure.store_chat_jobs import ChatJobStore, user_message_id
from app.pgproto import PgPool
from app.ratelimit import CONSUME_SQL

DSN = os.environ.get(
    "PGPROTO_DSN", "postgresql://push:push@127.0.0.1:5432/push?sslmode=disable")

LEASE_BATCH = 20
# Same grant as front/src/handler.ts. $4 is the batch, $5 is unused hits
# being returned. The increment is stored as whole seconds on expires_at.
_AFTER = "GREATEST(0, rate_limits.hits - GREATEST($5::int, 0))"
_INSERT = "LEAST($4::int, $2::int)"
_UPDATE = "LEAST($4::int, GREATEST(0, $2::int - " + _AFTER + "))"
LEASE_SQL = (
    "WITH bumped AS ("
    "INSERT INTO rate_limits (bucket, hits, expires_at) "
    "VALUES ($1, " + _INSERT + ", "
    "to_timestamp($3::double precision) + " + _INSERT + " * interval '1 second') "
    "ON CONFLICT (bucket) DO UPDATE SET "
    "hits = " + _AFTER + " + " + _UPDATE + ", "
    "expires_at = to_timestamp($3::double precision) + " + _UPDATE + " * interval '1 second' "
    "WHERE $5::int > 0 OR rate_limits.hits < $2 "
    "RETURNING hits, "
    "(EXTRACT(EPOCH FROM expires_at) - $3::double precision)::bigint AS granted"
    ") SELECT hits, granted FROM bumped"
)


def _postgres_up() -> bool:
    try:
        with socket.create_connection(("127.0.0.1", 5432), timeout=1):
            return True
    except OSError:
        return False


class _Rec:
    def __init__(self):
        self.calls = []

    async def fetchrow(self, sql, *args):
        self.calls.append((sql, args))
        return None


class _DB:
    def __init__(self, conn):
        self.pool = conn

    def q(self):
        return self.pool


@pytest.mark.asyncio
async def test_enqueue_statement_includes_the_user_message():
    rec = _Rec()
    store = ChatJobStore(_DB(rec))
    job_id = uuid4()
    # The store picks the job id. The SQL must still name the stable message id.
    await store.enqueue_started(uuid4(), uuid4(), {"text": "안녕"}, "대기 중")
    sql, args = rec.calls[0]
    assert "INSERT INTO messages" in sql
    assert "ON CONFLICT (id) DO NOTHING" in sql
    assert "INSERT INTO chat_jobs" in sql
    assert "chat_events" in sql
    assert args[6] == "안녕"
    assert args[5] == user_message_id(args[2])
    assert job_id != args[2]


@pytest.mark.skipif(not _postgres_up(), reason="postgres not reachable")
@pytest.mark.asyncio
async def test_enqueue_stores_the_user_message_once():
    pool = PgPool(DSN, transport="tcp")
    schema = "msg_" + uuid4().hex[:8]
    store = ChatJobStore(_DB(pool))
    uid = uuid4()
    cid = uuid4()
    try:
        await pool.execute(f"CREATE SCHEMA {schema}")
        await pool.execute(f"SET search_path TO {schema}")
        await pool.execute(
            "CREATE TABLE conversations (id uuid PRIMARY KEY, user_id uuid NOT NULL)")
        await pool.execute(
            "CREATE TABLE messages ("
            "id uuid PRIMARY KEY, user_id uuid NOT NULL, conversation_id uuid NOT NULL, "
            "role text NOT NULL, text text NOT NULL, attachments jsonb NOT NULL, "
            "operation_id uuid, created_at timestamptz NOT NULL)")
        await pool.execute(
            "CREATE TABLE chat_jobs ("
            "id uuid PRIMARY KEY, user_id uuid NOT NULL, conversation_id uuid NOT NULL, "
            "payload jsonb NOT NULL, status text NOT NULL DEFAULT 'PENDING', "
            "attempt int NOT NULL DEFAULT 0, run_at timestamptz NOT NULL DEFAULT now(), "
            "created_at timestamptz NOT NULL DEFAULT now(), "
            "updated_at timestamptz NOT NULL DEFAULT now(), error text, checkpoint jsonb)")
        await pool.execute(
            "CREATE TABLE chat_events ("
            "id bigserial PRIMARY KEY, job_id uuid NOT NULL, type text NOT NULL, "
            "payload jsonb NOT NULL)")
        await pool.execute(
            "INSERT INTO conversations (id, user_id) VALUES ($1, $2)", cid, uid)
        job = await store.enqueue_started(uid, cid, {"text": "첫 메시지"}, "대기 중")
        assert job is not None
        count = await pool.fetchval("SELECT count(*) FROM messages")
        assert int(count) == 1
        row = await pool.fetchrow(
            "SELECT id, role, text, operation_id FROM messages")
        assert row["id"] == user_message_id(job)
        assert row["role"] == "USER"
        assert row["text"] == "첫 메시지"
        assert row["operation_id"] is None
        events = await pool.fetchval("SELECT count(*) FROM chat_events")
        assert int(events) == 1
        missing = await store.enqueue_started(uid, uuid4(), {"text": "없는 대화"}, "대기 중")
        assert missing is None
        assert int(await pool.fetchval("SELECT count(*) FROM messages")) == 1
    finally:
        await pool.execute(f"DROP SCHEMA IF EXISTS {schema} CASCADE")
        await pool.close()


@pytest.mark.skipif(not _postgres_up(), reason="postgres not reachable")
@pytest.mark.asyncio
async def test_lease_claims_never_pass_the_limit():
    schema = "lease_" + uuid4().hex[:8]
    bucket = "user:" + str(uuid4()) + ":1"
    limit = 50
    pools = [PgPool(DSN, transport="tcp") for _ in range(4)]
    try:
        await pools[0].execute(f"CREATE SCHEMA {schema}")
        for pool in pools:
            await pool.execute(f"SET search_path TO {schema}")
        await pools[0].execute(
            "CREATE TABLE rate_limits ("
            "bucket text PRIMARY KEY, hits integer NOT NULL, "
            "expires_at timestamptz NOT NULL)")

        async def claim(pool: PgPool) -> int:
            row = await pool.fetchrow(LEASE_SQL, bucket, limit, 2_000_000_000, LEASE_BATCH, 0)
            if row is None or row["hits"] is None:
                return 0
            return int(row["granted"] or 0)

        async def plus_one(pool: PgPool) -> int:
            hits = await pool.fetchval(CONSUME_SQL, bucket, 2_000_000_000, limit)
            return 0 if hits is None else 1

        grants = []
        for _ in range(20):
            grants.extend(await asyncio.gather(
                claim(pools[0]), claim(pools[1]),
                plus_one(pools[2]), claim(pools[3]),
            ))
        hits = int(await pools[0].fetchval(
            "SELECT hits FROM rate_limits WHERE bucket = $1", bucket))
        assert hits <= limit
        assert hits == sum(grants)
        assert hits == limit
        returned = await pools[0].fetchrow(
            LEASE_SQL, bucket, limit, 2_000_000_000, LEASE_BATCH, 5)
        assert int(returned["granted"]) == 5
        assert int(returned["hits"]) == limit
    finally:
        try:
            await pools[0].execute(f"DROP SCHEMA IF EXISTS {schema} CASCADE")
        finally:
            for pool in pools:
                await pool.close()
