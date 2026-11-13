"""Deleting a thread erases the model's memory of it, on the tables the real checkpointer creates.

CI test-db sets RETENTION_PG_URL and installs the local extra (psycopg, langgraph-checkpoint-postgres).
The checkpointer's setup() commits its tables, so these tests clean up by deleting their user.
"""

import inspect
import os
import re
import uuid

import pytest

from app import account_purge
from app.queue.admin import AdminJobs

asyncpg = pytest.importorskip("asyncpg")
URL = os.environ.get("RETENTION_PG_URL", "")
pytestmark = pytest.mark.skipif(not URL, reason="RETENTION_PG_URL is not set")

# Every column a copy of a chat could sit in, on every table of the schema.
COLUMNS_SQL = (
    "SELECT c.table_name, c.column_name, c.data_type FROM information_schema.columns c "
    "JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name "
    "WHERE c.table_schema = current_schema() AND t.table_type = 'BASE TABLE' "
    "AND c.data_type IN ('text', 'character varying', 'character', 'json', 'jsonb', 'uuid', 'ARRAY', 'bytea')"
)


async def holders(conn, needle: str) -> list[str]:
    found = []
    for col in await conn.fetch(COLUMNS_SQL):
        name = f'"{col["table_name"]}"."{col["column_name"]}"'
        test = (f"position(convert_to($1, 'UTF8') in {name}) > 0" if col["data_type"] == "bytea"
                else f"position($1 in {name}::text) > 0")
        if await conn.fetchval(f'SELECT count(*) FROM "{col["table_name"]}" WHERE {test}', needle):
            found.append(f'{col["table_name"]}.{col["column_name"]}')
    return found


@pytest.fixture
async def saver():
    from app.db import open_chat_checkpointer

    saver, pool = await open_chat_checkpointer(URL)
    try:
        yield saver
    finally:
        await pool.close()


@pytest.fixture
async def conn():
    conn = await asyncpg.connect(URL)
    try:
        yield conn
    finally:
        await conn.close()


async def remember(saver, thread: str, phrase: str) -> None:
    """One turn of a graph that parks on a card, so the thread has checkpoints, blobs and pending writes."""
    from langchain_core.messages import AIMessage, HumanMessage
    from langgraph.graph import END, START, MessagesState, StateGraph
    from langgraph.types import interrupt

    def ask(state):
        interrupt({"awaiting": "approval"})
        return {}

    graph = StateGraph(MessagesState)
    graph.add_node("reply", lambda state: {"messages": [AIMessage(content="답: " + state["messages"][-1].content)]})
    graph.add_node("ask", ask)
    graph.add_edge(START, "reply")
    graph.add_edge("reply", "ask")
    graph.add_edge("ask", END)
    await graph.compile(checkpointer=saver).ainvoke(
        {"messages": [HumanMessage(content=phrase)]}, {"configurable": {"thread_id": thread}})


async def seed(conn) -> dict:
    ids = {name: uuid.uuid4() for name in ("user", "bot", "push", "thread", "push_thread", "web")}
    await conn.execute(
        "INSERT INTO users (id, provider, provider_subject, display_name) VALUES ($1, 'test', $2, 'erase')",
        ids["user"], str(ids["user"]))
    await conn.execute(
        "INSERT INTO bots (id, user_id, kind, company_name, display_name) VALUES "
        "($1, $3, 'company', '모아페이', '모아페이'), ($2, $3, 'push', '', 'Push Bot')",
        ids["bot"], ids["push"], ids["user"])
    await conn.execute(
        "INSERT INTO conversations (id, user_id, title, bot_id) VALUES "
        "($1, $4, 'bot', $2), ($3, $4, 'push', $5), ($6, $4, 'web', NULL)",
        ids["thread"], ids["bot"], ids["push_thread"], ids["user"], ids["push"], ids["web"])
    return ids


# The statement each delete path runs. The core ones are copied from services/core-api/src/routes.
DELETE_PATHS = {
    "bot delete": ("thread", lambda conn, ids: conn.execute(
        "DELETE FROM bots WHERE id = $1 AND user_id = $2 AND kind = 'company' RETURNING id", ids["bot"], ids["user"])),
    "Push Bot clear chat": ("push_thread", lambda conn, ids: conn.execute(
        "DELETE FROM conversations WHERE bot_id = $1 AND user_id = $2", ids["push"], ids["user"])),
    "web conversation delete": ("web", lambda conn, ids: conn.execute(
        "WITH owned AS (SELECT id FROM conversations WHERE id = $1 AND user_id = $2), "
        "dropped_jobs AS (DELETE FROM chat_jobs WHERE conversation_id IN (SELECT id FROM owned)), "
        "dropped_messages AS (DELETE FROM messages WHERE conversation_id IN (SELECT id FROM owned)) "
        "DELETE FROM conversations WHERE id IN (SELECT id FROM owned) RETURNING id", ids["web"], ids["user"])),
    "account purge": ("thread", lambda conn, ids: purge_account(conn, ids["user"])),
}


async def purge_account(conn, user) -> None:
    await conn.execute("UPDATE users SET deletion_requested_at = now() - interval '31 days' WHERE id = $1", user)
    await account_purge._purge(conn, account_purge.PURGE_SQL, "account")


@pytest.mark.parametrize("path", DELETE_PATHS)
async def test_after_a_delete_no_column_of_any_table_holds_the_threads_text_or_id(saver, conn, path):
    ids = await seed(conn)
    which, delete = DELETE_PATHS[path]
    thread = str(ids[which])
    phrase = f"erase-me {uuid.uuid4().hex} 김서준의 연봉은 6200만원"
    try:
        await conn.execute(
            "INSERT INTO messages (id, user_id, conversation_id, role, text) VALUES ($1, $2, $3, 'USER', $4)",
            uuid.uuid4(), ids["user"], ids[which], phrase)
        await remember(saver, thread, phrase)
        assert {"checkpoint_blobs.blob", "checkpoint_writes.blob"} <= set(await holders(conn, phrase))
        assert "checkpoints.thread_id" in await holders(conn, thread)

        await delete(conn, ids)

        assert await holders(conn, phrase) == []
        assert await holders(conn, thread) == []
        assert await saver.aget_tuple({"configurable": {"thread_id": thread}}) is None
    finally:
        await conn.execute("DELETE FROM users WHERE id = $1", ids["user"])


async def test_the_sweep_erases_a_thread_written_after_its_delete_and_keeps_live_ones(saver, conn):
    ids = await seed(conn)
    orphan = str(uuid.uuid4())
    try:
        await remember(saver, orphan, "a run that outlived its thread")
        await remember(saver, str(ids["thread"]), "a live thread")

        assert await AdminJobs(conn).sweep_orphan_checkpoints() >= 1

        assert await saver.aget_tuple({"configurable": {"thread_id": orphan}}) is None
        assert await saver.aget_tuple({"configurable": {"thread_id": str(ids["thread"])}}) is not None
    finally:
        await conn.execute("DELETE FROM users WHERE id = $1", ids["user"])


async def test_a_renamed_checkpoint_table_fails_the_sweep_and_the_delete_instead_of_leaving_text(saver, conn):
    ids = await seed(conn)
    try:
        for attempt in (
            lambda: AdminJobs(conn).sweep_orphan_checkpoints(),
            lambda: conn.execute("DELETE FROM conversations WHERE id = $1", ids["web"]),
        ):
            tx = conn.transaction()
            await tx.start()
            try:
                await conn.execute("ALTER TABLE checkpoint_writes RENAME TO checkpoint_writes_v2")
                with pytest.raises(asyncpg.UndefinedTableError):
                    await attempt()
            finally:
                await tx.rollback()
    finally:
        await conn.execute("DELETE FROM users WHERE id = $1", ids["user"])


async def test_the_erase_names_the_tables_langgraph_erases_a_thread_from(saver, conn):
    from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver

    deletes = re.compile(r"DELETE FROM (\w+)")
    langgraph = set(deletes.findall(inspect.getsource(AsyncPostgresSaver.adelete_thread)))
    ours = set(deletes.findall(await conn.fetchval("SELECT prosrc FROM pg_proc WHERE proname = 'erase_checkpoints'")))
    assert langgraph and ours == langgraph


async def test_a_database_without_the_checkpointer_tables_deletes_as_before(conn):
    tx = conn.transaction()
    await tx.start()
    try:
        await conn.execute("DROP TABLE IF EXISTS checkpoint_migrations")
        ids = await seed(conn)
        await conn.execute("DELETE FROM conversations WHERE id = $1", ids["web"])
        assert await AdminJobs(conn).sweep_orphan_checkpoints() == 0
    finally:
        await tx.rollback()
