from uuid import UUID

import httpx
import pytest
from fakeredis.aioredis import FakeRedis

from app.queue.streams import StreamQueue
from app.workers.handlers.notify import EXPO_PUSH, expo_push, make_notify
from tests.test_queue_worker import FIRST, SECOND, USER, MemoryJobs, queued, worker

NOTE = UUID("55555555-5555-4555-8555-555555555555")


class NotifyQuery:
    def __init__(self):
        self.rows = {}

    async def fetchval(self, sql, *args):
        if args[0] in self.rows:
            return None
        self.rows[args[0]] = args
        return args[0]

    async def fetch(self, sql, *args):
        return [{"token": "ExponentPushToken[abc]"}]


def notify_job(id_):
    job = queued(id_, "q:notify")
    job["type"] = "notify"
    job["payload"] = {
        "notificationId": str(NOTE), "userId": str(USER), "kind": "OFFER",
        "title": "새 제안", "body": "hi", "target": {"kind": "offer", "id": "x"},
        "createdAt": "2026-10-22T00:00:00.000Z",
    }
    return job


@pytest.mark.asyncio
async def test_notify_handler_is_idempotent_per_notification():
    redis = FakeRedis(decode_responses=True)
    db = MemoryJobs()
    db.jobs[FIRST] = notify_job(FIRST)
    db.jobs[SECOND] = notify_job(SECOND)
    pushed = []

    async def push(messages):
        pushed.append(messages)
        return len(messages)

    query = NotifyQuery()
    box = worker(redis, db, {"notify": make_notify(lambda: query, push)}, queues=["q:notify"])
    queue = StreamQueue(redis)
    for job_id in (FIRST, SECOND):
        await queue.add("q:notify", job_id)
        msg = (await queue.read("ai", "worker-a", ["q:notify"], 1, 0))[0]
        assert await box.process(msg) == "done"
    assert list(query.rows) == [NOTE]
    assert pushed == [[{"to": "ExponentPushToken[abc]", "title": "새 제안", "body": "hi", "data": {"kind": "offer", "id": "x"}}]]
    assert db.jobs[FIRST]["result"] == {"notificationId": str(NOTE), "pushed": 1}
    assert db.jobs[SECOND]["result"] == {"notificationId": str(NOTE), "pushed": 0}


@pytest.mark.asyncio
async def test_expo_push_is_skipped_without_token_and_sends_bearer_with_one():
    seen = []

    def handler(request):
        seen.append(request)
        return httpx.Response(200, json={})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        assert await expo_push("", client)([{"to": "t"}]) == 0
        assert await expo_push("expo-secret", client)([{"to": "t"}]) == 1
    assert len(seen) == 1
    assert str(seen[0].url) == EXPO_PUSH
    assert seen[0].headers["authorization"] == "Bearer expo-secret"
