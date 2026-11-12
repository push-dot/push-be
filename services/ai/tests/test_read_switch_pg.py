"""내 자료 읽기 허용, on a migrated Postgres, with every statement of the turn recorded.

CI test-db sets BILLING_PG_URL. Elsewhere the Postgres cases skip.
"""

import os
import re
import types
import typing
from types import SimpleNamespace
from uuid import UUID, uuid4

import httpx
import pytest

from app.domain.employer_chat import PERSONAL_INTENTS
from app.harness.material_access import (
    READ_SWITCH_OFF,
    REFUSED,
    MaterialAccess,
    current_access,
)
from app.harness.personal.resume.tools import RESUME_TOOLS
from app.harness.registry import REGISTRY
from app.harness.runtime import HarnessRuntime
from app.harness.tools import ToolContext
from tests.harness_fakes import ScriptedLC, managed_ai, run, service

asyncpg = pytest.importorskip("asyncpg")
URL = os.environ.get("BILLING_PG_URL", "")

_FORBIDDEN = re.compile(
    r"\b(documents|document_versions|sources|career_evidence|bookmarks|user_links|rag_nodes)\b",
    re.IGNORECASE,
)
_SAY = {
    "list_documents",
    "get_document",
    "list_bookmarks",
    "search_career_context",
    "find_matching_postings",
    "edit_document",
    "parse_attachment",
    "explore_github",
}
_FORCE = {"posting_id", "document_id", "attachment_id", "url"}


def test_off_allows_only_what_was_attached():
    access = MaterialAccess(False, frozenset({("document", "doc-1")}))
    assert access.allows("document", "doc-1")
    assert not access.allows("document", "doc-2")
    assert not access.may_search()


def test_on_may_search_anything():
    access = MaterialAccess(True, frozenset())
    assert access.may_search()
    assert access.allows("evidence", "any")


class Tape:
    def __init__(self, pool):
        self._pool = pool
        self.sql: list[tuple] = []

    def _add(self, sql, args):
        self.sql.append((str(sql), args))

    def acquire(self):
        return _Acquire(self)

    async def fetch(self, sql, *args):
        self._add(sql, args)
        return await self._pool.fetch(sql, *args)

    async def fetchrow(self, sql, *args):
        self._add(sql, args)
        return await self._pool.fetchrow(sql, *args)

    async def fetchval(self, sql, *args):
        self._add(sql, args)
        return await self._pool.fetchval(sql, *args)

    async def execute(self, sql, *args):
        self._add(sql, args)
        return await self._pool.execute(sql, *args)

    def __getattr__(self, name):
        return getattr(self._pool, name)


class _Acquire:
    def __init__(self, tape: Tape):
        self._tape = tape
        self._cm = None

    async def __aenter__(self):
        self._cm = self._tape._pool.acquire()
        conn = await self._cm.__aenter__()
        return _Conn(self._tape, conn)

    async def __aexit__(self, *exc):
        return await self._cm.__aexit__(*exc)


class _Conn:
    def __init__(self, tape: Tape, conn):
        self._tape = tape
        self._conn = conn

    def _add(self, sql, args):
        self._tape.sql.append((str(sql), args))

    async def fetch(self, sql, *args):
        self._add(sql, args)
        return await self._conn.fetch(sql, *args)

    async def fetchrow(self, sql, *args):
        self._add(sql, args)
        return await self._conn.fetchrow(sql, *args)

    async def fetchval(self, sql, *args):
        self._add(sql, args)
        return await self._conn.fetchval(sql, *args)

    async def execute(self, sql, *args):
        self._add(sql, args)
        return await self._conn.execute(sql, *args)

    def transaction(self):
        return self._conn.transaction()

    def __getattr__(self, name):
        return getattr(self._conn, name)


def _hits(tape: Tape) -> list[str]:
    return [sql for sql, _args in tape.sql if _FORBIDDEN.search(sql)]


def _arg_text(args) -> str:
    parts = []
    for arg in args:
        if isinstance(arg, (list, tuple)):
            parts.extend(str(item) for item in arg)
        else:
            parts.append(str(arg))
    return " ".join(parts)


@pytest.fixture
async def db():
    if not URL:
        pytest.skip("BILLING_PG_URL is not set")
    from app.db import DB, _init_conn

    pool = await asyncpg.create_pool(URL, init=_init_conn, min_size=0, max_size=2)
    database = DB(pool)
    database.pool = Tape(pool)
    database.raw = pool
    try:
        yield database
    finally:
        await pool.close()


async def _user(db, *, read: bool | None) -> SimpleNamespace:
    user, thread = uuid4(), uuid4()
    q = db.raw
    await q.execute(
        "INSERT INTO users (id, provider, provider_subject, display_name) "
        "VALUES ($1, 'test', $2, 'read switch')",
        user,
        str(user),
    )
    await q.execute(
        "INSERT INTO conversations (id, user_id, title) VALUES ($1, $2, 't')",
        thread,
        user,
    )
    if read is not None:
        await q.execute(
            "INSERT INTO user_settings (user_id, allow_ai_read_my_files) VALUES ($1, $2)",
            user,
            read,
        )
    made = SimpleNamespace(
        user=user, thread=thread, runtime=HarnessRuntime(service(db), model_cls=ScriptedLC),
    )
    return made


async def _drop(db, user):
    raw = db.raw
    await raw.execute(
        "DELETE FROM workspace_files WHERE conversation_id IN "
        "(SELECT id FROM conversations WHERE user_id = $1)",
        user,
    )
    await raw.execute("DELETE FROM messages WHERE user_id = $1", user)
    await raw.execute("DELETE FROM documents WHERE user_id = $1", user)
    await raw.execute("DELETE FROM user_settings WHERE user_id = $1", user)
    await raw.execute("DELETE FROM conversations WHERE user_id = $1", user)
    await raw.execute("DELETE FROM users WHERE id = $1", user)


def _fill(annotation, name: str):
    origin = typing.get_origin(annotation)
    args = typing.get_args(annotation)
    if origin is typing.Annotated:
        return _fill(args[0], name)
    if origin is typing.Literal:
        return args[0]
    if origin in (typing.Union, types.UnionType):
        kept = [item for item in args if item is not type(None)]
        return _fill(kept[0], name) if kept else None
    if annotation in (UUID, str) or annotation is UUID:
        if annotation is str:
            return "https://example.com/job" if "url" in name else "sample"
        return uuid4()
    if annotation is int:
        return 1
    if annotation is bool:
        return False
    if origin is list:
        return []
    if isinstance(annotation, type) and issubclass(annotation, UUID):
        return uuid4()
    return "sample"


def _args(model):
    data = {}
    for name, field in model.model_fields.items():
        if not field.is_required() and name not in _FORCE:
            continue
        data[name] = _fill(field.annotation, name)
    return model.model_validate(data)


def _says(tool) -> bool:
    if tool.name in _SAY:
        return True
    return tool.name == "get_fit_score" and tool.run.__module__.endswith("personal.tools")


def _core():
    from app.harness.core_client import CoreClient

    def respond(_request):
        return httpx.Response(404, json={"error": {"code": "NO", "message": "no"}})

    return CoreClient("http://core.test", "secret", transport=httpx.MockTransport(respond))


async def _turn(made, **extra):
    payload = {
        "text": "해 줘",
        "user_id": str(made.user),
        "conversation_id": str(made.thread),
        "job_id": str(uuid4()),
        "access_mode": "AUTO",
        "ai": managed_ai(),
        "context": {},
        **extra,
    }
    return await run(made.runtime, payload, str(made.thread))


def _assistant(made) -> str:
    rows = [message.text for message in made.runtime.svc.messages if message.role == "ASSISTANT"]
    return rows[-1] if rows else ""


async def test_each_intent_off_reads_nothing_and_says_why(db):
    made = await _user(db, read=False)
    try:
        missed = []
        for intent in sorted(PERSONAL_INTENTS):
            db.pool.sql.clear()
            events = await _turn(made, intent=intent)
            hits = _hits(db.pool)
            notices = [
                chunk for kind, chunk in events
                if kind == "custom" and isinstance(chunk, dict) and chunk.get("type") == "notice"
            ]
            notice = notices[-1] if notices else None
            said = _assistant(made)
            if hits or said != REFUSED or notice is None or notice.get("code") != READ_SWITCH_OFF:
                missed.append((intent, hits[:1], said, notice))
        assert missed == []
    finally:
        await _drop(db, made.user)


async def test_each_registered_tool_off_reads_nothing(db, monkeypatch):
    async def page(url, allow_hop=None):
        return SimpleNamespace(url=url, text="page")

    monkeypatch.setattr("app.harness.personal.tools.fetch_page", page)
    made = await _user(db, read=False)
    token = current_access.set(MaterialAccess(False, frozenset()))
    try:
        tools = [
            *REGISTRY["personal"].tools,
            *REGISTRY["employer"].tools,
            *RESUME_TOOLS,
        ]
        missed = []
        core = _core()
        for tool in tools:
            db.pool.sql.clear()
            ctx = ToolContext(
                user_id=str(made.user),
                company_id=None,
                conversation_id=str(made.thread),
                job_id=str(uuid4()),
                tool_call_id=f"call-{tool.name}",
                db=db,
                core=core,
            )
            try:
                result = await tool.run(ctx, _args(tool.args_model))
            except Exception as exc:
                result = {"error": type(exc).__name__}
            if not isinstance(result, dict):
                result = {"entered": True}
            hits = _hits(db.pool)
            if hits or (_says(tool) and result.get("code") != READ_SWITCH_OFF):
                missed.append((tool.name, hits[:1], result.get("code"), result.get("error")))
        assert missed == []
        assert tools
    finally:
        current_access.reset(token)
        await _drop(db, made.user)


async def test_attached_link_reads_only_that_link(db, monkeypatch):
    async def page(url, allow_hop=None):
        return SimpleNamespace(url=url, text="page")

    monkeypatch.setattr("app.harness.personal.tools.fetch_page", page)
    made = await _user(db, read=False)
    link_id = uuid4()
    token = current_access.set(MaterialAccess(False, frozenset({("link", str(link_id))})))
    try:
        tool = next(item for item in REGISTRY["personal"].tools if item.name == "read_page")
        db.pool.sql.clear()
        result = await tool.run(
            ToolContext(
                user_id=str(made.user),
                company_id=None,
                conversation_id=str(made.thread),
                job_id=str(uuid4()),
                tool_call_id="call-link",
                db=db,
                core=_core(),
            ),
            _args(tool.args_model),
        )
        joined = "\n".join(sql for sql, _args in db.pool.sql)
        seen = " ".join(_arg_text(args) for _sql, args in db.pool.sql)
        assert result.get("text") == "page"
        assert "FROM user_links" in joined
        assert str(link_id) in seen
        other = re.compile(
            r"\b(documents|document_versions|sources|career_evidence|bookmarks|rag_nodes)\b",
            re.I,
        )
        assert other.search(joined) is None
    finally:
        current_access.reset(token)
        await _drop(db, made.user)


async def test_read_page_turn_off_sends_no_user_links_statement(db, monkeypatch):
    url = "https://example.com/job"

    async def page(target, allow_hop=None):
        return SimpleNamespace(url=target, text="page")

    monkeypatch.setattr("app.harness.personal.tools.fetch_page", page)
    made = await _user(db, read=False)
    try:
        await db.raw.execute(
            "INSERT INTO messages (id, user_id, conversation_id, role, text, attachments) "
            "VALUES ($1, $2, $3, 'USER', $4, '[]'::jsonb)",
            uuid4(),
            made.user,
            made.thread,
            f"이 페이지 {url}",
        )
        ScriptedLC.replies = [
            {"tool_calls": [{
                "name": "read_page",
                "id": "call-page",
                "type": "tool_call",
                "args": {"url": url},
            }]},
            {"content": "읽었어요"},
        ]
        db.pool.sql.clear()
        await _turn(made, text=f"이 페이지 {url}")
        joined = "\n".join(sql for sql, _args in db.pool.sql)
        assert "user_links" not in joined.lower()
        assert _assistant(made) == "읽었어요"
    finally:
        ScriptedLC.replies = []
        await _drop(db, made.user)


async def test_list_documents_turn_off_says_why(db):
    made = await _user(db, read=False)
    try:
        ScriptedLC.replies = [
            {"tool_calls": [{
                "name": "list_documents",
                "id": "call-docs",
                "type": "tool_call",
                "args": {},
            }]},
            {"content": "done"},
        ]
        db.pool.sql.clear()
        await _turn(made, text="서류 보여 줘")
        assert _hits(db.pool) == []
        assert _assistant(made) == REFUSED
    finally:
        ScriptedLC.replies = []
        await _drop(db, made.user)


async def test_attached_document_is_the_only_one_read(db):
    made = await _user(db, read=False)
    older, newer = uuid4(), uuid4()
    try:
        await db.raw.execute(
            "INSERT INTO documents (id, user_id, title, kind, template, status, updated_at) "
            "VALUES ($1, $2, 'older', 'HUB_PROFILE', 'CLASSIC', 'DRAFT', "
            "now() - interval '2 days')",
            older,
            made.user,
        )
        await db.raw.execute(
            "INSERT INTO documents (id, user_id, title, kind, template, status, updated_at) "
            "VALUES ($1, $2, 'newer', 'HUB_PROFILE', 'CLASSIC', 'DRAFT', now())",
            newer,
            made.user,
        )
        await db.raw.execute(
            "INSERT INTO messages (id, user_id, conversation_id, role, text, attachments) "
            "VALUES ($1, $2, $3, 'USER', '이 서류로', $4::jsonb)",
            uuid4(),
            made.user,
            made.thread,
            [{"kind": "document", "id": str(older)}],
        )
        db.pool.sql.clear()
        await _turn(made, intent="find_postings")
        joined = "\n".join(sql for sql, _args in db.pool.sql)
        assert "ORDER BY updated_at DESC" not in joined
        assert not re.search(r"\b(sources|career_evidence|bookmarks|user_links)\b", joined, re.I)
        seen = " ".join(_arg_text(args) for _sql, args in db.pool.sql)
        assert str(older) in seen
        assert str(newer) not in seen
        assert REFUSED not in _assistant(made)
    finally:
        await _drop(db, made.user)


async def test_switch_on_still_reads_the_newest_document(db):
    made = await _user(db, read=None)
    older, newer = uuid4(), uuid4()
    try:
        await db.raw.execute(
            "INSERT INTO documents (id, user_id, title, kind, template, status, updated_at) "
            "VALUES ($1, $2, 'older', 'HUB_PROFILE', 'CLASSIC', 'DRAFT', "
            "now() - interval '2 days')",
            older,
            made.user,
        )
        await db.raw.execute(
            "INSERT INTO documents (id, user_id, title, kind, template, status, updated_at) "
            "VALUES ($1, $2, 'newer', 'HUB_PROFILE', 'CLASSIC', 'DRAFT', now())",
            newer,
            made.user,
        )
        db.pool.sql.clear()
        await _turn(made, intent="find_postings")
        joined = "\n".join(sql for sql, _args in db.pool.sql)
        assert "ORDER BY updated_at DESC" in joined
        seen = " ".join(_arg_text(args) for _sql, args in db.pool.sql)
        assert str(newer) in seen
        assert REFUSED not in _assistant(made)
    finally:
        await _drop(db, made.user)
