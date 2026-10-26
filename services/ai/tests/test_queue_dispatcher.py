from datetime import datetime, timedelta, timezone
from uuid import UUID

import pytest
from fakeredis.aioredis import FakeRedis
from fastapi.testclient import TestClient

from app.queue.backoff import backoff_seconds
from app.queue.config import heartbeat_limits, visibility_limits
from app.queue.dispatcher import Dispatcher, kick_app
from app.queue.streams import StreamQueue

NOW = datetime(2026, 10, 22, 12, 0, tzinfo=timezone.utc)
CHAT = UUID("11111111-1111-4111-8111-111111111111")
DOC = UUID("22222222-2222-4222-8222-222222222222")
SECRET = "dispatch-test-secret"


class MemoryDB:
    def __init__(self, holder, jobs, outbox):
        self.holder = holder
        self.jobs = jobs
        self.outbox = outbox
        holder["live"] += 1

    async def close(self):
        self.holder["live"] -= 1

    async def pending_outbox(self):
        return [row for row in self.outbox if row["dispatched_at"] is None]

    async def mark_dispatched(self, ids, at):
        for row in self.outbox:
            if row["id"] in ids:
                row["dispatched_at"] = at

    async def running_jobs(self):
        return [job for job in self.jobs if job["status"] == "RUNNING"]

    async def mark_retry(self, ids, now):
        out = []
        for job in self.jobs:
            if job["id"] in set(ids) and job["status"] == "RUNNING":
                job["attempts"] += 1
                job["status"] = "DEAD" if job["attempts"] >= job["max_attempts"] else "RETRY"
                job["run_after"] = now
                job["updated_at"] = now
                out.append({"id": job["id"], "queue": job["queue"], "status": job["status"]})
        return out

    async def pending_jobs(self, now):
        return [
            job for job in self.jobs
            if job["status"] in ("QUEUED", "RETRY") and job["run_after"] <= now
        ]

    async def reconcile_credits(self, now):
        return 0

    async def purge_finished(self, now):
        return 0

    async def expire_approvals(self, now):
        return None

    async def neon_stats(self):
        return {"dbSizeBytes": 0, "ragNodes": 0}


def opener(holder, jobs, outbox):
    async def open_db():
        holder["opened"] += 1
        return MemoryDB(holder, jobs, outbox)

    return open_db


def dispatcher(redis, jobs=None, outbox=None, holder=None):
    state = holder if holder is not None else {"live": 0, "opened": 0}
    return Dispatcher(StreamQueue(redis), opener(state, jobs or [], outbox or []), SECRET), state


def job(id_, type_, queue, status, heartbeat_at=None, run_after=None, updated_at=None,
        attempts=0, max_attempts=4):
    return {
        "attempts": attempts,
        "max_attempts": max_attempts,
        "id": id_,
        "type": type_,
        "queue": queue,
        "status": status,
        "heartbeat_at": heartbeat_at,
        "run_after": NOW if run_after is None else run_after,
        "updated_at": updated_at,
    }


async def stream_job_ids(redis, queue):
    rows = await redis.xrange(queue)
    return [fields["jobId"] for _, fields in rows]


def test_backoff_sequence():
    assert backoff_seconds(1) == 30
    assert backoff_seconds(2) == 120
    assert backoff_seconds(3) == 600
    assert backoff_seconds(4) == 3600
    assert backoff_seconds(9) == 3600


@pytest.mark.asyncio
async def test_dispatch_moves_outbox_rows_to_streams():
    redis = FakeRedis(decode_responses=True)
    outbox = [{"id": 1, "job_id": CHAT, "queue": "q:chat", "dispatched_at": None}]
    box, _ = dispatcher(redis, outbox=outbox)
    await box.run_once(NOW)
    assert await stream_job_ids(redis, "q:chat") == [str(CHAT)]
    assert outbox[0]["dispatched_at"] == NOW


@pytest.mark.asyncio
async def test_promote_due_moves_delayed_jobs():
    redis = FakeRedis(decode_responses=True)
    queue = StreamQueue(redis)
    await queue.delay("q:chat", CHAT, NOW - timedelta(seconds=1))
    await queue.delay("q:document", DOC, NOW + timedelta(hours=1))
    moved = await queue.promote_due(NOW)
    assert moved == 1
    assert await stream_job_ids(redis, "q:chat") == [str(CHAT)]
    assert await stream_job_ids(redis, "q:document") == []
    assert await redis.zcard("q:delayed") == 1


@pytest.mark.asyncio
async def test_rehydrate_from_jobs_after_redis_flush():
    redis = FakeRedis(decode_responses=True)
    old = NOW - timedelta(seconds=visibility_limits()["q:chat"] + 1)
    jobs = [job(CHAT, "chat", "q:chat", "QUEUED", updated_at=old)]
    box, _ = dispatcher(redis, jobs=jobs)
    await box.run_once(NOW)
    assert await stream_job_ids(redis, "q:chat") == [str(CHAT)]
    await redis.delete("q:chat")
    await box.run_once(NOW)
    assert await stream_job_ids(redis, "q:chat") == [str(CHAT)]


@pytest.mark.asyncio
async def test_rehydrate_lost_job_when_stream_is_not_empty():
    redis = FakeRedis(decode_responses=True)
    queue = StreamQueue(redis)
    held = UUID("33333333-3333-4333-8333-333333333333")
    fresh = UUID("44444444-4444-4444-8444-444444444444")
    old = NOW - timedelta(seconds=visibility_limits()["q:chat"] + 5)
    await queue.add("q:chat", DOC)
    await queue.delay("q:chat", held, NOW + timedelta(hours=1))
    jobs = [
        job(CHAT, "chat", "q:chat", "QUEUED", updated_at=old),
        job(fresh, "chat", "q:chat", "QUEUED", updated_at=NOW),
        job(DOC, "chat", "q:chat", "QUEUED", updated_at=old),
        job(held, "chat", "q:chat", "RETRY", updated_at=old),
    ]
    box, _ = dispatcher(redis, jobs=jobs)
    await box.run_once(NOW)
    assert await stream_job_ids(redis, "q:chat") == [str(DOC), str(CHAT)]
    await box.run_once(NOW)
    assert await stream_job_ids(redis, "q:chat") == [str(DOC), str(CHAT)]
    assert await redis.zcard("q:delayed") == 1


@pytest.mark.asyncio
async def test_heartbeat_limit_reads_env_override(monkeypatch):
    monkeypatch.setenv("HEARTBEAT_LIMIT_CHAT_S", "30")
    redis = FakeRedis(decode_responses=True)
    jobs = [job(CHAT, "chat", "q:chat", "RUNNING", NOW - timedelta(seconds=31))]
    box, _ = dispatcher(redis, jobs=jobs)
    await box.run_once(NOW)
    assert jobs[0]["status"] == "RETRY"


@pytest.mark.asyncio
async def test_stale_running_job_returns_to_retry():
    redis = FakeRedis(decode_responses=True)
    jobs = [
        job(CHAT, "chat", "q:chat", "RUNNING", NOW - timedelta(seconds=heartbeat_limits()["chat"] + 1)),
        job(DOC, "document", "q:document", "RUNNING", NOW - timedelta(seconds=heartbeat_limits()["document"] - 1)),
    ]
    box, _ = dispatcher(redis, jobs=jobs)
    await box.run_once(NOW)
    assert jobs[0]["status"] == "RETRY"
    assert jobs[1]["status"] == "RUNNING"


@pytest.mark.asyncio
async def test_no_db_connection_held_between_runs():
    redis = FakeRedis(decode_responses=True)
    holder = {"live": 0, "opened": 0}
    box, _ = dispatcher(redis, holder=holder)
    await box.run_once(NOW)
    assert holder["live"] == 0
    await box.run_once(NOW)
    assert holder["live"] == 0
    assert holder["opened"] == 2


def test_kick_triggers_immediate_dispatch():
    redis = FakeRedis(decode_responses=True)
    outbox = [{"id": 7, "job_id": CHAT, "queue": "q:chat", "dispatched_at": None}]
    box, holder = dispatcher(redis, outbox=outbox)
    client = TestClient(kick_app(box))
    res = client.post("/internal/kick", json={"queue": "q:chat"}, headers={"x-push-dispatch-secret": SECRET})
    assert res.status_code == 200
    assert outbox[0]["dispatched_at"] is not None
    assert holder["live"] == 0


def test_kick_rejects_without_secret():
    redis = FakeRedis(decode_responses=True)
    outbox = [{"id": 7, "job_id": CHAT, "queue": "q:chat", "dispatched_at": None}]
    box, holder = dispatcher(redis, outbox=outbox)
    client = TestClient(kick_app(box))
    missing = client.post("/internal/kick", json={"queue": "q:chat"})
    wrong = client.post("/internal/kick", json={"queue": "q:chat"}, headers={"x-push-dispatch-secret": "nope"})
    assert missing.status_code == 401
    assert wrong.status_code == 401
    assert outbox[0]["dispatched_at"] is None
    assert holder["opened"] == 0


@pytest.mark.asyncio
async def test_stale_job_is_requeued_even_after_its_message_was_acked():
    # A reclaimer that saw RUNNING acks the dead worker's message; the job must not strand.
    redis = FakeRedis(decode_responses=True)
    queue = StreamQueue(redis)
    await queue.add("q:chat", CHAT)
    (msg,) = await queue.read("ai", "dead-worker", ["q:chat"], 1, 0)
    await queue.ack("q:chat", "ai", msg.id)
    stale = NOW - timedelta(seconds=heartbeat_limits()["chat"] + 1)
    jobs = [job(CHAT, "chat", "q:chat", "RUNNING", stale, updated_at=stale)]
    box, _ = dispatcher(redis, jobs=jobs)
    stats = await box.run_once(NOW)
    assert stats.requeued == 1
    assert jobs[0]["status"] == "RETRY"
    assert jobs[0]["attempts"] == 1
    (again,) = await queue.read("ai", "worker-b", ["q:chat"], 1, 0)
    assert again.job_id == CHAT


@pytest.mark.asyncio
async def test_job_that_keeps_losing_its_worker_goes_dead():
    redis = FakeRedis(decode_responses=True)
    stale = NOW - timedelta(seconds=heartbeat_limits()["chat"] + 1)
    jobs = [job(CHAT, "chat", "q:chat", "RUNNING", stale, attempts=3, max_attempts=4)]
    box, _ = dispatcher(redis, jobs=jobs)
    await box.run_once(NOW)
    assert jobs[0]["status"] == "DEAD"
    assert await stream_job_ids(redis, "q:dead") == [str(CHAT)]
    assert await stream_job_ids(redis, "q:chat") == []


@pytest.mark.asyncio
async def test_rehydrate_ignores_acked_history():
    redis = FakeRedis(decode_responses=True)
    queue = StreamQueue(redis)
    await queue.add("q:chat", CHAT)
    (msg,) = await queue.read("ai", "w", ["q:chat"], 1, 0)
    await queue.ack("q:chat", "ai", msg.id)
    old = NOW - timedelta(seconds=visibility_limits()["q:chat"] + 1)
    jobs = [job(CHAT, "chat", "q:chat", "RETRY", updated_at=old)]
    box, _ = dispatcher(redis, jobs=jobs)
    assert (await box.run_once(NOW)).rehydrated == 1


@pytest.mark.asyncio
async def test_concurrent_promoters_add_each_due_job_once():
    import asyncio
    redis = FakeRedis(decode_responses=True)
    queue = StreamQueue(redis)
    await queue.delay("q:chat", CHAT, NOW - timedelta(seconds=1))
    moved = await asyncio.gather(queue.promote_due(NOW), StreamQueue(redis).promote_due(NOW))
    assert sorted(moved) == [0, 1]
    assert await stream_job_ids(redis, "q:chat") == [str(CHAT)]


@pytest.mark.asyncio
async def test_maintenance_pass_reconciles_credits():
    redis = FakeRedis(decode_responses=True)
    seen = []

    class Recording(MemoryDB):
        async def reconcile_credits(self, now):
            seen.append(now)
            return 2

    holder = {"live": 0, "opened": 0}

    async def open_db():
        return Recording(holder, [], [])

    box = Dispatcher(StreamQueue(redis), open_db, SECRET)
    await box.run_once(NOW, maintain=True)
    assert seen == [NOW]
