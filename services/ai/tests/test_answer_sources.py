from __future__ import annotations

import json
from types import SimpleNamespace
from uuid import UUID

from langgraph.checkpoint.memory import MemorySaver
from pydantic import BaseModel

from app.harness.graph import build_harness_graph
from app.harness.policy import Tier
from app.harness.runtime import HarnessRuntime
from app.harness.sources import TurnSources, current_sources, note, note_tool
from app.harness.tools import HarnessSpec, ToolContext, ToolSpec
from app.infrastructure import resume_workspace as ws
from tests.fakes import ScriptedChat
from tests.harness_fakes import CONV, USER, ScriptedLC, managed_ai, run, service
from tests.test_cov_workspace import _conv as workspace_conv
from tests.test_cov_workspace import _Docs

POSTING = UUID("11111111-1111-4111-8111-111111111111")
DOCUMENT = UUID("22222222-2222-4222-8222-222222222222")
LINK = UUID("33333333-3333-4333-8333-333333333333")
ASKED_LINK = UUID("44444444-4444-4444-8444-444444444444")
CONV_ID = "55555555-5555-4555-8555-555555555555"
ASKED = "https://lnkd.in/jobs"
FINAL = "https://www.linkedin.com/jobs/view/1"


class _Links:
    def __init__(self, rows: dict[str, UUID]):
        self.rows = rows
        self.sql = ""

    def q(self):
        return self

    async def fetchrow(self, sql, *_args):
        self.sql = sql
        url = _args[-1]
        found = self.rows.get(url)
        if found is None:
            return None
        return {"id": found}


class _Exec:
    def __init__(self):
        self.calls: list[tuple] = []

    def q(self):
        return self

    async def execute(self, sql, *args):
        self.calls.append((sql, args))


def _bind():
    bucket = TurnSources()
    return bucket, current_sources.set(bucket)


async def _note(name, args, result, db=None):
    bucket, token = _bind()
    try:
        await note_tool(name, args, result, user_id=str(USER), db=db)
    finally:
        current_sources.reset(token)
    return bucket.list()


def test_turn_sources_keep_first_use_and_drop_the_rest():
    bucket = TurnSources()
    bucket.add("posting", POSTING, "모아페이 채용 공고")
    bucket.add("posting", str(POSTING), "다시")
    bucket.add("nope", "x", "y")
    bucket.add("link", "", "제목")
    bucket.add("link", LINK, "  ")
    for index in range(6):
        bucket.add("file", f"file-{index}", f"파일 {index}")
    found = bucket.list()
    assert [item["kind"] for item in found] == ["posting", "file", "file", "file", "file"]
    assert found[0] == {"kind": "posting", "id": str(POSTING), "title": "모아페이 채용 공고"}
    assert found[-1]["id"] == "file-3"
    assert current_sources.get() is None
    note("document", DOCUMENT, "이력서")
    assert current_sources.get() is None


async def test_posting_and_document_titles_come_from_the_tool_result():
    posting_args = SimpleNamespace(posting_id=POSTING)
    document_args = SimpleNamespace(document_id=DOCUMENT)
    assert await _note("get_posting", posting_args, {
        "company": "모아페이", "title": "백엔드", "id": str(POSTING),
    }) == [{"kind": "posting", "id": str(POSTING), "title": "모아페이 채용 공고"}]
    document = await _note(
        "get_document", document_args, {"id": str(DOCUMENT), "title": "경력 이력서"})
    assert document == [{"kind": "document", "id": str(DOCUMENT), "title": "경력 이력서"}]
    assert await _note("get_posting", posting_args, {"company": "  ", "title": "백엔드"}) == []
    assert await _note("get_document", document_args, {}) == []
    assert await _note("bookmark_posting", posting_args, {"bookmarked": True}) == []
    failed = await _note(
        "get_posting", posting_args, {"error": "TOOL_FAILED", "company": "모아페이"})
    assert failed == []


async def test_read_page_names_the_page_after_redirects():
    both = _Links({FINAL: LINK, ASKED: ASKED_LINK})
    assert await _note("read_page", {"url": ASKED}, {"url": FINAL, "text": "본문"}, both) == [
        {"kind": "link", "id": str(LINK), "title": FINAL},
    ]
    assert "user_links" in both.sql and "deleted_at IS NULL" in both.sql
    asked_only = _Links({ASKED: ASKED_LINK})
    assert await _note("read_page", {"url": ASKED}, {"url": FINAL, "text": "본문"}, asked_only) == [
        {"kind": "link", "id": str(ASKED_LINK), "title": FINAL},
    ]
    missed = await _note(
        "read_page", {"url": ASKED}, {"url": FINAL, "text": "본문"}, _Links({}))
    assert missed == []
    redirected = await _note(
        "read_page",
        {"url": ASKED},
        {"error": "REDIRECTED", "to": FINAL},
        _Links({ASKED: ASKED_LINK}),
    )
    assert redirected == []
    same = "https://jobs.example/1"
    stayed = await _note(
        "read_page", {"url": same}, {"url": same, "text": "본문"}, _Links({same: LINK}))
    assert stayed == [{"kind": "link", "id": str(LINK), "title": same}]


class _Id(BaseModel):
    posting_id: str = ""
    document_id: str = ""


def _tool(name, run):
    return ToolSpec(name, Tier.READ, _Id, run, lambda _args: name)


def _graph(tools, replies):
    spec = HarnessSpec(id="unit", prompt="help", tools=tools)
    return build_harness_graph(
        spec, MemorySaver(), model=ScriptedChat(replies), db=_Links({}), core=object())


def _call(name: str, call_id: str, **args) -> dict:
    return {"name": name, "args": args, "id": call_id, "type": "tool_call"}


async def test_tools_node_records_only_a_successful_read():
    seen = []

    async def get_posting(ctx: ToolContext, args: _Id) -> dict:
        seen.append(args.posting_id)
        return {"company": "모아페이", "title": "백엔드", "id": args.posting_id}

    async def boom(ctx: ToolContext, args: _Id) -> dict:
        raise RuntimeError("down")

    bucket, token = _bind()
    try:
        graph = _graph(
            [_tool("get_posting", get_posting), _tool("get_document", boom)],
            [
                {"tool_calls": [_call("get_posting", "c1", posting_id=str(POSTING))]},
                {"tool_calls": [_call("get_document", "c2", document_id=str(DOCUMENT))]},
                {"content": "끝"},
            ],
        )
        await graph.ainvoke(
            {
                "messages": [],
                "user_id": str(USER),
                "conversation_id": str(CONV),
                "job_id": "job-1",
                "access_mode": "AUTO",
                "tool_calls_used": 0,
            },
            {"configurable": {"thread_id": "sources"}},
        )
    finally:
        current_sources.reset(token)
    assert seen == [str(POSTING)]
    assert bucket.list() == [{"kind": "posting", "id": str(POSTING), "title": "모아페이 채용 공고"}]


class _Core:
    async def call(self, method, path, **kwargs):
        return {"id": str(POSTING), "company": "모아페이", "title": "백엔드"}


class _Documents:
    async def get(self, user_id, document_id):
        return {"id": document_id, "title": "경력 이력서"}


async def test_a_turn_stores_the_posting_and_the_document_on_the_assistant_message():
    ScriptedLC.replies = [
        {"tool_calls": [_call("get_posting", "c1", posting_id=str(POSTING))]},
        {"tool_calls": [_call("get_document", "c2", document_id=str(DOCUMENT))]},
        {"content": "둘 다 봤어요"},
    ]
    ScriptedLC.bound = []
    svc = service()
    svc.document_svc = _Documents()
    runtime = HarnessRuntime(svc, model_cls=ScriptedLC)
    runtime._core = _Core()
    items = await run(runtime, {
        "text": "안녕",
        "user_id": USER,
        "conversation_id": CONV,
        "job_id": "99999999-9999-4999-8999-999999999999",
        "access_mode": "AUTO",
        "ai": managed_ai(),
        "context": {},
    })
    sources = [
        {"kind": "posting", "id": str(POSTING), "title": "모아페이 채용 공고"},
        {"kind": "document", "id": str(DOCUMENT), "title": "경력 이력서"},
    ]
    assert items[-1][0] == "values"
    assert items[-1][1]["sources"] == sources
    user, assistant = svc.messages
    assert user.attachments == []
    updates = [call for call in svc.db.executed if "UPDATE messages SET attachments" in call[0]]
    assert len(updates) == 1
    assert updates[0][1][0] == assistant.id
    assert json.loads(updates[0][1][1]) == sources


async def test_saved_file_carries_the_bot_and_a_new_document_is_stamped_once():
    from app.harness.personal.resume import profile_document as docs
    from app.harness.personal.tools import bound_services

    db = _Exec()
    bucket, token = _bind()
    try:
        stored = await docs._insert_source(
            db, {"user_id": str(USER), "conversation_id": CONV_ID}, "이력서.pdf", b"%PDF", 1)
    finally:
        current_sources.reset(token)
    assert stored is True
    sql, args = db.calls[0]
    assert "created_by_bot_id" in sql
    assert "SELECT bot_id FROM conversations WHERE id = $10" in sql
    assert args[2] == "이력서.pdf"
    assert args[9] == UUID(CONV_ID)
    assert bucket.list() == [{"kind": "file", "id": str(args[0]), "title": "이력서.pdf"}]

    broken = _Exec()

    async def fail(sql, *args):
        raise RuntimeError("down")

    broken.execute = fail
    empty, token = _bind()
    try:
        assert await docs._insert_source(
            broken, {"user_id": str(USER)}, "이력서.pdf", b"%PDF", 1) is False
    finally:
        current_sources.reset(token)
    assert empty.list() == []

    class _Created:
        async def create(self, user_id, application_id, title, kind, template, language):
            return SimpleNamespace(id=DOCUMENT, revision=1, title=title)

        async def create_version(self, *args):
            return None

    writer = _Exec()
    token = bound_services.set(SimpleNamespace(document_svc=_Created(), db=writer))
    try:
        made = await docs.save_profile_document(
            {"user_id": str(USER), "conversation_id": CONV_ID, "drafts": {"markdown": "# 프로필"}},
            "Push 프로필",
        )
    finally:
        bound_services.reset(token)
    assert made == str(DOCUMENT)
    stamp = [call for call in writer.calls if "UPDATE documents SET created_by_bot_id" in call[0]]
    assert len(stamp) == 1
    assert stamp[0][1] == (DOCUMENT, UUID(CONV_ID))
    assert "created_by_bot_id IS NULL" in stamp[0][0]


class _Files:
    def __init__(self):
        self.files: dict = {}
        self.executes: list[tuple] = []

    def q(self):
        return self

    async def execute(self, sql, *args):
        self.executes.append((sql, args))
        if "workspace_files" in sql:
            self.files[(args[0], args[1])] = {"body": args[2], "content": None}

    async def fetchrow(self, sql, conv_id, name):
        return self.files.get((conv_id, name))


async def test_sync_stamps_a_new_document_and_skips_an_update():
    db = _Files()
    db.files[(workspace_conv("Job").id, "03_resume.md")] = {"body": "# Kim\n", "content": None}
    svc = SimpleNamespace(db=db, document_svc=_Docs())
    conv = workspace_conv("Job")
    synced = await ws._sync_documents_db(svc, USER, conv, ["03_resume.md"])
    stamps = [sql for sql, _args in db.executes if "UPDATE documents SET created_by_bot_id" in sql]
    assert len(stamps) == 1
    assert "SELECT bot_id FROM conversations WHERE id = $2" in stamps[0]
    db.files[(conv.id, "03_resume.md")] = {"body": "# Kim v2\n", "content": None}
    await ws._sync_documents_db(svc, USER, conv, ["03_resume.md"])
    again = [sql for sql, _args in db.executes if "UPDATE documents SET created_by_bot_id" in sql]
    assert again == stamps
    assert synced[0]["document_id"]
