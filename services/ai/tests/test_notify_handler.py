import json
from uuid import UUID

import httpx
import pytest
from fakeredis.aioredis import FakeRedis

from app.queue.streams import StreamQueue
from app.workers.handlers.notify import (
    EXPO_PUSH,
    EXPO_RECEIPTS,
    RECEIPT_AFTER,
    RECEIPT_KEEP,
    RECEIPTS_KEY,
    check_receipts,
    expo_push,
    make_notify,
)
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


@pytest.mark.asyncio
async def test_notify_reads_tokens_only_for_users_not_being_deleted():
    seen = []

    class Query(NotifyQuery):
        async def fetch(self, sql, *args):
            seen.append(sql)
            return []

    pushed = []

    async def push(messages):
        pushed.append(messages)
        return len(messages)

    handler = make_notify(lambda: Query(), push)
    result = await handler(type("Ctx", (), {"job": notify_job(FIRST)})())
    assert "u.deletion_requested_at IS NULL" in seen[0]
    assert pushed == [] and result["pushed"] == 0


@pytest.mark.asyncio
async def test_expo_push_prunes_tokens_expo_says_are_gone():
    def handler(_request):
        return httpx.Response(200, json={"data": [
            {"status": "ok", "id": "t1"},
            {"status": "error", "message": "gone", "details": {"error": "DeviceNotRegistered"}},
            {"status": "error", "message": "slow", "details": {"error": "MessageRateExceeded"}},
        ]})

    pruned = []

    async def prune(tokens):
        pruned.extend(tokens)

    messages = [{"to": "a"}, {"to": "b"}, {"to": "c"}]
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        assert await expo_push("expo-secret", client, prune)(messages) == 1
    assert pruned == ["b"]


@pytest.mark.asyncio
async def test_expo_push_counts_nothing_when_expo_rejects_the_request():
    transport = httpx.MockTransport(lambda _r: httpx.Response(401, json={}))
    async with httpx.AsyncClient(transport=transport) as client:
        assert await expo_push("bad", client)([{"to": "a"}]) == 0


@pytest.mark.asyncio
async def test_expo_push_saves_ok_tickets_for_the_receipt_check():
    def handler(_request):
        return httpx.Response(200, json={"data": [
            {"status": "ok", "id": "r1"},
            {"status": "error", "details": {"error": "DeviceNotRegistered"}},
        ]})

    saved = []

    async def remember(pairs):
        saved.extend(pairs)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        await expo_push("expo-secret", client, None, remember)([{"to": "a"}, {"to": "b"}])
    assert saved == [("r1", "a")]


@pytest.mark.asyncio
async def test_check_receipts_prunes_a_token_gone_after_the_ticket():
    redis = FakeRedis(decode_responses=True)
    sent = 1_000_000.0
    await redis.zadd(RECEIPTS_KEY, {"r1|a": sent, "r2|b": sent, "r3|c": sent + RECEIPT_AFTER, "old|d": sent - RECEIPT_KEEP})
    seen = []

    def handler(request):
        seen.append(request)
        return httpx.Response(200, json={"data": {
            "r1": {"status": "ok"},
            "r2": {"status": "error", "details": {"error": "DeviceNotRegistered"}},
        }})

    pruned = []

    async def prune(tokens):
        pruned.extend(tokens)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        assert await check_receipts("expo-secret", client, redis, prune, now=sent + RECEIPT_AFTER) == 1
    assert pruned == ["b"]
    assert str(seen[0].url) == EXPO_RECEIPTS
    assert sorted(json.loads(seen[0].content)["ids"]) == ["r1", "r2"]
    assert await redis.zrange(RECEIPTS_KEY, 0, -1) == ["r3|c"]


@pytest.mark.asyncio
async def test_check_receipts_keeps_tickets_when_expo_fails():
    redis = FakeRedis(decode_responses=True)
    await redis.zadd(RECEIPTS_KEY, {"r1|a": 0})

    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda _r: httpx.Response(503))) as client:
        assert await check_receipts("expo-secret", client, redis, lambda _t: None, now=RECEIPT_AFTER) == 0
    assert await redis.zrange(RECEIPTS_KEY, 0, -1) == ["r1|a"]
