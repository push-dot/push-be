import os
from datetime import timedelta
from uuid import UUID

import pytest
from fakeredis.aioredis import FakeRedis

from app.domain import entities as ent
from app.domain.services.ai import AIGate
from app.infrastructure.store_ai import _USAGE_JOB_SQL
from app.queue.credits import CreditBook, release, release_job, settle, settle_job
from app.queue.streams import Message, StreamQueue
from app.queue.worker import Worker
from tests.test_queue_worker import NOW, MemoryJobs

USER = UUID("33333333-3333-4333-8333-333333333333")
JOB = UUID("11111111-1111-4111-8111-111111111111")
AGAIN = UUID("22222222-2222-4222-8222-222222222222")
USAGE = UUID("44444444-4444-4444-8444-444444444444")


def book(balance=100):
    store = CreditBook()
    store.ledger[USER] = balance
    return store


def queued(job_id, attempts=0, max_attempts=4):
    return {
        "id": job_id,
        "type": "chat",
        "queue": "q:chat",
        "status": "QUEUED",
        "user_id": USER,
        "company_id": None,
        "conversation_id": None,
        "attempts": attempts,
        "max_attempts": max_attempts,
        "payload": {},
        "heartbeat_at": None,
    }


def make_worker(redis, db, handler, store, max_note=None):
    async def do_settle(_db, job_id):
        return await settle(store, job_id)

    async def do_release(_db, job_id):
        await release(store, job_id)

    return Worker(
        StreamQueue(redis), db, "ai", "worker-a", ["q:chat"],
        {"chat": handler}, 1, now=lambda: NOW, settle=do_settle, release=do_release,
    )


@pytest.mark.asyncio
async def test_settle_charges_actual_and_returns_rest():
    store = book(100)
    store.reserve(JOB, USER, 80)
    store.add_usage(JOB, 30)
    assert await settle(store, JOB) == 50
    assert store.available(USER) == 70
    assert store.reservations[JOB]["status"] == "SETTLED"


@pytest.mark.asyncio
async def test_settle_overrun_allows_negative_balance():
    store = book(100)
    store.reserve(JOB, USER, 80)
    store.add_usage(JOB, 150)
    assert await settle(store, JOB) == 0
    assert store.available(USER) == -50


@pytest.mark.asyncio
async def test_exhausted_retries_go_dead_and_release():
    redis = FakeRedis(decode_responses=True)
    db = MemoryJobs()
    db.jobs[JOB] = queued(JOB, max_attempts=1)
    store = book(100)
    store.reserve(JOB, USER, 80)

    async def boom(_ctx):
        raise RuntimeError("nope")

    box = make_worker(redis, db, boom, store)
    await box.queue.add("q:chat", JOB)
    msg = (await box.queue.read("ai", "worker-a", ["q:chat"], 1, 0))[0]
    assert await box.process(msg) == "failed"
    assert db.jobs[JOB]["status"] == "DEAD"
    assert store.reservations[JOB]["status"] == "RELEASED"
    assert store.available(USER) == 100


@pytest.mark.asyncio
async def test_duplicate_delivery_runs_once():
    redis = FakeRedis(decode_responses=True)
    db = MemoryJobs()
    db.jobs[JOB] = queued(JOB)
    store = book(100)
    store.reserve(JOB, USER, 80)
    calls = {"handler": 0, "settle": 0}

    async def handler(_ctx):
        calls["handler"] += 1
        store.add_usage(JOB, 30)
        return {"messageId": "m"}

    async def do_settle(_db, job_id):
        calls["settle"] += 1
        return await settle(store, job_id)

    box = Worker(
        StreamQueue(redis), db, "ai", "worker-a", ["q:chat"],
        {"chat": handler}, 1, now=lambda: NOW, settle=do_settle,
    )
    await box.queue.add("q:chat", JOB)
    msg = (await box.queue.read("ai", "worker-a", ["q:chat"], 1, 0))[0]
    await box.process(msg)
    await box.process(Message("q:chat", "9-0", JOB))
    assert calls == {"handler": 1, "settle": 1}
    assert store.available(USER) == 70


@pytest.mark.asyncio
async def test_retry_does_not_charge_twice():
    redis = FakeRedis(decode_responses=True)
    db = MemoryJobs()
    db.jobs[JOB] = queued(JOB, max_attempts=4)
    store = book(100)
    store.reserve(JOB, USER, 80)
    calls = {"n": 0}

    async def handler(_ctx):
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("retry")
        store.add_usage(JOB, 30)
        return {"messageId": "m"}

    box = make_worker(redis, db, handler, store)
    await box.queue.add("q:chat", JOB)
    first = (await box.queue.read("ai", "worker-a", ["q:chat"], 1, 0))[0]
    assert await box.process(first) == "failed"
    assert store.reservations[JOB]["status"] == "RESERVED"
    assert store.available(USER) == 20
    db.jobs[JOB]["status"] = "RETRY"
    await box.process(Message("q:chat", "2-0", JOB))
    assert calls["n"] == 2
    assert await settle(store, JOB) == 0
    assert store.available(USER) == 70


@pytest.mark.asyncio
async def test_byok_job_has_no_reservation_to_settle():
    store = book(0)
    assert await settle(store, JOB) == 0
    assert store.available(USER) == 0
    await release(store, JOB)
    assert store.available(USER) == 0


@pytest.mark.asyncio
async def test_redis_reserve_records_usage_without_a_second_hold(monkeypatch):
    monkeypatch.setenv("QUEUE_BACKEND", "redis")
    seen = []

    class Usage:
        async def create_for_job(self, row, job_id):
            seen.append((row, job_id))

        async def lock_user(self, _user_id):
            raise AssertionError("redis reserve must not take a separate hold")

    gate = AIGate.__new__(AIGate)
    gate.usage = Usage()
    ai = ent.AiOptions(provider="OPENAI", model="openai/gpt-5.6-sol", credential_mode="MANAGED", effort="low")
    usage_id = await gate._reserve(USER, ai, "system", "user", JOB)
    assert usage_id is not None
    assert seen[0][1] == JOB
    assert seen[0][0].status == ent.USAGE_RESERVED


@pytest.mark.asyncio
async def test_pg_settle_and_release_round_trip():
    asyncpg = pytest.importorskip("asyncpg")
    name = f"push_credits_{os.getpid()}"
    try:
        maint = await asyncpg.connect(user="cyjoon", database="postgres", host="/tmp")
    except Exception as err:
        pytest.skip(f"local postgres unavailable: {err}")
    await maint.execute(f'DROP DATABASE IF EXISTS "{name}"')
    await maint.execute(f'CREATE DATABASE "{name}"')
    conn = await asyncpg.connect(user="cyjoon", database=name, host="/tmp")
    try:
        await conn.execute(
            "CREATE TABLE credit_reservations ("
            "job_id uuid PRIMARY KEY, user_id uuid NOT NULL, company_id uuid NULL, "
            "amount_micro bigint NOT NULL, status text NOT NULL, settled_micro bigint NULL, "
            "updated_at timestamptz NULL)")
        await conn.execute(
            "CREATE TABLE ai_usage ("
            "id uuid PRIMARY KEY, user_id uuid NULL, operation_id uuid NULL, "
            "provider text NULL, model text NULL, managed boolean NULL, "
            "input_tokens int NULL, output_tokens int NULL, "
            "cost_micro_credits bigint NOT NULL, status text NOT NULL, "
            "created_at timestamptz NULL, job_id uuid NULL)")
        await conn.execute(
            "INSERT INTO credit_reservations (job_id, user_id, amount_micro, status) "
            "VALUES ($1, $2, 80, 'RESERVED')", JOB, USER)
        await conn.execute(
            "INSERT INTO ai_usage (id, job_id, cost_micro_credits, status) "
            "VALUES ($1, $2, 30, 'SETTLED')", AGAIN, JOB)
        assert await settle_job(conn, JOB, NOW) == 50
        status = await conn.fetchrow("SELECT status, settled_micro FROM credit_reservations WHERE job_id=$1", JOB)
        assert status["status"] == "SETTLED"
        assert status["settled_micro"] == 30
        assert await settle_job(conn, JOB, NOW) == 0
        await conn.execute(
            "INSERT INTO credit_reservations (job_id, user_id, amount_micro, status) "
            "VALUES ($1, $2, 40, 'RESERVED')", AGAIN, USER)
        await release_job(conn, AGAIN, NOW + timedelta(seconds=1))
        released = await conn.fetchval("SELECT status FROM credit_reservations WHERE job_id=$1", AGAIN)
        assert released == "RELEASED"
        await conn.execute(
            _USAGE_JOB_SQL, USAGE, USER, None, "OPENAI", "m", True, 1, 2, 9,
            "RESERVED", NOW, JOB)
        await conn.execute(
            _USAGE_JOB_SQL, USAGE, USER, None, "OPENAI", "m", True, 1, 2, 9,
            "RESERVED", NOW, AGAIN)
        kept = await conn.fetchval("SELECT job_id FROM ai_usage WHERE id=$1", USAGE)
        assert kept == JOB
    finally:
        await conn.close()
        await maint.execute(f'DROP DATABASE IF EXISTS "{name}"')
        await maint.close()
