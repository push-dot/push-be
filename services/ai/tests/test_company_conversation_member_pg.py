"""Only current members reach a company conversation, on a migrated Postgres.

CI test-db sets BILLING_PG_URL; elsewhere these tests skip.
"""

import os
from uuid import UUID, uuid4

import pytest

from app.db import NotFoundError
from app.domain.pagination import PageRequest
from app.infrastructure.store_conversations import ConversationStore

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


async def _user(db):
    user = uuid4()
    await db.q().execute(
        "INSERT INTO users (id, provider, provider_subject, display_name) "
        "VALUES ($1, 'test', $2, 'a')",
        user, str(user))
    return user


async def test_the_author_who_left_no_longer_reaches_the_company_conversation(db):
    author, teammate = await _user(db), await _user(db)
    company, conversation = uuid4(), uuid4()
    await db.q().execute("INSERT INTO companies (id, name) VALUES ($1, '모아페이')", company)
    for user in (author, teammate):
        await db.q().execute(
            "INSERT INTO company_members (company_id, user_id, role) VALUES ($1, $2, 'MEMBER')",
            company, user)
    await db.q().execute(
        "INSERT INTO conversations (id, user_id, title, company_id) VALUES ($1, $2, '채용', $3)",
        conversation, author, company)
    await db.q().execute(
        "INSERT INTO messages (id, user_id, conversation_id, role, text) "
        "VALUES ($1, $2, $3, 'USER', '연봉은 공개하지 않아요')",
        uuid4(), author, conversation)
    store = ConversationStore(db)
    try:
        assert (await store.get(author, conversation)).id == conversation
        assert len((await store.list_messages(author, conversation, PageRequest())).items) == 1

        await db.q().execute(
            "DELETE FROM company_members WHERE company_id = $1 AND user_id = $2", company, author)
        with pytest.raises(NotFoundError):
            await store.get(author, conversation)
        assert (await store.list_messages(author, conversation, PageRequest())).items == []
        assert (await store.get(teammate, conversation)).id == conversation
    finally:
        await db.q().execute("DELETE FROM conversations WHERE id = $1", conversation)
        await db.q().execute("DELETE FROM companies WHERE id = $1", company)


async def test_a_company_share_link_dies_when_its_author_leaves_and_members_can_turn_it_off(db):
    from datetime import UTC, datetime, timedelta

    author, teammate, outsider, rival = (
        await _user(db), await _user(db), await _user(db), await _user(db))
    company, other_company, conversation = uuid4(), uuid4(), uuid4()
    await db.q().execute("INSERT INTO companies (id, name) VALUES ($1, '모아페이')", company)
    await db.q().execute("INSERT INTO companies (id, name) VALUES ($1, '다른회사')", other_company)
    for user, owner in ((author, company), (teammate, company), (rival, other_company)):
        await db.q().execute(
            "INSERT INTO company_members (company_id, user_id, role) VALUES ($1, $2, 'MEMBER')",
            owner, user)
    await db.q().execute(
        "INSERT INTO conversations (id, user_id, title, company_id) VALUES ($1, $2, '채용', $3)",
        conversation, author, company)
    store = ConversationStore(db)
    now = datetime.now(UTC)
    try:
        await store.put_share(conversation, "hash-1", now, now + timedelta(days=30))
        assert (await store.share_by_hash("hash-1", now))["conversation_id"] == conversation

        # DELETE /share is allowed to whoever store.get lets in.
        assert (await store.get(teammate, conversation)).id == conversation
        for stranger in (outsider, rival):
            with pytest.raises(NotFoundError):
                await store.get(stranger, conversation)

        await db.q().execute(
            "DELETE FROM company_members WHERE company_id = $1 AND user_id = $2", company, author)
        assert await store.share_by_hash("hash-1", now) is None, "the link dies with the author"
    finally:
        await db.q().execute("DELETE FROM conversations WHERE id = $1", conversation)
        await db.q().execute("DELETE FROM companies WHERE id = ANY($1::uuid[])",
                             [company, other_company])


async def test_a_tool_card_is_stored_as_an_object_core_can_match(db):
    from pydantic import BaseModel

    from app.harness.approval import create_tool_approval
    from app.harness.policy import Tier
    from app.harness.tools import ToolSpec

    class CloseArgs(BaseModel):
        posting_id: str

    async def _run(_ctx, _args):
        return {}

    tool = ToolSpec("close_posting", Tier.RISKY_WRITE, CloseArgs, _run,
                    lambda _a: "공고를 마감해요")
    user, conversation, job = await _user(db), uuid4(), uuid4()
    await db.q().execute(
        "INSERT INTO conversations (id, user_id, title) VALUES ($1, $2, '마감')",
        conversation, user)
    try:
        event, _created = await create_tool_approval(
            db, user_id=user, conversation_id=conversation, job_id=job, tool=tool,
            args=CloseArgs(posting_id="p-1"), tool_call_id="call-1")
        row = await db.q().fetchrow(
            "SELECT jsonb_typeof(tool_args) AS t, "
            "tool_args @> '{\"posting_id\": \"p-1\"}'::jsonb AS ok "
            "FROM approvals WHERE id = $1", UUID(event["id"]))
        assert row["t"] == "object" and row["ok"], "core's tool_args @> check matches"
    finally:
        await db.q().execute("DELETE FROM conversations WHERE id = $1", conversation)
