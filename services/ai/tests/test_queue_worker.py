import asyncio
from datetime import datetime, timedelta, timezone
from uuid import UUID

import pytest
from fakeredis.aioredis import FakeRedis

from app.queue.fairness import release_slot, try_slot
from app.queue.ratelimit import acquire_token
from app.queue.streams import StreamQueue
from app.queue.worker import JobContext, Worker

NOW = datetime(2026, 10, 22, 12, 0, tzinfo=timezone.utc)
FIRST = UUID("11111111-1111-4111-8111-111111111111")
SECOND = UUID("22222222-2222-4222-8222-222222222222")
USER = UUID("33333333-3333-4333-8333-333333333333")
CONV = UUID("44444444-4444-4444-8444-444444444444")


class MemoryJobs:
    def __init__(self):
        self.jobs = {}

    async def claim(self, job_id, now):
        job = self.jobs[job_id]
        if job["status"] not in ("QUEUED", "RETRY"):
            return None
        job["status"] = "RUNNING"
        job["heartbeat_at"] = now
        return dict(job)

    async def finish(self, job_id, result, now):
        job = self.jobs[job_id]
        job["status"] = "DONE"
        job["result"] = result
        job["updated_at"] = now

    async def fail(self, job_id, error, now):
        job = self.jobs[job_id]
        job["attempts"] += 1
        job["error"] = error
        job["updated_at"] = now
        job["status"] = "DEAD" if job["attempts"] >= job["max_attempts"] else "RETRY"
        return {"status": job["status"], "attempts": job["attempts"], "max_attempts": job["max_attempts"], "queue": job["queue"]}

    async def release_claim(self, job_id, now):
        job = self.jobs[job_id]
        if job["status"] == "RUNNING":
            job["status"] = "QUEUED"
            job["updated_at"] = now

    async def touch(self, job_id, now):
        self.jobs[job_id]["heartbeat_at"] = now


def queued(id_, queue="q:chat", conversation_id=None, user_id=USER):
    return {
        "id": id_,
        "type": "chat",
        "queue": queue,
        "status": "QUEUED",
        "user_id": user_id,
        "company_id": None,
        "conversation_id": conversation_id,
        "attempts": 0,
        "max_attempts": 4,
        "payload": {},
        "heartbeat_at": None,
    }


def worker(redis, db, handlers, queues=None, **kwargs):
    return Worker(
        StreamQueue(redis),
        db,
        "ai",
        "worker-a",
        queues or ["q:chat:priority", "q:chat", "q:document"],
        handlers,
        1,
        now=lambda: NOW,
        **kwargs,
    )


async def handler(ctx: JobContext):
    return {"messageId": str(ctx.job["id"])}


@pytest.mark.asyncio
async def test_reclaim_after_heartbeat_timeout():
    redis = FakeRedis(decode_responses=True)
    queue = StreamQueue(redis)
    db = MemoryJobs()
    db.jobs[FIRST] = queued(FIRST)
    await queue.add("q:chat", FIRST)
    await queue.read("ai", "dead-worker", ["q:chat"], 1, 0)
    box = worker(redis, db, {"chat": handler})
    reclaimed = await box.reclaim(min_idle_ms=0)
    assert reclaimed == 1
    assert db.jobs[FIRST]["status"] == "DONE"


@pytest.mark.asyncio
async def test_duplicate_message_does_not_run_when_job_is_not_claimable():
    redis = FakeRedis(decode_responses=True)
    db = MemoryJobs()
    db.jobs[FIRST] = queued(FIRST)
    calls = []

    async def once(ctx):
        calls.append(ctx.job["id"])
        return {"messageId": "m"}

    box = worker(redis, db, {"chat": once})
    await queue_add_and_read(redis, box, FIRST)
    await box.process((await StreamQueue(redis).read("ai", "worker-a", ["q:chat"], 1, 0))[0])
    assert calls == [FIRST]
    assert db.jobs[FIRST]["status"] == "DONE"
    again = await StreamQueue(redis).add("q:chat", FIRST)
    from app.queue.streams import Message
    await box.process(Message("q:chat", again, FIRST))
    assert calls == [FIRST]
    assert db.jobs[FIRST]["status"] == "DONE"


async def queue_add_and_read(redis, box, job_id):
    await box.queue.add("q:chat", job_id)


@pytest.mark.asyncio
async def test_priority_queue_read_first():
    redis = FakeRedis(decode_responses=True)
    queue = StreamQueue(redis)
    db = MemoryJobs()
    db.jobs[FIRST] = queued(FIRST, "q:chat")
    db.jobs[SECOND] = queued(SECOND, "q:chat:priority")
    await queue.add("q:chat", FIRST)
    await queue.add("q:chat:priority", SECOND)
    box = worker(redis, db, {"chat": handler})
    msg = await box.next_message()
    assert msg is not None
    assert msg.queue == "q:chat:priority"
    assert msg.job_id == SECOND


@pytest.mark.asyncio
async def test_conversation_lock_blocks_second_job():
    redis = FakeRedis(decode_responses=True)
    db = MemoryJobs()
    db.jobs[FIRST] = queued(FIRST, conversation_id=CONV)
    db.jobs[SECOND] = queued(SECOND, conversation_id=CONV)
    started = asyncio.Event()
    release = asyncio.Event()
    calls = []

    async def slow(ctx):
        calls.append(ctx.job["id"])
        if ctx.job["id"] == FIRST:
            started.set()
            await release.wait()
        return {"messageId": "m"}

    box = worker(redis, db, {"chat": slow})
    queue = box.queue
    await queue.add("q:chat", FIRST)
    await queue.add("q:chat", SECOND)
    first, second = await queue.read("ai", "worker-a", ["q:chat"], 2, 0)
    task = asyncio.create_task(box.process(first))
    await started.wait()
    await box.process(second)
    assert calls == [FIRST]
    assert db.jobs[SECOND]["status"] == "QUEUED"
    delayed = await redis.zrange("q:delayed", 0, -1)
    assert str(SECOND) in delayed[0]
    release.set()
    await task
    assert db.jobs[FIRST]["status"] == "DONE"


@pytest.mark.asyncio
async def test_rate_limit_waits_instead_of_failing(monkeypatch):
    redis = FakeRedis(decode_responses=True)
    clock = {"now": 0.0}
    slept = []

    async def fake_sleep(seconds):
        slept.append(seconds)
        clock["now"] += seconds

    monkeypatch.setattr("app.queue.ratelimit.sleep", fake_sleep)
    monkeypatch.setattr("app.queue.ratelimit.monotonic", lambda: clock["now"])
    await acquire_token(redis, "rate:test", 1, 1)
    await acquire_token(redis, "rate:test", 1, 1)
    assert slept
    assert slept[0] > 0


@pytest.mark.asyncio
async def test_user_slot_limit_requeues_with_delay():
    redis = FakeRedis(decode_responses=True)
    db = MemoryJobs()
    db.jobs[FIRST] = queued(FIRST, user_id=USER)
    db.jobs[SECOND] = queued(SECOND, user_id=USER)
    started = asyncio.Event()
    release = asyncio.Event()

    async def slow(ctx):
        if ctx.job["id"] == FIRST:
            started.set()
            await release.wait()
        return {"messageId": "m"}

    box = worker(redis, db, {"chat": slow}, user_slots=1)
    queue = box.queue
    await queue.add("q:chat", FIRST)
    await queue.add("q:chat", SECOND)
    first, second = await queue.read("ai", "worker-a", ["q:chat"], 2, 0)
    task = asyncio.create_task(box.process(first))
    await started.wait()
    await box.process(second)
    assert db.jobs[SECOND]["status"] == "QUEUED"
    assert db.jobs[SECOND]["attempts"] == 0
    delayed = await redis.zrange("q:delayed", 0, -1, withscores=True)
    assert str(SECOND) in delayed[0][0]
    assert delayed[0][1] == pytest.approx((NOW + timedelta(seconds=30)).timestamp())
    release.set()
    await task
    assert db.jobs[FIRST]["status"] == "DONE"
    assert await try_slot(redis, f"slot:user:{USER}", 1) is True
    await release_slot(redis, f"slot:user:{USER}")
