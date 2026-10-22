import pytest
from fakeredis.aioredis import FakeRedis

from app.jobs import get_job_scheduler, queue_backend, schedule_chat_job, set_job_scheduler
from app.workers.ai_worker_main import AI_WORKER_QUEUES
from app.workers.handlers.chat import approval_followup, chat, configure_chat
from tests.test_queue_worker import FIRST, MemoryJobs, queued, worker

NODES = ("resolve_context", "prepare_reply", "generate_reply", "persist")


def bind(db, run_node):
    async def cancelled(job_id):
        return bool(db.jobs[job_id].get("cancel_requested"))

    async def set_state(job_id, state):
        db.jobs[job_id]["conversation_state"] = state

    configure_chat(run_node=run_node, cancelled=cancelled, set_state=set_state)


async def drive(db, run_node, **kwargs):
    bind(db, run_node)
    redis = FakeRedis(decode_responses=True)
    box = worker(redis, db, {"chat": chat}, queues=list(AI_WORKER_QUEUES), **kwargs)
    db.jobs[FIRST] = queued(FIRST, conversation_id=FIRST)
    await box.queue.add("q:chat", FIRST)
    msg = (await box.queue.read("ai", "worker-a", ["q:chat"], 1, 0))[0]
    return await box.process(msg)


@pytest.mark.asyncio
async def test_chat_handler_writes_events_and_marks_done():
    db = MemoryJobs()
    seen = []

    async def run_node(ctx, name):
        seen.append(name)
        await ctx.emit("status", {"text": name})
        if name == "persist":
            return {"messageId": "msg-1"}
        return {}

    assert await drive(db, run_node) == "done"
    assert seen == list(NODES)
    assert db.jobs[FIRST]["status"] == "DONE"
    assert db.jobs[FIRST]["result"]["messageId"] == "msg-1"
    assert [kind for kind, _ in db.events[FIRST]] == ["status", "status", "status", "status"]
    assert AI_WORKER_QUEUES == ["q:chat:priority", "q:chat", "q:document"]


@pytest.mark.asyncio
async def test_interrupt_gate_leaves_job_done_with_needs_approval_state():
    db = MemoryJobs()
    seen = []

    async def run_node(ctx, name):
        seen.append(name)
        if name == "prepare_reply":
            return {"needs_approval": True, "messageId": "msg-2"}
        return {"messageId": "later"}

    assert await drive(db, run_node) == "done"
    assert seen == ["resolve_context", "prepare_reply"]
    assert db.jobs[FIRST]["status"] == "DONE"
    assert db.jobs[FIRST]["conversation_state"] == "NEEDS_APPROVAL"
    assert db.events[FIRST][-1] == ("status", {"state": "NEEDS_APPROVAL"})
    follow = approval_followup(db.jobs[FIRST])
    assert follow["id"] != FIRST
    assert follow["status"] == "QUEUED"
    assert follow["payload"]["approved"] is True
    assert follow["conversation_id"] == FIRST


@pytest.mark.asyncio
async def test_cancel_marks_cancelled_and_releases():
    db = MemoryJobs()
    released = []
    settled = []
    seen = []

    async def run_node(ctx, name):
        seen.append(name)
        if name == "prepare_reply":
            db.jobs[ctx.job["id"]]["cancel_requested"] = True
        await ctx.emit("status", {"text": name})
        return {"messageId": "msg-3"}

    async def release(_db, job_id):
        released.append(job_id)

    async def settle(_db, job_id):
        settled.append(job_id)

    assert await drive(db, run_node, release=release, settle=settle) == "cancelled"
    assert seen == ["resolve_context", "prepare_reply"]
    assert db.jobs[FIRST]["status"] == "CANCELLED"
    assert released == [FIRST]
    assert settled == []
    assert db.events[FIRST][-1][0] == "cancelled"


@pytest.mark.asyncio
async def test_redis_backend_does_not_schedule_workflow(monkeypatch):
    monkeypatch.setenv("QUEUE_BACKEND", "redis")
    seen = []

    async def sched(*args):
        seen.append(args)

    prev = get_job_scheduler()
    set_job_scheduler(sched)
    try:
        await schedule_chat_job("job-1", "byok")
        assert queue_backend() == "redis"
        assert seen == []
    finally:
        set_job_scheduler(prev)


@pytest.mark.asyncio
async def test_postgres_backend_still_schedules_workflow(monkeypatch):
    monkeypatch.delenv("QUEUE_BACKEND", raising=False)
    seen = []

    async def sched(*args):
        seen.append(args)

    prev = get_job_scheduler()
    set_job_scheduler(sched)
    try:
        await schedule_chat_job("job-1", "byok")
        assert seen
        assert seen[0][0] == "job-1"
    finally:
        set_job_scheduler(prev)
