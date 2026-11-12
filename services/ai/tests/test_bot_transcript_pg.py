"""GET /bots/{id}/transcript and the compaction of finished turns, on a migrated Postgres.

CI test-db sets BILLING_PG_URL; elsewhere these tests skip.
"""

import json
import os
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import httpx
import pytest
from fastapi import FastAPI

from app.api.errors import domain_error_handler
from app.api.routers.bots import router
from app.domain import entities as ent
from app.domain.errors import DomainError
from app.infrastructure.store_chat_jobs import assistant_message_id, user_message_id
from app.queue.admin import AdminJobs
from tests.test_bot_turn_pg import queued_turn, run_turn

asyncpg = pytest.importorskip("asyncpg")
URL = os.environ.get("BILLING_PG_URL", "")
pytestmark = pytest.mark.skipif(not URL, reason="BILLING_PG_URL is not set")

NOW = datetime.now(UTC)


@pytest.fixture
async def db():
    from app.db import DB, _init_conn

    pool = await asyncpg.create_pool(URL, init=_init_conn, min_size=0, max_size=2)
    try:
        yield DB(pool)
    finally:
        await pool.close()


def client(db, user: UUID) -> httpx.AsyncClient:
    app = FastAPI()
    app.add_exception_handler(DomainError, domain_error_handler)
    app.include_router(router, prefix="/api/v1")

    class AsUser:
        def __init__(self, inner):
            self.inner = inner

        async def __call__(self, scope, receive, send):
            if scope["type"] == "http":
                scope.setdefault("state", {})["user"] = ent.User(id=user, display_name="Ada", created_at=NOW)
            await self.inner(scope, receive, send)

    app.add_middleware(AsUser)
    app.state.db = db
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")


async def person(db) -> UUID:
    user = uuid4()
    await db.q().execute(
        "INSERT INTO users (id, provider, provider_subject, display_name) VALUES ($1, 'test', $2, 'transcript')",
        user, str(user))
    return user


async def bot_with_thread(db, user: UUID, kind: str = "company") -> tuple[UUID, UUID]:
    bot, thread = uuid4(), uuid4()
    await db.q().execute(
        "INSERT INTO bots (id, user_id, kind, company_name, display_name) VALUES ($1, $2, $3, $4, $5)",
        bot, user, kind, "" if kind == "push" else "모아페이", "Push Bot" if kind == "push" else "모아페이")
    await db.q().execute(
        "INSERT INTO conversations (id, user_id, title, bot_id) VALUES ($1, $2, 't', $3)", thread, user, bot)
    return bot, thread


async def turn(db, user, thread, status, at, rows, text=None, attachments=(), resume=None) -> UUID:
    job = uuid4()
    payload = {"text": text or "", **({"resume": resume} if resume else {})}
    await db.q().execute(
        "INSERT INTO ai_jobs (id, type, queue, user_id, status, max_attempts, payload, conversation_id, "
        "created_at, updated_at) VALUES ($1, 'chat', 'q:chat', $2, $3, 3, $4::jsonb, $5, $6, $6)",
        job, user, status, payload, thread, at)
    for kind, body in rows:
        await db.q().execute(
            "INSERT INTO chat_events (job_id, type, payload, created_at) VALUES ($1, $2, $3::jsonb, $4)",
            job, kind, body, at)
    if text:
        await db.q().execute(
            "INSERT INTO messages (id, user_id, conversation_id, role, text, attachments, created_at) "
            "VALUES ($1, $2, $3, 'USER', $4, $5::jsonb, $6)",
            user_message_id(job), user, thread, text, list(attachments), at)
    return job


def reply(job, user, thread, text, at):
    return ("INSERT INTO messages (id, user_id, conversation_id, role, text, created_at) "
            "VALUES ($1, $2, $3, 'ASSISTANT', $4, $5)", assistant_message_id(job), user, thread, text, at)


ANSWERED = [
    ("status", {"text": "대기 중", "phase": "queued", "since": "x", "ahead": 0}),
    ("status", {"text": "생각 중", "phase": "thinking", "since": "x"}),
    ("token", {"text": "공고를 "}),
    ("status", {"text": "생각 중", "phase": "thinking", "since": "x"}),
    ("token", {"text": "볼게요"}),
    ("tool", {"name": "read_posting", "state": "ok", "summary": "공고 읽기", "tier": "READ"}),
    ("token", {"text": "다 읽었어요"}),
    ("done", {"operation": None}),
]


async def test_pages_newest_turn_first_and_each_turn_carries_its_messages(db):
    user = await person(db)
    try:
        bot, thread = await bot_with_thread(db, user)
        file = {"kind": "file", "id": str(uuid4()), "title": "김서준_이력서.pdf"}
        old = await turn(db, user, thread, "DONE", NOW - timedelta(hours=2), ANSWERED, "이력서 봐 줘", [file])
        await db.q().execute(*reply(old, user, thread, "공고를 볼게요다 읽었어요", NOW - timedelta(hours=2)))
        middle = await turn(db, user, thread, "DONE", NOW - timedelta(hours=1), ANSWERED, "고마워")
        newest = await turn(db, user, thread, "RUNNING", NOW, ANSWERED[:5], "하나 더")
        http = client(db, user)

        first = (await http.get(f"/api/v1/bots/{bot}/transcript?limit=2")).json()
        second = (await http.get(f"/api/v1/bots/{bot}/transcript?limit=2&cursor={first['page']['nextCursor']}")).json()

        assert [t["id"] for t in first["data"]] == [str(newest), str(middle)]
        assert first["page"]["hasMore"] is True
        assert [t["id"] for t in second["data"]] == [str(old)]
        assert second["page"] == {"nextCursor": None, "hasMore": False} and second["live"] is None
        done = second["data"][0]
        assert done["user"]["attachments"] == [file]
        assert done["assistant"]["text"] == "공고를 볼게요다 읽었어요" and done["assistant"]["sources"] == []
        assert [(e["type"], e.get("text")) for e in done["events"]] == [
            ("token", "공고를 볼게요"), ("tool", None), ("token", "다 읽었어요")]
        assert first["data"][1]["assistant"] is None
    finally:
        await db.q().execute("DELETE FROM users WHERE id = $1", user)


async def test_a_running_turn_replays_its_status_and_names_the_seq_to_reattach_after(db):
    user = await person(db)
    try:
        bot, thread = await bot_with_thread(db, user, "push")
        job = await turn(db, user, thread, "RUNNING", NOW, ANSWERED[:5], "하나 더")
        last = await db.q().fetchval("SELECT max(id) FROM chat_events WHERE job_id = $1", job)

        body = (await client(db, user).get("/api/v1/bots/push/transcript")).json()

        (running,) = body["data"]
        assert running["status"] == "RUNNING" and running["assistant"] is None
        assert [e["type"] for e in running["events"]] == ["status", "status", "status", "token"]
        assert body["live"] == {"turnId": str(job), "lastSeq": last}
        assert running["events"][-1]["seq"] == last
    finally:
        await db.q().execute("DELETE FROM users WHERE id = $1", user)


async def test_a_turn_the_real_runtime_wrote_reads_back_without_the_thread_id(db):
    attachments = [{"kind": "posting", "id": str(uuid4()), "title": "모아페이 · Backend"}]
    queued = await queued_turn(db, attachments)
    try:
        await run_turn(db, queued)
        bot = await db.q().fetchval("SELECT bot_id FROM conversations WHERE id = $1", queued.thread)
        stored = await db.q().fetchval("SELECT text FROM messages WHERE id = $1", assistant_message_id(queued.job))

        response = await client(db, queued.user).get(f"/api/v1/bots/{bot}/transcript")

        (only,) = response.json()["data"]
        assert only["user"]["attachments"] == attachments
        assert only["assistant"]["text"] == stored
        assert "done" not in [e["type"] for e in only["events"]]
        assert str(queued.thread) not in response.text
    finally:
        await db.q().execute("DELETE FROM users WHERE id = $1", queued.user)


async def test_an_unknown_bot_is_404_and_a_bot_without_a_thread_has_no_turns(db):
    user, other = await person(db), await person(db)
    try:
        bot, _ = await bot_with_thread(db, other)
        http = client(db, user)

        assert (await http.get(f"/api/v1/bots/{uuid4()}/transcript")).status_code == 404
        assert (await http.get(f"/api/v1/bots/{bot}/transcript")).status_code == 404
        assert (await http.get("/api/v1/bots/push/transcript")).json() == {
            "data": [], "page": {"nextCursor": None, "hasMore": False}, "live": None}
    finally:
        await db.q().execute("DELETE FROM users WHERE id = ANY($1::uuid[])", [user, other])


async def test_compaction_keeps_what_a_reopened_chat_shows_and_runs_once(db):
    user = await person(db)
    try:
        bot, thread = await bot_with_thread(db, user)
        web = uuid4()
        await db.q().execute("INSERT INTO conversations (id, user_id, title) VALUES ($1, $2, 'web')", web, user)
        tokens = [("status", {"text": "생각 중", "phase": "thinking", "since": "x"})]
        for i in range(200):
            tokens += [("token", {"text": f"{i},"}), ("status", {"text": "생각 중", "phase": "thinking", "since": "x"})]
        finished = await turn(db, user, thread, "DONE", NOW - timedelta(minutes=11), tokens + [("done", {})], "길게")
        fresh = await turn(db, user, thread, "DONE", NOW - timedelta(minutes=1), ANSWERED, "방금")
        web_job = await turn(db, user, web, "DONE", NOW - timedelta(minutes=11), ANSWERED, "웹")
        http = client(db, user)
        before = (await http.get(f"/api/v1/bots/{bot}/transcript")).json()
        count = "SELECT count(*) FROM chat_events WHERE job_id = $1 AND type = $2"
        rows = "SELECT id, type, payload::text FROM chat_events WHERE job_id = $1 ORDER BY id"

        async with db.pool.acquire() as conn:
            await AdminJobs(conn).compact_finished(NOW)
            once = await db.q().fetch(rows, finished)
            await AdminJobs(conn).compact_finished(NOW)

        assert await db.q().fetch(rows, finished) == once
        assert (await http.get(f"/api/v1/bots/{bot}/transcript")).json() == before
        assert await db.q().fetchval(count, finished, "token") == 1
        assert await db.q().fetchval(count, finished, "status") == 0
        text = await db.q().fetchval(
            "SELECT payload->>'text' FROM chat_events WHERE job_id = $1 AND type = 'token'", finished)
        assert text == "".join(f"{i}," for i in range(200))
        assert await db.q().fetchval(count, fresh, "status") == 3
        assert await db.q().fetchval(count, web_job, "status") == 3
    finally:
        await db.q().execute("DELETE FROM users WHERE id = $1", user)
