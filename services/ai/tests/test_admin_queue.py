import json
import os
from datetime import datetime, timedelta, timezone
from uuid import uuid4

import httpx
import pytest
from fakeredis.aioredis import FakeRedis
from fastapi.testclient import TestClient

from app.queue.alerts import Alerts, redis_conditions
from app.queue.dispatcher import Dispatcher, kick_app
from app.queue.streams import StreamQueue

NOW = datetime(2026, 10, 22, 12, 0, tzinfo=timezone.utc)


class FakeAdminDb:
    def __init__(self):
        self.retried = []
        self.cancelled = []
        self.closed = 0

    async def close(self):
        self.closed += 1

    async def dead_jobs(self, status, limit):
        return [{"id": "j1", "type": "chat", "status": status, "error": {"message": "boom"},
                 "attempts": 4, "updatedAt": "2026-10-22T11:00:00Z"}]

    async def retry(self, job_id, now):
        self.retried.append(job_id)
        return True

    async def cancel(self, job_id, now):
        self.cancelled.append(job_id)
        return True

    async def type_stats(self, now):
        return {"chat": {"waitP50": 1.0, "waitP95": 2.0, "runP50": 3.0, "runP95": 4.0, "failRate": 0.0, "dead": 0}}

    async def neon_stats(self):
        return {"dbSizeBytes": 10, "ragNodes": 2}

    async def pending_outbox(self):
        return []

    async def running_jobs(self):
        return []

    async def pending_jobs(self, now):
        return []


def client(redis, db=None, token="admin-secret"):
    db = db or FakeAdminDb()

    async def open_db():
        return db

    dispatcher = Dispatcher(StreamQueue(redis), open_db, "kick", admin_token=token, now=lambda: NOW)
    return TestClient(kick_app(dispatcher)), db


def test_admin_requires_token():
    http, _ = client(FakeRedis(decode_responses=True))
    assert http.get("/admin/queue/stats").status_code == 401
    assert http.get("/admin/queue/stats", headers={"authorization": "Bearer wrong"}).status_code == 401
    unset, _ = client(FakeRedis(decode_responses=True), token="")
    assert unset.get("/admin/queue/stats", headers={"authorization": "Bearer "}).status_code == 401
    ok = http.get("/admin/jobs?status=DEAD", headers={"authorization": "Bearer admin-secret"})
    assert ok.status_code == 200
    assert ok.json()["data"][0]["status"] == "DEAD"


def test_stats_reports_oldest_age():
    redis = FakeRedis(decode_responses=True)
    http, _ = client(redis)
    two_minutes_ago = int((NOW - timedelta(seconds=150)).timestamp() * 1000)
    import asyncio

    async def seed():
        await redis.xadd("q:chat", {"jobId": str(uuid4())}, id=f"{two_minutes_ago}-0")
        await redis.xadd("q:chat", {"jobId": str(uuid4())}, id=f"{two_minutes_ago + 1000}-0")

    asyncio.run(seed())
    body = http.get("/admin/queue/stats", headers={"authorization": "Bearer admin-secret"}).json()["data"]
    assert body["streams"]["q:chat"] == {"length": 2, "oldestAgeSec": 150, "pending": 0}
    assert body["streams"]["q:notify"] == {"length": 0, "oldestAgeSec": 0, "pending": 0}
    assert body["types"]["chat"]["runP95"] == 4.0
    assert body["neon"] == {"dbSizeBytes": 10, "ragNodes": 2}


def test_pause_resume_and_cancel_endpoints():
    redis = FakeRedis(decode_responses=True)
    http, db = client(redis)
    auth = {"authorization": "Bearer admin-secret"}
    assert http.post("/admin/queues/q:chat/pause", headers=auth).status_code == 200
    import asyncio
    assert asyncio.run(StreamQueue(redis).paused("q:chat")) is True
    assert http.post("/admin/queues/q:chat/resume", headers=auth).status_code == 200
    assert asyncio.run(StreamQueue(redis).paused("q:chat")) is False
    assert http.post("/admin/queues/q:nope/pause", headers=auth).status_code == 404
    job_id = str(uuid4())
    assert http.post(f"/admin/jobs/{job_id}/cancel", headers=auth).status_code == 200
    assert [str(j) for j in db.cancelled] == [job_id]


class Sent:
    def __init__(self, discord_ok=True):
        self.discord = []
        self.email = []
        self.discord_ok = discord_ok

    def transport(self):
        def handler(request):
            if "discord" in str(request.url):
                self.discord.append(json.loads(request.content))
                return httpx.Response(204 if self.discord_ok else 500)
            self.email.append(json.loads(request.content))
            return httpx.Response(200, json={"id": "e"})
        return httpx.MockTransport(handler)


def alerts(sent, client_):
    return Alerts(client_, discord_url="https://discord.example/api/webhooks/x",
                  resend_key="re_test", email_from="alerts@push.example", email_to="ops@push.example")


@pytest.mark.asyncio
async def test_alert_debounces_30_minutes_and_sends_recovery():
    sent = Sent()
    async with httpx.AsyncClient(transport=sent.transport()) as http:
        box = alerts(sent, http)
        firing = {"queue_wait": (True, "q:chat 180s")}
        await box.evaluate(firing, NOW)
        await box.evaluate(firing, NOW + timedelta(minutes=10))
        await box.evaluate(firing, NOW + timedelta(minutes=29))
        assert len(sent.discord) == 1
        await box.evaluate(firing, NOW + timedelta(minutes=31))
        assert len(sent.discord) == 2
        await box.evaluate({"queue_wait": (False, "q:chat 0s")}, NOW + timedelta(minutes=32))
        await box.evaluate({"queue_wait": (False, "q:chat 0s")}, NOW + timedelta(minutes=33))
    assert len(sent.discord) == 3
    assert sent.discord[0]["embeds"][0]["title"].startswith("[경보]")
    assert sent.discord[2]["embeds"][0]["title"].startswith("[복구]")
    assert sent.email == []


@pytest.mark.asyncio
async def test_alert_falls_back_to_email_when_discord_fails():
    sent = Sent(discord_ok=False)
    async with httpx.AsyncClient(transport=sent.transport()) as http:
        await alerts(sent, http).evaluate({"dead_recent": (True, "3 dead in 10 min")}, NOW)
    assert len(sent.discord) == 1
    assert len(sent.email) == 1
    assert sent.email[0]["to"] == ["ops@push.example"]
    assert "dead_recent" in sent.email[0]["subject"]


@pytest.mark.asyncio
async def test_redis_conditions_flag_wait_dead_and_stalled():
    redis = FakeRedis(decode_responses=True)
    queue = StreamQueue(redis)
    old = int((NOW - timedelta(seconds=300)).timestamp() * 1000)
    await redis.xadd("q:chat", {"jobId": str(uuid4())}, id=f"{old}-0")
    await redis.xadd("q:dead", {"jobId": str(uuid4()), "reason": "x"},
                     id=f"{int((NOW - timedelta(minutes=5)).timestamp() * 1000)}-0")
    found = await redis_conditions(queue, NOW)
    assert found["queue_wait"][0] is True
    assert found["dead_recent"][0] is True
    calm = await redis_conditions(StreamQueue(FakeRedis(decode_responses=True)), NOW)
    assert all(firing is False for firing, _ in calm.values())


@pytest.mark.asyncio
async def test_retry_dead_job_requeues_and_reserves_again():
    url = os.environ.get("RAG_PG_URL")
    if not url:
        pytest.skip("RAG_PG_URL not set")
    asyncpg = pytest.importorskip("asyncpg")
    from app.queue.admin import AdminJobs

    conn = await asyncpg.connect(url)
    user, job = uuid4(), uuid4()
    try:
        await conn.execute(
            "INSERT INTO users (id, provider, provider_subject, display_name) VALUES ($1, 'email', $2, 'a')",
            user, str(user))
        await conn.execute(
            "INSERT INTO ai_jobs (id, type, queue, user_id, status, attempts, max_attempts, payload, error) "
            "VALUES ($1, 'fit', 'q:document', $2, 'DEAD', 3, 3, '{}', '{\"message\": \"boom\"}')", job, user)
        await conn.execute(
            "INSERT INTO credit_reservations (job_id, user_id, amount_micro, status) VALUES ($1, $2, 500, 'RELEASED')",
            job, user)
        admin = AdminJobs(conn)
        assert await admin.retry(job, NOW) is True
        row = await conn.fetchrow("SELECT status, attempts, error FROM ai_jobs WHERE id = $1", job)
        assert (row["status"], row["attempts"], row["error"]) == ("QUEUED", 0, None)
        assert await conn.fetchval("SELECT status FROM credit_reservations WHERE job_id = $1", job) == "RESERVED"
        assert await conn.fetchval("SELECT count(*) FROM outbox WHERE job_id = $1 AND dispatched_at IS NULL", job) == 1
        assert await admin.retry(job, NOW) is False
        assert await admin.cancel(job, NOW) is True
        assert await conn.fetchval("SELECT status FROM credit_reservations WHERE job_id = $1", job) == "RELEASED"
        dead = await admin.dead_jobs("CANCELLED", 10)
        assert [d["id"] for d in dead] == [str(job)]
    finally:
        await conn.execute("DELETE FROM users WHERE id = $1", user)
        await conn.close()


@pytest.mark.asyncio
async def test_retention_deletes_only_finished_rows_older_than_30_days():
    url = os.environ.get("RAG_PG_URL")
    if not url:
        pytest.skip("RAG_PG_URL not set")
    asyncpg = pytest.importorskip("asyncpg")
    from app.queue.admin import AdminJobs

    conn = await asyncpg.connect(url)
    user = uuid4()
    old = NOW - timedelta(days=31)
    fresh = NOW - timedelta(days=29)
    rows = {
        "old_done": ("DONE", old), "old_dead": ("DEAD", old), "old_running": ("RUNNING", old),
        "old_queued": ("QUEUED", old), "fresh_done": ("DONE", fresh),
    }
    ids = {name: uuid4() for name in rows}
    try:
        await conn.execute(
            "INSERT INTO users (id, provider, provider_subject, display_name) VALUES ($1, 'email', $2, 'a')",
            user, str(user))
        for name, (status, at) in rows.items():
            await conn.execute(
                "INSERT INTO ai_jobs (id, type, queue, user_id, status, max_attempts, payload, created_at, updated_at) "
                "VALUES ($1, 'chat', 'q:chat', $2, $3, 3, '{}', $4, $4)", ids[name], user, status, at)
            await conn.execute("INSERT INTO outbox (job_id, queue, created_at, dispatched_at) VALUES ($1, 'q:chat', $2, $2)", ids[name], at)
            await conn.execute("INSERT INTO chat_events (job_id, type, payload) VALUES ($1, 'status', '{}')", ids[name])
        await conn.execute(
            "INSERT INTO ai_usage (id, user_id, provider, model, managed, input_tokens, output_tokens, status, job_id, created_at) "
            "VALUES ($1, $2, 'OPENAI', 'm', true, 1, 1, 'SETTLED', $3, $4)", uuid4(), user, ids["old_done"], old)
        deleted = await AdminJobs(conn).purge_finished(NOW)
        left = {r["id"] for r in await conn.fetch("SELECT id FROM ai_jobs WHERE user_id = $1", user)}
        assert deleted == 2
        assert left == {ids["old_running"], ids["old_queued"], ids["fresh_done"]}
        assert await conn.fetchval("SELECT count(*) FROM chat_events WHERE job_id = ANY($1::uuid[])", [ids["old_done"], ids["old_dead"]]) == 0
        assert await conn.fetchval("SELECT count(*) FROM ai_usage WHERE user_id = $1 AND job_id IS NULL", user) == 1
    finally:
        await conn.execute("DELETE FROM users WHERE id = $1", user)
        await conn.close()


async def test_maintenance_sweep_expires_old_approval_cards():
    class Conn:
        def __init__(self):
            self.sql = []

        async def execute(self, sql, *args):
            self.sql.append((sql, args))
            return "UPDATE 1"

    from app.queue.admin import AdminJobs
    conn = Conn()
    await AdminJobs(conn).expire_approvals(NOW)
    sql, args = conn.sql[0]
    assert "SET status = 'EXPIRED'" in sql and "status = 'PENDING'" in sql and "expires_at < $1" in sql
    assert args == (NOW,)

    db = FakeAdminDb()
    expired = []

    async def expire(now):
        expired.append(now)

    async def purge(now):
        return 0

    db.expire_approvals = expire
    db.purge_finished = purge

    async def open_db():
        return db

    dispatcher = Dispatcher(StreamQueue(FakeRedis(decode_responses=True)), open_db, "kick", now=lambda: NOW)
    await dispatcher.run_once(NOW)
    assert expired == []
    await dispatcher.run_once(NOW, maintain=True)
    assert expired == [NOW]
