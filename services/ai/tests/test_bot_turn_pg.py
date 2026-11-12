"""A turn of a bot thread, run by the real runtime on a migrated Postgres.

Core stores a message's attachments when it queues the turn. The AI service fills in the same row
when the turn ends, so only the real store shows whether they survive. CI test-db sets
BILLING_PG_URL; elsewhere these tests skip.
"""

import json
import os
from types import SimpleNamespace
from uuid import uuid4

import pytest
from langgraph.checkpoint.memory import MemorySaver

from app.domain.services.conversation import ConversationService
from app.harness.jobs import run_queue_turn
from app.infrastructure.store_chat_jobs import assistant_message_id, user_message_id
from tests.harness_fakes import Gate

asyncpg = pytest.importorskip("asyncpg")
URL = os.environ.get("BILLING_PG_URL", "")
pytestmark = pytest.mark.skipif(not URL, reason="BILLING_PG_URL is not set")


@pytest.fixture
async def db():
    from app.db import DB, _init_conn

    pool = await asyncpg.create_pool(URL, init=_init_conn, min_size=0, max_size=2)
    try:
        yield DB(pool)
    finally:
        await pool.close()


async def queued_turn(db, attachments: list) -> SimpleNamespace:
    """A bot thread with one turn as core leaves it: a claimed job and the USER row."""
    user, bot, thread, job = uuid4(), uuid4(), uuid4(), uuid4()
    q = db.q()
    await q.execute(
        "INSERT INTO users (id, provider, provider_subject, display_name) "
        "VALUES ($1, 'test', $2, 'bot turn')",
        user,
        str(user),
    )
    await q.execute(
        "INSERT INTO bots (id, user_id, kind, company_name, display_name) "
        "VALUES ($1, $2, 'push', '', 'Push Bot')",
        bot,
        user,
    )
    await q.execute(
        "INSERT INTO conversations (id, user_id, title, bot_id) VALUES ($1, $2, 'Push Bot', $3)",
        thread,
        user,
        bot,
    )
    await q.execute(
        "INSERT INTO ai_jobs "
        "(id, type, queue, user_id, plan, status, max_attempts, payload, conversation_id) "
        "VALUES ($1, 'chat', 'q:chat', $2, 'PRO', 'RUNNING', 3, $3::jsonb, $4)",
        job,
        user,
        {"text": "이 이력서 봐 줘", "ai": None, "access_mode": "AUTO", "context": {}},
        thread,
    )
    await q.execute(
        "INSERT INTO messages (id, user_id, conversation_id, role, text, attachments, created_at) "
        "VALUES ($1, $2, $3, 'USER', '이 이력서 봐 줘', $4::jsonb, now() - interval '5 seconds')",
        user_message_id(job),
        user,
        thread,
        attachments,
    )
    return SimpleNamespace(user=user, thread=thread, job=job)


async def run_turn(db, turn) -> None:
    svc = ConversationService(db, Gate(), checkpointer=MemorySaver())
    job = dict(
        await db.q().fetchrow(
            "SELECT id, user_id, conversation_id, payload FROM ai_jobs WHERE id = $1", turn.job
        )
    )
    if isinstance(job["payload"], str):
        job["payload"] = json.loads(job["payload"])

    async def emit(kind, payload):
        await svc.jobs.emit(turn.job, kind, payload)

    async def cancelled(job_id):
        return False

    await run_queue_turn(svc, SimpleNamespace(job=job, emit=emit), cancelled)


async def user_row(db, turn) -> dict:
    row = await db.q().fetchrow(
        "SELECT text, attachments::text AS attachments, created_at, operation_id "
        "FROM messages WHERE id = $1",
        user_message_id(turn.job),
    )
    return dict(row)


async def test_the_attachments_core_stored_are_there_after_the_turn(db):
    attachments = [
        {"kind": "file", "id": str(uuid4()), "title": "김서준_이력서.pdf"},
        {"kind": "posting", "id": str(uuid4()), "title": "모아페이 · Backend"},
    ]
    turn = await queued_turn(db, attachments)
    try:
        before = await user_row(db, turn)

        await run_turn(db, turn)

        after = await user_row(db, turn)
        assert json.loads(after["attachments"]) == attachments
        assert (after["text"], after["created_at"]) == (before["text"], before["created_at"])
        assert before["operation_id"] is None and after["operation_id"] is not None
        reply = await db.q().fetchval(
            "SELECT operation_id FROM messages WHERE id = $1", assistant_message_id(turn.job)
        )
        assert reply == after["operation_id"]
    finally:
        await db.q().execute("DELETE FROM users WHERE id = $1", turn.user)


async def test_no_event_and_no_operation_of_the_turn_names_its_thread(db):
    turn = await queued_turn(db, [])
    try:
        await run_turn(db, turn)

        events = await db.q().fetch(
            "SELECT type, payload::text AS payload FROM chat_events WHERE job_id = $1 ORDER BY id",
            turn.job,
        )
        assert [event["type"] for event in events][-1] == "done"
        done = json.loads(events[-1]["payload"])
        assert done["operation"]["result"]["value"] == {
            "assistantMessageId": str(assistant_message_id(turn.job)),
            "userMessageId": str(user_message_id(turn.job)),
            "approvalIds": [],
        }
        operation = await db.q().fetchval(
            "SELECT o::text FROM operations o WHERE o.id = $1", done["operation"]["id"]
        )
        stored = [event["payload"] for event in events] + [operation]
        assert not [text for text in stored if str(turn.thread) in text]
    finally:
        await db.q().execute("DELETE FROM users WHERE id = $1", turn.user)
