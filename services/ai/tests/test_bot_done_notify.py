from uuid import UUID

import httpx
import pytest
from fakeredis.aioredis import FakeRedis

from app.harness.core_client import CoreClient
from app.queue.streams import StreamQueue
from app.queue.worker import JobCancelled, JobFailed
from app.workers.handlers.notify import make_notify
from tests.test_queue_worker import CONV, FIRST, USER, MemoryJobs, queued, worker

NOTE = UUID("55555555-5555-4555-8555-555555555555")
JOB = UUID("66666666-6666-4666-8666-666666666666")


class Core:
    def __init__(self, error=None):
        self.calls = []
        self.error = error

    async def call(self, method, path, *, user_id, json=None, **kwargs):
        self.calls.append((method, path, user_id, json))
        if self.error is not None:
            raise self.error
        return {"id": "n"}


def chat(result):
    async def handle(_ctx):
        return result
    return handle


async def run(handler, *, job_type="chat", core=None, conversation_id=CONV):
    redis = FakeRedis(decode_responses=True)
    db = MemoryJobs()
    job = queued(FIRST, conversation_id=conversation_id)
    job["type"] = job_type
    db.jobs[FIRST] = job
    box = worker(redis, db, {job_type: handler}, core=core)
    queue = StreamQueue(redis)
    await queue.add("q:chat", FIRST)
    msg = (await queue.read("ai", "worker-a", ["q:chat"], 1, 0))[0]
    outcome = await box.process(msg)
    return outcome, db, core


@pytest.mark.asyncio
async def test_finished_turn_posts_ai_done_with_the_job():
    core = Core()
    outcome, db, _ = await run(chat({"operationId": "op-1"}), core=core)
    assert outcome == "done"
    assert db.jobs[FIRST]["status"] == "DONE"
    assert core.calls == [(
        "POST",
        "/api/v1/internal/notifications/ai-done",
        str(USER),
        {"userId": str(USER), "conversationId": str(CONV), "jobId": str(FIRST)},
    )]


@pytest.mark.asyncio
async def test_card_cancel_and_failure_send_nothing():
    core = Core()
    outcome, _, _ = await run(chat({}), core=core)
    assert outcome == "done"
    assert core.calls == []

    async def cancel(_ctx):
        raise JobCancelled()

    outcome, _, core = await run(cancel, core=Core())
    assert outcome == "cancelled"
    assert core.calls == []

    async def fail(_ctx):
        raise JobFailed({"message": "no"})

    outcome, _, core = await run(fail, core=Core())
    assert outcome == "failed"
    assert core.calls == []


@pytest.mark.asyncio
async def test_notify_error_does_not_fail_the_job():
    core = Core(error=RuntimeError("core down"))
    outcome, db, _ = await run(chat({"operationId": "op-1"}), core=core)
    assert outcome == "done"
    assert db.jobs[FIRST]["status"] == "DONE"


@pytest.mark.asyncio
async def test_notify_job_is_not_a_turn():
    core = Core()
    outcome, _, _ = await run(chat({"operationId": "op-1"}), job_type="notify", core=core)
    assert outcome == "done"
    assert core.calls == []


@pytest.mark.asyncio
async def test_job_token_is_the_bearer_on_the_ai_done_call():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["authorization"] = request.headers.get("authorization")
        seen["path"] = request.url.path
        seen["body"] = request.read()
        return httpx.Response(201, json={"data": {"id": "n"}})

    client = CoreClient(
        "https://core.example", "sek", job_token="job-secret", transport=httpx.MockTransport(handler))
    out = await client.call(
        "POST",
        "/api/v1/internal/notifications/ai-done",
        user_id=str(USER),
        json={"userId": str(USER), "conversationId": str(CONV), "jobId": str(JOB)},
    )
    assert out == {"id": "n"}
    assert seen["authorization"] == "Bearer job-secret"
    assert seen["path"] == "/api/v1/internal/notifications/ai-done"
    assert b"job-secret" not in seen["body"]


class NotifyQuery:
    def __init__(self, error=None):
        self.args = None
        self.error = error

    async def fetchval(self, sql, *args):
        self.args = (sql, args)
        if self.error is not None:
            raise self.error
        return args[0]

    async def fetch(self, sql, *args):
        return [{"token": "ExponentPushToken[abc]"}]


@pytest.mark.asyncio
async def test_notify_stores_the_preview_and_pushes_the_fixed_sentence():
    pushed = []

    async def push(messages):
        pushed.extend(messages)
        return len(messages)

    query = NotifyQuery()
    preview = "급여 명세는 비밀"
    payload = {
        "notificationId": str(NOTE), "userId": str(USER), "kind": "AI_DONE",
        "title": "봇 작업 완료", "body": preview,
        "pushBody": "Push Bot이 작업을 마쳤어요",
        "target": {"kind": "bot", "id": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"},
        "createdAt": "2026-10-22T00:00:00.000Z",
        "conversationId": str(CONV),
    }
    ctx = type("Ctx", (), {"job": {"payload": payload}})()
    result = await make_notify(lambda: query, push)(ctx)
    sql, args = query.args
    assert "conversation_id" in sql
    assert args[0] == NOTE
    assert preview in args
    assert CONV in args
    assert pushed == [{
        "to": "ExponentPushToken[abc]",
        "title": "봇 작업 완료",
        "body": "Push Bot이 작업을 마쳤어요",
        "data": payload["target"],
    }]
    assert preview not in pushed[0]["body"]
    assert result["pushed"] == 1


class Gone(Exception):
    sqlstate = "23503"


@pytest.mark.asyncio
async def test_notify_drops_the_push_when_the_thread_is_gone():
    pushed = []

    async def push(messages):
        pushed.extend(messages)
        return len(messages)

    query = NotifyQuery(error=Gone("fk"))
    payload = {
        "notificationId": str(NOTE), "userId": str(USER), "kind": "AI_DONE",
        "title": "봇 작업 완료", "body": "x", "pushBody": "봇이 작업을 마쳤어요",
        "target": {"kind": "bot", "id": "b"}, "createdAt": "2026-10-22T00:00:00.000Z",
        "conversationId": str(CONV),
    }
    ctx = type("Ctx", (), {"job": {"payload": payload}})()
    result = await make_notify(lambda: query, push)(ctx)
    assert result == {"notificationId": str(NOTE), "pushed": 0}
    assert pushed == []
