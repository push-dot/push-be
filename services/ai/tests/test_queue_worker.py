import asyncio
from datetime import datetime, timedelta, timezone
from uuid import UUID

import pytest
from fakeredis.aioredis import FakeRedis

from app.queue.fairness import SLOT_STALE_S, try_slot
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
        self.events = {}

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
        if job["status"] != "RUNNING":
            return None
        job["attempts"] += 1
        job["error"] = error
        job["updated_at"] = now
        job["status"] = "DEAD" if job["attempts"] >= job["max_attempts"] else "RETRY"
        return {"status": job["status"], "attempts": job["attempts"], "max_attempts": job["max_attempts"], "queue": job["queue"]}

    async def fail_final(self, job_id, error, now):
        job = self.jobs[job_id]
        job["error"] = error
        job["updated_at"] = now
        job["status"] = "FAILED"

    async def release_claim(self, job_id, now):
        job = self.jobs[job_id]
        if job["status"] == "RUNNING":
            job["status"] = "QUEUED"
            job["updated_at"] = now

    async def touch(self, job_id, now):
        if self.jobs[job_id]["status"] == "RUNNING":
            self.jobs[job_id]["heartbeat_at"] = now

    async def emit(self, job_id, kind, payload):
        self.events.setdefault(job_id, []).append((kind, payload))

    async def cancel(self, job_id, now):
        job = self.jobs[job_id]
        if job["status"] in ("QUEUED", "RETRY", "RUNNING"):
            job["status"] = "CANCELLED"
            job["updated_at"] = now


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
    (msg,) = await box.next_messages()
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
    assert await redis.zcard(f"slots:user:{USER}") == 0


@pytest.mark.asyncio
async def test_paused_queue_is_not_read():
    redis = FakeRedis(decode_responses=True)
    queue = StreamQueue(redis)
    db = MemoryJobs()
    db.jobs[FIRST] = queued(FIRST, "q:chat:priority")
    db.jobs[SECOND] = queued(SECOND, "q:chat")
    await queue.add("q:chat:priority", FIRST)
    await queue.add("q:chat", SECOND)
    await queue.pause("q:chat:priority")
    box = worker(redis, db, {"chat": handler}, block_ms=0)
    assert [m.job_id for m in await box.next_messages()] == [SECOND]
    assert await box.next_messages() == []
    await queue.resume("q:chat:priority")
    assert [m.job_id for m in await box.next_messages()] == [FIRST]


@pytest.mark.asyncio
async def test_worker_writes_one_json_log_line_per_job(caplog):
    import json
    import logging
    redis = FakeRedis(decode_responses=True)
    db = MemoryJobs()
    db.jobs[FIRST] = queued(FIRST)

    async def logged(ctx):
        ctx.log.update({"docIds": ["d1"], "promptHash": "abc", "tokensIn": 5, "tokensOut": 7})
        return {"messageId": "m"}

    box = worker(redis, db, {"chat": logged})
    await box.queue.add("q:chat", FIRST)
    msg = (await box.queue.read("ai", "worker-a", ["q:chat"], 1, 0))[0]
    with caplog.at_level(logging.INFO, logger="app.queue.worker"):
        await box.process(msg)
    lines = [json.loads(r.message) for r in caplog.records if r.name == "app.queue.worker"]
    assert len(lines) == 1
    line = lines[0]
    assert line["jobId"] == str(FIRST)
    assert line["type"] == "chat"
    assert line["step"] == "done"
    assert line["docIds"] == ["d1"]
    assert line["promptHash"] == "abc"
    assert (line["tokensIn"], line["tokensOut"]) == (5, 7)
    assert isinstance(line["latencyMs"], int)


async def _read_one(box, job_id, queue="q:chat"):
    await box.queue.add(queue, job_id)
    return (await box.queue.read("ai", "worker-a", [queue], 1, 0))[0]


@pytest.mark.asyncio
async def test_loop_survives_a_transient_error(monkeypatch):
    redis = FakeRedis(decode_responses=True)
    db = MemoryJobs()
    db.jobs[FIRST] = queued(FIRST)
    box = worker(redis, db, {"chat": handler}, block_ms=10)
    await box.queue.add("q:chat", FIRST)
    real_claim, calls = db.claim, []

    async def flaky(job_id, now):
        calls.append(job_id)
        if len(calls) == 1:
            raise ConnectionError("neon reset")
        return await real_claim(job_id, now)

    db.claim = flaky
    real_next = box.next_messages

    async def yielding_next():
        await _REAL_SLEEP(0.001)  # fakeredis never blocks, so give the test a turn
        return await real_next()

    box.next_messages = yielding_next
    monkeypatch.setattr("app.queue.worker.asyncio.sleep", _no_sleep)
    box.min_idle_ms = 0  # the failed message is reclaimed on the next pass
    loop = asyncio.create_task(box._loop())
    for _ in range(50):
        if db.jobs[FIRST]["status"] == "DONE":
            break
        await _REAL_SLEEP(0.01)
    box.stop()
    await loop
    assert db.jobs[FIRST]["status"] == "DONE"


_REAL_SLEEP = asyncio.sleep


async def _no_sleep(_seconds):
    await _REAL_SLEEP(0)


@pytest.mark.asyncio
async def test_failure_after_job_left_running_is_not_retried():
    redis = FakeRedis(decode_responses=True)
    db = MemoryJobs()
    db.jobs[FIRST] = queued(FIRST)

    async def cancelled_meanwhile(ctx):
        db.jobs[FIRST]["status"] = "CANCELLED"  # admin cancel while the LLM call runs
        raise RuntimeError("provider 500")

    box = worker(redis, db, {"chat": cancelled_meanwhile})
    assert await box.process(await _read_one(box, FIRST)) == "lost"
    assert db.jobs[FIRST]["status"] == "CANCELLED"
    assert await redis.zcard("q:delayed") == 0
    assert await redis.xpending("q:chat", "ai") == {"pending": 0, "min": None, "max": None, "consumers": []}


@pytest.mark.asyncio
async def test_long_job_heartbeats_and_renews_conversation_lock():
    redis = FakeRedis(decode_responses=True)
    db = MemoryJobs()
    db.jobs[FIRST] = queued(FIRST, conversation_id=CONV)
    beats = []
    real_touch = db.touch

    async def touch(job_id, now):
        beats.append(await redis.ttl(f"lock:conversation:{CONV}"))
        await real_touch(job_id, now)

    db.touch = touch

    async def slow(ctx):
        await redis.expire(f"lock:conversation:{CONV}", 1)
        await asyncio.sleep(0.05)
        return {"messageId": "m"}

    box = worker(redis, db, {"chat": slow}, beat_s=0.01, lock_ttl=120)
    assert await box.process(await _read_one(box, FIRST)) == "done"
    assert beats, "no heartbeat while the handler ran"
    # The beat after the first renew sees the full TTL again.
    assert max(beats) > 1


@pytest.mark.asyncio
async def test_handler_past_its_deadline_is_failed_for_retry(monkeypatch):
    monkeypatch.setenv("JOB_DEADLINE_CHAT_S", "0")
    redis = FakeRedis(decode_responses=True)
    db = MemoryJobs()
    db.jobs[FIRST] = queued(FIRST)

    async def hangs(ctx):
        await asyncio.sleep(3600)

    box = worker(redis, db, {"chat": hangs})
    assert await box.process(await _read_one(box, FIRST)) == "failed"
    assert db.jobs[FIRST]["status"] == "RETRY"
    assert await redis.zcard("q:delayed") == 1


@pytest.mark.asyncio
async def test_slots_of_a_crashed_worker_age_out():
    redis = FakeRedis(decode_responses=True)
    scope = f"slots:user:{USER}"
    start = NOW.timestamp()
    assert await try_slot(redis, scope, 1, "crashed-job", start)
    assert not await try_slot(redis, scope, 1, "next-job", start + 1)
    assert await try_slot(redis, scope, 1, "next-job", start + SLOT_STALE_S + 1)
    assert await redis.ttl(scope) > 0


@pytest.mark.asyncio
async def test_shutdown_drains_then_hands_back_unfinished_job():
    redis = FakeRedis(decode_responses=True)
    db = MemoryJobs()
    db.jobs[FIRST] = queued(FIRST)
    started = asyncio.Event()

    async def forever(ctx):
        started.set()
        await asyncio.sleep(3600)

    box = worker(redis, db, {"chat": forever}, drain_s=0.05, block_ms=10)
    await box.queue.add("q:chat", FIRST)
    run = asyncio.create_task(box.run_forever())
    await started.wait()
    box.stop()
    await asyncio.wait_for(run, 2)
    assert db.jobs[FIRST]["status"] == "QUEUED"
    assert (await redis.xpending("q:chat", "ai"))["pending"] == 1
    assert await redis.zcard(f"slots:user:{USER}") == 0


@pytest.mark.asyncio
async def test_malformed_message_is_dead_lettered_not_fatal():
    redis = FakeRedis(decode_responses=True)
    db = MemoryJobs()
    db.jobs[FIRST] = queued(FIRST)
    box = worker(redis, db, {"chat": handler})
    await box.queue.read("ai", "worker-a", ["q:chat"], 1, 0)  # create the group
    await redis.xadd("q:chat", {"garbage": "1"})
    await box.queue.add("q:chat", FIRST)
    msgs = await box.queue.read("ai", "worker-a", ["q:chat"], 5, 0)
    assert [m.job_id for m in msgs] == [FIRST]
    assert await redis.xlen("q:dead") == 1
    assert (await redis.xpending("q:chat", "ai"))["pending"] == 1
