"""Only current members reach a company conversation, on a migrated Postgres.

CI test-db sets BILLING_PG_URL; elsewhere these tests skip.
"""

import os
from uuid import uuid4

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
