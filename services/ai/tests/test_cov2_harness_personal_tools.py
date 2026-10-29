"""harness/personal/tools.py: service-backed tools, approval skip, resume state parsing."""
from __future__ import annotations

import json
from types import SimpleNamespace
from uuid import UUID, uuid4

import pytest
from langgraph.types import Command

import app.harness.personal.tools as tools
from app.domain import entities as ent
from app.domain.pagination import PageRequest
from app.harness.core_client import CoreClient
from app.harness.tools import ToolContext
from tests.cov_fakes import NOW, entity

USER = "99999999-9999-4999-8999-999999999999"
CONV = "77777777-7777-4777-8777-777777777777"


def _tool(name):
    return next(t for t in tools.PERSONAL_TOOLS if t.name == name)


def _ctx(db=None, mode="AUTO", core=None):
    return ToolContext(
        user_id=USER, company_id=None, conversation_id=CONV, job_id="job-1",
        tool_call_id="call-1", db=db, core=core or CoreClient("http://core.test", "secret"),
        access_mode=mode)


async def _run(name, args, ctx=None, svc=None):
    tool = _tool(name)
    token = tools.bound_services.set(svc)
    try:
        return await tool.run(ctx or _ctx(), tool.args_model.model_validate(args))
    finally:
        tools.bound_services.reset(token)


@pytest.mark.parametrize(("name", "args", "empty"), [
    ("list_documents", {}, {"items": []}),
    ("get_document", {"document_id": str(uuid4())}, {}),
    ("list_applications", {}, {"items": []}),
    ("prepare_interview", {"interview_id": str(uuid4())}, {"error": "UNAVAILABLE"}),
    ("search_career_context", {"query": "k8s"}, {"text": ""}),
])
@pytest.mark.parametrize("svc", [None, SimpleNamespace()])
async def test_service_tools_degrade_without_bound_services(name, args, empty, svc):
    assert await _run(name, args, svc=svc) == empty


async def test_list_and_get_documents_are_scoped_to_the_caller():
    doc = entity(ent.Document, user_id=UUID(USER), title="이력서")
    calls = []

    class Docs:
        async def list(self, user_id, application_id, kind, page):
            calls.append(("list", user_id, application_id, kind, page))
            return SimpleNamespace(items=[doc])

        async def get(self, user_id, document_id):
            calls.append(("get", user_id, document_id))
            return doc

    svc = SimpleNamespace(document_svc=Docs())
    listed = await _run("list_documents", {}, svc=svc)
    got = await _run("get_document", {"document_id": str(doc.id)}, svc=svc)

    assert listed["items"][0]["id"] == str(doc.id)
    assert listed["items"][0]["title"] == "이력서"
    assert "userId" not in listed["items"][0]
    assert got["id"] == str(doc.id)
    assert calls[0] == ("list", UUID(USER), None, None, PageRequest())
    assert calls[1] == ("get", UUID(USER), doc.id)


async def test_list_applications_is_scoped_to_the_caller():
    app = entity(ent.Application, user_id=UUID(USER))
    seen = []

    class Apps:
        async def list(self, user_id, status, q, page):
            seen.append((user_id, status, q))
            return SimpleNamespace(items=[app])

    out = await _run("list_applications", {}, svc=SimpleNamespace(application_svc=Apps()))
    assert [item["id"] for item in out["items"]] == [str(app.id)]
    assert seen == [(UUID(USER), None, "")]


async def test_prepare_interview_passes_ids_and_revision():
    interview_id = uuid4()
    op = entity(ent.Operation, user_id=UUID(USER), status=ent.OP_RUNNING)
    seen = []

    class Interviews:
        async def prepare(self, user_id, iid, revision, ai):
            seen.append((user_id, iid, revision, ai))
            return op

    out = await _run("prepare_interview",
                     {"interview_id": str(interview_id), "expected_revision": 3},
                     svc=SimpleNamespace(interviews=Interviews()))
    assert out["id"] == str(op.id) and out["status"] == ent.OP_RUNNING
    assert seen == [(UUID(USER), interview_id, 3, None)]


async def test_search_career_runs_rag_for_the_caller(monkeypatch):
    import app.framework.rag as rag
    seen = []

    async def collect(svc, state, seen_ids):
        seen.append((state, seen_ids))
        return "[관련 근거]\n- A\nb" if state["text"] else None

    monkeypatch.setattr(rag, "search_career_context", collect)
    svc = SimpleNamespace(ai=object())
    assert await _run("search_career_context", {"query": "결제"}, svc=svc) == {
        "text": "[관련 근거]\n- A\nb"}
    assert await _run("search_career_context", {}, svc=svc) == {"text": ""}
    assert seen[0] == ({"text": "결제", "user_id": USER, "job_id": "job-1"}, set())


async def test_fit_score_without_a_user_row_is_free(monkeypatch):
    seen = []

    async def fake(requirements, keywords, description, content, plan, **kwargs):
        seen.append((plan, bool(content)))
        return {
            "fitScore": 4.0 if content else 1.0,
            "parts": {}, "topGap": "", "plan": plan,
        }

    monkeypatch.setattr(tools, "judge_fit", fake, raising=False)
    out = await _run("get_fit_score", {
        "requirements": ["Python"], "keywords": ["Kafka"],
        "description": "", "content": "Python Kafka 경험"})
    assert set(out) == {"fitScore", "parts", "topGap", "plan"}
    assert out["plan"] == "FREE"
    assert seen == [("FREE", True)]
    empty = await _run("get_fit_score", {"document_id": str(uuid4())})
    assert empty["fitScore"] <= out["fitScore"]
    assert seen[1] == ("FREE", False)


class _Approvals:
    def __init__(self, existing=True):
        self.existing = existing
        self.executed = []

    def q(self):
        return self

    async def fetchrow(self, sql, *args):
        return {"id": args[0]} if self.existing else None

    async def execute(self, sql, *args):
        self.executed.append(sql)


async def test_edit_document_always_ask_skip_leaves_the_document(monkeypatch):
    asked = []
    monkeypatch.setattr(tools, "interrupt", lambda payload: asked.append(payload) or {"option_id": "skip"})
    core_calls = []

    async def apply_edit(*args):
        core_calls.append(args)
        return {}

    monkeypatch.setattr(tools, "apply_edit", apply_edit)
    db = _Approvals(existing=True)
    out = await _run("edit_document", {"document_id": str(uuid4()), "after": "새 문장"},
                     ctx=_ctx(db=db, mode="ALWAYS_ASK"))
    assert out == {"skipped": True}
    assert core_calls == []
    assert db.executed == []
    assert asked[0]["awaiting"] == "approval" and asked[0]["kind"] == "DOCUMENT_EDIT"


async def test_edit_document_always_ask_without_an_answer_is_skipped(monkeypatch):
    monkeypatch.setattr(tools, "interrupt", lambda payload: None)
    out = await _run("edit_document", {"document_id": "00000000-0000-0000-0000-0000000000d1"},
                     ctx=_ctx(db=_Approvals(existing=True), mode="ALWAYS_ASK"))
    assert out == {"skipped": True}


class _ResumeDB:
    def __init__(self, row):
        self.row = row
        self.executed = []

    def q(self):
        return self

    async def fetchrow(self, sql, *args):
        if isinstance(self.row, Exception):
            raise self.row
        return self.row

    async def execute(self, sql, *args):
        self.executed.append((sql, args))


@pytest.fixture
def emitted(monkeypatch):
    out = []
    monkeypatch.setattr("app.harness.tools.get_stream_writer", lambda: out.append)
    return out


async def test_start_document_offers_a_choice_when_resume_json_is_active(emitted):
    db = _ResumeDB({"resume_state": json.dumps({"status": "active", "phase": "craft"})})
    out = await _run("start_document", {}, ctx=_ctx(db=db))
    choice = out["choice"]
    assert choice["gate"] == "start_document"
    assert [o["id"] for o in choice["options"]] == ["continue", "cancel"]
    assert emitted == [choice]
    assert any("INSERT INTO approvals" in sql for sql, _args in db.executed)
    assert not any("resume_state" in sql for sql, _args in db.executed)


@pytest.mark.parametrize("row", [
    {"resume_state": "{not json"},
    {"resume_state": json.dumps(["active"])},
    {"resume_state": None},
])
async def test_start_document_starts_fresh_when_state_is_unreadable(row, emitted):
    db = _ResumeDB(row)
    out = await _run("start_document", {}, ctx=_ctx(db=db))
    assert isinstance(out, Command)
    assert out.goto == "resume_flow"
    assert out.update["resume"] == {"status": "active", "phase": "mode_select"}
    assert db.executed[0][1][0] == CONV
    assert emitted == []


async def test_start_document_db_error_propagates_and_writes_nothing(emitted):
    # A failed read must not overwrite an active resume flow with a fresh one.
    db = _ResumeDB(RuntimeError("db down"))
    with pytest.raises(RuntimeError):
        await _run("start_document", {}, ctx=_ctx(db=db))
    assert db.executed == []
    assert emitted == []


class _Record:
    """asyncpg.Record shape: key access, but not a dict."""

    def __init__(self, data):
        self._data = data

    def __getitem__(self, key):
        return self._data[key]

    def get(self, key, default=None):
        return self._data.get(key, default)


async def test_start_document_reads_resume_state_from_an_asyncpg_record(emitted):
    db = _ResumeDB(_Record({"resume_state": {"status": "active", "phase": "craft"}}))
    out = await _run("start_document", {}, ctx=_ctx(db=db))
    assert "choice" in out
    assert any("INSERT INTO approvals" in sql for sql, _args in db.executed)
    assert not any("resume_state" in sql for sql, _args in db.executed)


async def test_start_document_choice_survives_without_a_stream_writer():
    db = _ResumeDB({"resume_state": {"status": "active"}})
    out = await _run("start_document", {}, ctx=_ctx(db=db))
    assert out["choice"]["gate"] == "start_document"


@pytest.mark.xfail(strict=True, reason=(
    "BUG: harness/personal/tools.py:289 reads svc.interviews, but the bound service is "
    "ConversationService (domain/services/conversation.py:172), which has no interviews "
    "attribute, so prepare_interview always returns UNAVAILABLE in production"))
async def test_prepare_interview_works_with_the_production_chat_service():
    from app.domain.services.conversation import ConversationService
    from tests.stubs import FakeDB
    svc = ConversationService(FakeDB(), None)
    assert await _run("prepare_interview", {"interview_id": str(uuid4())}, svc=svc) != {
        "error": "UNAVAILABLE"}


async def test_each_edit_in_a_job_gets_its_own_approval(monkeypatch):
    # Without the tool call id, a second edit in the job reused the first, already resolved approval.
    asked = []
    monkeypatch.setattr(tools, "interrupt", lambda payload: asked.append(payload) or {"option_id": "skip"})
    monkeypatch.setattr("app.harness.tools.get_stream_writer", lambda: lambda _event: None)
    for call_id in ("call-1", "call-2"):
        ctx = _ctx(db=_Approvals(existing=True), mode="ALWAYS_ASK")
        ctx.tool_call_id = call_id
        await _run("edit_document", {"document_id": str(uuid4())}, ctx=ctx)
    assert asked[0]["approval_id"] != asked[1]["approval_id"]


@pytest.mark.parametrize("model", [tools.FitArgs, tools.PrepareArgs])
def test_model_supplied_ids_must_be_uuids(model):
    from pydantic import ValidationError
    field = "interview_id" if model is tools.PrepareArgs else "document_id"
    with pytest.raises(ValidationError):
        model.model_validate({field: "../../x"})


async def test_fit_score_treats_empty_ids_as_none(monkeypatch):
    async def fake(requirements, keywords, description, content, plan, **kwargs):
        return {"fitScore": 1.0, "parts": {}, "topGap": "", "plan": plan}

    monkeypatch.setattr(tools, "judge_fit", fake, raising=False)
    assert tools.FitArgs.model_validate({"posting_id": "", "document_id": ""}).document_id is None
    out = await _run(
        "get_fit_score",
        {"document_id": "", "requirements": ["python"], "content": "python"})
    assert isinstance(out, dict) and "error" not in out
