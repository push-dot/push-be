from __future__ import annotations

import pytest
from langchain_core.messages import HumanMessage, ToolMessage
from langgraph.checkpoint.memory import MemorySaver
from langgraph.types import Command
from pydantic import BaseModel

from app.harness.core_client import CoreError
from app.harness.graph import _child_resume, astream_harness, build_harness_graph
from app.harness.policy import Tier
from app.harness.tools import HarnessSpec, ToolContext, ToolSpec
from tests.fakes import ScriptedChat, data_json


class IdArgs(BaseModel):
    id: str


class MemApprovals:
    def __init__(self):
        self.rows = []

    def q(self):
        return self

    async def fetchrow(self, sql, *args):
        wanted = str(args[0])
        for row in self.rows:
            if str(row["id"]) == wanted:
                return row
        return None

    async def execute(self, sql, *args):
        self.rows.append({"id": args[0], "sql": sql, "kind": "TOOL_ACTION"})
        return "INSERT 1"


def _call(name: str, call_id: str, posting: str = "p1") -> dict:
    return {"name": name, "args": {"id": posting}, "id": call_id, "type": "tool_call"}


def _spec(runs: list, bookmark_error: Exception | None = None) -> HarnessSpec:
    async def bookmark(ctx: ToolContext, args: IdArgs) -> dict:
        if bookmark_error is not None:
            raise bookmark_error
        runs.append(("bookmark", args.id))
        return {"bookmarked": True}

    async def apply(ctx: ToolContext, args: IdArgs) -> dict:
        runs.append(("apply", args.id))
        return {"applied": True}

    def summary(args: IdArgs) -> str:
        return args.id

    return HarnessSpec(
        id="personal",
        prompt="help",
        tools=[
            ToolSpec("bookmark_posting", Tier.SAFE_WRITE, IdArgs, bookmark, summary),
            ToolSpec("apply_to_posting", Tier.RISKY_WRITE, IdArgs, apply, summary),
        ],
    )


def _graph(model, runs, bookmark_error=None):
    db = MemApprovals()
    graph = build_harness_graph(
        _spec(runs, bookmark_error),
        MemorySaver(),
        model=model,
        db=db,
        core=object(),
    )
    return graph, db


def _config():
    return {"configurable": {"thread_id": "conv-1"}}


def _input(mode: str, text: str = "hi") -> dict:
    return {
        "messages": [HumanMessage(content=text)],
        "user_id": "user-1",
        "company_id": None,
        "conversation_id": "conv-1",
        "job_id": "job-1",
        "access_mode": mode,
        "tool_calls_used": 0,
    }


async def _events(graph, payload):
    out = []
    async for event in astream_harness(graph, payload, _config()):
        out.append(event)
    return out


async def test_auto_runs_safe_and_asks_risky():
    runs = []
    model = ScriptedChat([
        {"tool_calls": [_call("bookmark_posting", "c1"), _call("apply_to_posting", "c2")]},
        {"content": "waiting"},
    ])
    graph, db = _graph(model, runs)
    events = await _events(graph, _input("AUTO"))
    assert runs == [("bookmark", "p1")]
    assert len(db.rows) == 1
    assert "TOOL_ACTION" in db.rows[0]["sql"]
    assert any(event.get("type") == "done" and event.get("awaiting") == "approval" for event in events)
    approval = next(event for event in events if event.get("type") == "approval")
    assert approval["kind"] == "TOOL_ACTION"
    assert approval["options"] == [
        {"id": "approve", "label": "지원하기"},
        {"id": "reject", "label": "닫기"},
    ]
    assert approval["toolName"] == "apply_to_posting"


async def test_resume_approve_executes_once():
    runs = []
    model = ScriptedChat([
        {"tool_calls": [_call("apply_to_posting", "c2")]},
        {"content": "done"},
    ])
    graph, db = _graph(model, runs)
    await _events(graph, _input("AUTO"))
    assert runs == []
    events = await _events(graph, Command(resume={"option_id": "approve"}))
    assert runs == [("apply", "p1")]
    assert any(event.get("type") == "tool" and event.get("state") == "ok" for event in events)
    assert len(db.rows) == 1


async def test_resume_reject_skips():
    runs = []
    model = ScriptedChat([
        {"tool_calls": [_call("apply_to_posting", "c2")]},
        {"content": "skipped"},
    ])
    graph, _db = _graph(model, runs)
    await _events(graph, _input("AUTO"))
    await _events(graph, Command(resume={"option_id": "reject"}))
    assert runs == []
    tool_messages = [
        message for message in model.seen[-1]
        if isinstance(message, ToolMessage)
    ]
    assert data_json(tool_messages[-1].content) == {"rejected": True}


async def test_bypass_runs_writes_but_asks_before_applying():
    runs = []
    model = ScriptedChat([
        {"tool_calls": [_call("bookmark_posting", "c1"), _call("apply_to_posting", "c2")]},
        {"content": "waiting"},
    ])
    graph, db = _graph(model, runs)
    events = await _events(graph, _input("BYPASS"))
    assert runs == [("bookmark", "p1")]
    assert len(db.rows) == 1
    approval = next(event for event in events if event.get("type") == "approval")
    assert approval["toolName"] == "apply_to_posting"
    await _events(graph, Command(resume={"option_id": "approve"}))
    assert runs == [("bookmark", "p1"), ("apply", "p1")]


async def test_always_ask_asks_safe_write():
    runs = []
    model = ScriptedChat([
        {"tool_calls": [_call("bookmark_posting", "c1")]},
        {"content": "waiting"},
    ])
    graph, db = _graph(model, runs)
    events = await _events(graph, _input("ALWAYS_ASK"))
    assert runs == []
    assert len(db.rows) == 1
    assert any(event.get("type") == "tool" and event.get("state") == "wait" and event.get("tier") == "SAFE_WRITE" for event in events)


async def test_tool_run_is_emitted_before_ok():
    runs = []
    model = ScriptedChat([
        {"tool_calls": [_call("bookmark_posting", "c1"), _call("apply_to_posting", "c2")]},
        {"content": "done"},
    ])
    graph, _db = _graph(model, runs)
    first = await _events(graph, _input("AUTO"))
    def named(events, name):
        return [
            event for event in events
            if event.get("type") == "tool" and event.get("name") == name
        ]

    bookmark = named(first, "bookmark_posting")
    assert [event["state"] for event in bookmark] == ["run", "ok"]
    assert "result" not in bookmark[0]
    waiting = named(first, "apply_to_posting")
    assert [event["state"] for event in waiting] == ["wait"]
    second = await _events(graph, Command(resume={"option_id": "approve"}))
    applied = named(second, "apply_to_posting")
    assert [event["state"] for event in applied] == ["run", "ok"]
    assert applied[1]["result"] == {"applied": True}
    assert runs == [("bookmark", "p1"), ("apply", "p1")]


async def test_tool_cap_8():
    runs = []
    calls = [_call("bookmark_posting", f"c{i}", f"p{i}") for i in range(10)]
    model = ScriptedChat([{"tool_calls": calls}, {"content": "한도"}])
    graph, _db = _graph(model, runs)
    await _events(graph, _input("BYPASS"))
    assert len(runs) == 8
    assert "도구 호출 한도" in model.seen[-1][-1].content or any(
        isinstance(message, ToolMessage) and "도구 호출 한도" in message.content
        for message in model.seen[-1]
    )


async def test_core_error_becomes_tool_result():
    runs = []
    model = ScriptedChat([
        {"tool_calls": [_call("bookmark_posting", "c1")]},
        {"content": "cannot"},
    ])
    graph, _db = _graph(model, runs, CoreError(403, "FORBIDDEN", "no"))
    events = await _events(graph, _input("BYPASS"))
    assert runs == []
    assert any(event.get("result") == {"error": "FORBIDDEN"} for event in events)
    assert model.seen[-1][-1].content
    assert "FORBIDDEN" in model.seen[-1][-1].content


async def test_tool_cap_resets_each_turn_and_answers_without_tools():
    runs = []
    calls = [_call("bookmark_posting", f"c{i}", f"p{i}") for i in range(8)]
    model = ScriptedChat([
        {"tool_calls": calls},
        {"content": "first"},
        {"tool_calls": [_call("bookmark_posting", "d1", "q1")]},
        {"content": "second"},
    ])
    graph, _db = _graph(model, runs)
    await _events(graph, _input("BYPASS"))
    assert len(runs) == 8
    await _events(graph, _state_input())
    assert runs[-1] == ("bookmark", "q1")


async def test_after_cap_the_model_answers_without_tool_calls():
    runs = []
    calls = [_call("bookmark_posting", f"c{i}", f"p{i}") for i in range(8)]
    more = [{"tool_calls": [_call("bookmark_posting", f"x{i}", "p9")]} for i in range(20)]
    model = ScriptedChat([{"tool_calls": calls}, *more])
    graph, _db = _graph(model, runs)
    await _events(graph, _input("BYPASS"))
    state = await graph.aget_state(_config())
    assert len(runs) == 8
    assert len(model.seen) == 2
    assert not state.values["messages"][-1].tool_calls


def _state_input():
    from app.harness.runtime import _state
    return _state(
        {"text": "again", "user_id": "user-1", "conversation_id": "conv-1",
         "job_id": "job-2", "access_mode": "BYPASS"},
        {},
    )


async def test_tool_card_args_with_uuids_are_json():
    from uuid import UUID as _UUID

    from app.harness.approval import create_tool_approval

    class Uuid(BaseModel):
        id: _UUID

    db = MemApprovals()
    tool = ToolSpec("apply_to_posting", Tier.RISKY_WRITE, Uuid, None, lambda _args: "지원")
    event, created = await create_tool_approval(
        db, user_id="u", conversation_id="c", job_id="j", tool=tool,
        args=Uuid(id="11111111-1111-4111-8111-111111111111"), tool_call_id="t")
    assert created
    assert event["args"] == {"id": "11111111-1111-4111-8111-111111111111"}


async def test_unexpected_tool_exception_becomes_tool_failed_result():
    # An escaping exception left the AIMessage's tool call unanswered and killed the thread.
    runs = []
    model = ScriptedChat([
        {"tool_calls": [_call("bookmark_posting", "c1")]},
        {"content": "sorry"},
    ])
    graph, _db = _graph(model, runs, ValueError("badly formed id"))
    events = await _events(graph, _input("BYPASS"))
    assert any(event.get("result") == {"error": "TOOL_FAILED"} and event.get("state") == "err"
               for event in events)
    answer = model.seen[-1][-1]
    assert isinstance(answer, ToolMessage) and answer.tool_call_id == "c1"
    assert data_json(answer.content) == {"error": "TOOL_FAILED"}


async def test_domain_error_from_a_tool_becomes_its_code():
    from app.domain.errors import DomainError

    runs = []
    model = ScriptedChat([
        {"tool_calls": [_call("bookmark_posting", "c1")]},
        {"content": "sorry"},
    ])
    graph, _db = _graph(model, runs, DomainError(404, "NOT_FOUND", "gone"))
    events = await _events(graph, _input("BYPASS"))
    assert any(event.get("result") == {"error": "NOT_FOUND"} for event in events)
    assert data_json(model.seen[-1][-1].content) == {"error": "NOT_FOUND"}


async def test_unknown_tool_calls_count_toward_the_cap_and_finish_within_the_step_limit():
    # Unknown calls used to cost a graph step each without counting: 30 of them hit
    # GraphRecursionError. Now 8 count, the rest are answered in one step.
    calls = [_call("no_such_tool", f"u{i}") for i in range(30)]
    model = ScriptedChat([{"tool_calls": calls}, {"content": "끝"}])
    graph, _db = _graph(model, [])
    await _events(graph, _input("BYPASS"))
    state = await graph.aget_state(_config())
    answers = [m for m in state.values["messages"] if isinstance(m, ToolMessage)]
    assert sorted(m.tool_call_id for m in answers) == sorted(f"u{i}" for i in range(30))
    assert sum(m.content == "도구 호출 한도" for m in answers) == 22
    assert state.values["tool_calls_used"] == 8


class _PostingDb(MemApprovals):
    def __init__(self, posting):
        super().__init__()
        self.posting = posting

    async def fetchrow(self, sql, *args):
        if "job_postings" in sql:
            return self.posting
        return await super().fetchrow(sql, *args)


async def _apply_card(db, posting_id):
    from uuid import uuid4

    from app.harness.approval import create_tool_approval
    from app.harness.personal.tools import PERSONAL_TOOLS

    tool = next(spec for spec in PERSONAL_TOOLS if spec.name == "apply_to_posting")
    event, _created = await create_tool_approval(
        db,
        user_id=uuid4(),
        conversation_id=uuid4(),
        job_id="job-1",
        tool=tool,
        args=tool.args_model(posting_id=posting_id),
        tool_call_id="c1",
    )
    return event


async def test_apply_card_title_names_the_posting():
    from uuid import uuid4

    event = await _apply_card(
        _PostingDb({"company": "모아페이", "title": "백엔드 엔지니어"}), uuid4()
    )
    assert event["title"] == "모아페이 · 백엔드 엔지니어에 지원해요"
    assert event["summary"] == "이 공고에 지원해요"


async def test_apply_card_title_stays_generic_for_an_unknown_posting():
    from uuid import uuid4

    event = await _apply_card(_PostingDb(None), uuid4())
    assert event["title"] == "이 공고에 지원해요"


def test_resume_flow_follows_the_job_of_the_current_turn():
    state = {"job_id": "new", "conversation_id": "c", "user_id": "u", "resume": {"job_id": "old", "status": "active"}}
    assert _child_resume(state)["job_id"] == "new"


def test_usage_is_billed_to_the_running_job_not_the_one_that_opened_the_gate():
    from types import SimpleNamespace

    from app.harness.status import current_run, job_of

    token = current_run.set(SimpleNamespace(job_id="new"))
    try:
        assert job_of({"job_id": "old"}) == "new"
    finally:
        current_run.reset(token)
    assert job_of({"job_id": "old"}) == "old"


def test_billing_tools_read_the_running_job_while_keys_keep_the_gate_job():
    from types import SimpleNamespace

    from app.harness.status import current_run
    from app.harness.tools import ToolContext

    ctx = ToolContext("u", None, "c", "old", "call", None, None)
    token = current_run.set(SimpleNamespace(job_id="new"))
    try:
        assert (ctx.usage_job_id, ctx.job_id) == ("new", "old")
    finally:
        current_run.reset(token)


async def test_resume_fit_tool_bills_the_running_job(monkeypatch):
    from types import SimpleNamespace

    from app.harness.personal.resume import tools as resume_tools
    from app.harness.status import current_run
    from app.harness.tools import ToolContext

    seen = {}

    async def judge(*_args, **kwargs):
        seen.update(kwargs)
        return {}

    monkeypatch.setattr(resume_tools, "judge_fit", judge)
    ctx = ToolContext("00000000-0000-4000-8000-000000000001", None, "c", "old", "call", None, None)
    token = current_run.set(SimpleNamespace(job_id="new"))
    try:
        await resume_tools._fit(ctx, resume_tools.FitArgs())
    finally:
        current_run.reset(token)
    assert seen["job_id"] == "new"


async def _phase_prompt(monkeypatch, text):
    from types import SimpleNamespace

    from app.harness.personal.resume import graph as resume_graph

    async def stored_text(_db, _state):
        return text

    seen = []

    class Model:
        async def ainvoke(self, messages):
            seen.extend(message.content for message in messages)
            return {"text": "ok"}

    monkeypatch.setattr(resume_graph, "load_document_markdown", stored_text)
    await resume_graph._output(Model(), "craft", {"inputs": {"documentId": "d"}}, SimpleNamespace(db=None))
    return "\n".join(seen)


async def test_resume_phase_prompt_carries_the_text_of_the_attached_document(monkeypatch):
    assert "페이플로우 프로덕트 매니저" in await _phase_prompt(monkeypatch, "페이플로우 프로덕트 매니저")


async def test_resume_phase_prompt_marks_where_a_long_document_was_cut(monkeypatch):
    from app.harness.personal.resume.graph import _RESUME_TEXT_LIMIT

    prompt = await _phase_prompt(monkeypatch, "가" * _RESUME_TEXT_LIMIT + "끝")
    assert "가" * _RESUME_TEXT_LIMIT in prompt
    assert "끝" not in prompt
    assert "이하 생략" in prompt


async def test_resume_phase_prompt_keeps_a_document_at_the_limit_whole(monkeypatch):
    from app.harness.personal.resume.graph import _RESUME_TEXT_LIMIT

    prompt = await _phase_prompt(monkeypatch, "가" * _RESUME_TEXT_LIMIT)
    assert "이하 생략" not in prompt


async def test_resume_phase_prompt_has_no_document_text_when_the_document_is_empty(monkeypatch):
    prompt = await _phase_prompt(monkeypatch, "")
    assert "resume_text" not in prompt


async def test_a_malformed_document_tree_reads_as_empty():
    from app.harness.personal.resume.profile_document import load_document_markdown

    class Db:
        def q(self):
            return self

        async def fetchrow(self, *_args):
            return {"content": {"type": "doc", "content": [None]}}

    state = {
        "inputs": {"documentId": "11111111-1111-4111-8111-111111111111"},
        "user_id": "00000000-0000-4000-8000-000000000001",
    }
    assert await load_document_markdown(Db(), state) == ""


def _billing_call(case, monkeypatch):
    from types import SimpleNamespace
    from uuid import uuid4

    from app.harness.employer import tools as employer
    from app.harness.personal import tools as personal

    seen = {}

    async def spy(*args, **kwargs):
        seen["job_id"] = kwargs["job_id"] if "job_id" in kwargs else args[1]["job_id"]
        return {}

    user = "00000000-0000-4000-8000-000000000001"
    if case == "employer_fit":
        async def posting(*_args):
            return {"requirements": [], "skills": [], "description": ""}

        monkeypatch.setattr(employer, "judge_fit", spy)
        monkeypatch.setattr("app.infrastructure.posting_fit_cache.company_posting", posting)
        db = SimpleNamespace(q=lambda: object())
        ctx = ToolContext(user, user, "c", "old", "call", db, None)
        return seen, employer._fit(ctx, employer.FitArgs(posting_id=uuid4()))
    ctx = ToolContext(user, None, "c", "old", "call", None, None)
    if case == "personal_fit":
        monkeypatch.setattr(personal, "judge_fit", spy)
        return seen, personal._get_fit_score(ctx, personal.FitArgs())
    if case == "find_postings":
        monkeypatch.setattr("app.domain.services.posting_match.run_quick_match", spy)
        return seen, personal._find_matching_postings(ctx, personal.MatchArgs())
    monkeypatch.setattr("app.framework.rag.search_career_context", spy)
    monkeypatch.setattr(personal, "_svc", lambda: SimpleNamespace(ai=object()))
    return seen, personal._search_career(ctx, personal.CareerQuery(query="k8s"))


@pytest.mark.parametrize("case", ["employer_fit", "personal_fit", "find_postings", "career"])
async def test_every_billing_tool_bills_the_running_job(case, monkeypatch):
    from app.harness.status import Run, current_run

    seen, call = _billing_call(case, monkeypatch)
    token = current_run.set(Run("new", "", False))
    try:
        await call
    finally:
        current_run.reset(token)
    assert seen["job_id"] == "new"


def test_craft_and_publish_prompts_name_the_key_that_holds_the_document_body():
    from app.harness.personal.resume.graph import phase_instructions

    for phase in ("craft", "publish"):
        assert "markdown 키" in phase_instructions(phase, {})
    assert "markdown 키" not in phase_instructions("review", {})
