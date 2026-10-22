from __future__ import annotations

import httpx
import pytest
from langgraph.checkpoint.memory import MemorySaver

from app.domain.services.conversation import ConversationService
from app.harness.core_client import CoreClient
from app.harness.graph import astream_harness, build_harness_graph
from app.harness.policy import Tier
from app.harness.registry import REGISTRY
from app.harness.router import select_harness
from app.harness.tools import HarnessSpec, ToolContext
from tests.fakes import ScriptedChat
from tests.stubs import FakeDB

_TIERS = {
    "search_postings": Tier.READ,
    "get_posting": Tier.READ,
    "list_bookmarks": Tier.READ,
    "list_applications": Tier.READ,
    "list_documents": Tier.READ,
    "get_document": Tier.READ,
    "list_offers": Tier.READ,
    "get_offer": Tier.READ,
    "list_calendar_events": Tier.READ,
    "get_my_profile": Tier.READ,
    "list_posts": Tier.READ,
    "get_fit_score": Tier.READ,
    "search_career_context": Tier.READ,
    "bookmark_posting": Tier.SAFE_WRITE,
    "unbookmark_posting": Tier.SAFE_WRITE,
    "create_calendar_event": Tier.SAFE_WRITE,
    "update_calendar_event": Tier.SAFE_WRITE,
    "edit_document": Tier.SAFE_WRITE,
    "start_document": Tier.SAFE_WRITE,
    "prepare_interview": Tier.SAFE_WRITE,
    "apply_to_posting": Tier.RISKY_WRITE,
    "accept_offer": Tier.RISKY_WRITE,
    "decline_offer": Tier.RISKY_WRITE,
    "send_offer_message": Tier.RISKY_WRITE,
    "create_post": Tier.RISKY_WRITE,
    "create_comment": Tier.RISKY_WRITE,
    "follow_user": Tier.RISKY_WRITE,
    "update_my_profile": Tier.RISKY_WRITE,
    "delete_calendar_event": Tier.RISKY_WRITE,
}

_PYTHON = {
    "list_documents",
    "get_document",
    "edit_document",
    "list_applications",
    "get_fit_score",
    "prepare_interview",
    "search_career_context",
    "start_document",
}

P = "11111111-1111-4111-8111-111111111111"
O = "44444444-4444-4444-8444-444444444444"
E = "55555555-5555-4555-8555-555555555555"
T = "66666666-6666-4666-8666-666666666666"
U = "33333333-3333-4333-8333-333333333333"

_CORE = {
    "search_postings": ({}, ("GET", "/api/v1/postings")),
    "get_posting": ({"posting_id": P}, ("GET", f"/api/v1/postings/{P}")),
    "list_bookmarks": ({}, ("GET", "/api/v1/me/bookmarks")),
    "bookmark_posting": ({"posting_id": P}, ("POST", f"/api/v1/postings/{P}/bookmark")),
    "unbookmark_posting": ({"posting_id": P}, ("DELETE", f"/api/v1/postings/{P}/bookmark")),
    "apply_to_posting": ({"posting_id": P}, ("POST", f"/api/v1/postings/{P}/apply")),
    "list_offers": ({}, ("GET", "/api/v1/me/offers")),
    "get_offer": ({"offer_id": O}, ("GET", f"/api/v1/me/offers/{O}")),
    "accept_offer": ({"offer_id": O}, ("POST", f"/api/v1/me/offers/{O}/accept")),
    "decline_offer": ({"offer_id": O}, ("POST", f"/api/v1/me/offers/{O}/decline")),
    "send_offer_message": ({"offer_id": O, "text": "hi"}, ("POST", f"/api/v1/me/offers/{O}/messages")),
    "list_calendar_events": ({}, ("GET", "/api/v1/calendar/events")),
    "create_calendar_event": ({"title": "면접"}, ("POST", "/api/v1/calendar/events")),
    "update_calendar_event": ({"event_id": E, "title": "면접"}, ("PATCH", f"/api/v1/calendar/events/{E}")),
    "delete_calendar_event": ({"event_id": E}, ("DELETE", f"/api/v1/calendar/events/{E}")),
    "list_posts": ({}, ("GET", "/api/v1/posts")),
    "create_post": ({"body": "hello"}, ("POST", "/api/v1/posts")),
    "create_comment": ({"post_id": T, "body": "hi"}, ("POST", f"/api/v1/posts/{T}/comments")),
    "follow_user": ({"user_id": U}, ("POST", f"/api/v1/users/{U}/follow")),
    "get_my_profile": ({}, ("GET", "/api/v1/me/profile")),
    "update_my_profile": ({"display_name": "김"}, ("PATCH", "/api/v1/me/profile")),
}

_WRITES = {"POST", "PATCH", "DELETE"}


def test_personal_tool_tiers():
    tools = {tool.name: tool.tier for tool in REGISTRY["personal"].tools}
    assert tools == _TIERS


@pytest.mark.parametrize("name", sorted(_CORE))
async def test_core_tool_paths(name):
    args, expected = _CORE[name]
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"data": {}})

    core = CoreClient("http://core.test", "secret", httpx.MockTransport(handler))
    tool = next(tool for tool in REGISTRY["personal"].tools if tool.name == name)
    ctx = ToolContext(
        user_id="user-1",
        company_id=None,
        conversation_id="conv-1",
        job_id="job-1",
        tool_call_id="call-1",
        db=None,
        core=core,
    )
    await tool.run(ctx, tool.args_model.model_validate(args))
    assert (seen[0].method, seen[0].url.path) == expected
    if expected[0] in _WRITES:
        assert seen[0].headers["idempotency-key"]


async def test_core_ids_cannot_rewrite_the_path():
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"data": {}})

    tool = next(tool for tool in REGISTRY["personal"].tools if tool.name == "bookmark_posting")
    graph = build_harness_graph(
        HarnessSpec(id="personal", audience="PERSONAL", prompt="p", tools=[tool]),
        MemorySaver(),
        model=ScriptedChat([{"tool_calls": [{
            "name": "bookmark_posting",
            "id": "c1",
            "type": "tool_call",
            "args": {"posting_id": f"../../me/offers/{O}/accept?x="},
        }]}, {"content": "done"}]),
        db=None,
        core=CoreClient("http://core.test", "secret", httpx.MockTransport(handler)),
    )
    async for _event in astream_harness(graph, {
        "messages": [{"role": "user", "content": "저장"}],
        "user_id": "user-1",
        "conversation_id": "conv-1",
        "job_id": "job-1",
        "access_mode": "AUTO",
    }, {"configurable": {"thread_id": "conv-1"}}):
        pass
    assert seen == []
    state = await graph.aget_state({"configurable": {"thread_id": "conv-1"}})
    assert '"INVALID_ARGS"' in state.values["messages"][-2].content


def test_core_paths_cover_non_python_tools():
    names = {tool.name for tool in REGISTRY["personal"].tools}
    assert set(_CORE) == names - _PYTHON


def test_router():
    assert select_harness({}).id == "personal"
    assert select_harness({"company_id": "co-1"}).id == "employer"
    assert select_harness({"resume_state": {"status": "active"}}).id == "resume"
    assert select_harness({
        "company_id": "co-1",
        "resume_state": {"status": "active"},
    }).id == "resume"
    assert select_harness({"resume_state": {"status": "done"}}).id == "personal"


def test_flag_off_uses_legacy_graph(monkeypatch):
    monkeypatch.delenv("AI_HARNESS", raising=False)
    svc = ConversationService(FakeDB(), None, MemorySaver())
    names = set(svc.graph.get_graph().nodes)
    assert {"resolve_context", "generate_reply", "persist"} <= names


def test_flag_on_uses_harness_nodes(monkeypatch):
    monkeypatch.setenv("AI_HARNESS", "1")
    svc = ConversationService(FakeDB(), None, MemorySaver())
    names = set(svc.graph.get_graph().nodes)
    assert {"agent", "tools"} <= names
    assert "resolve_context" not in names


async def test_flag_on_astream_yields_worker_pairs(monkeypatch):
    monkeypatch.setenv("AI_HARNESS", "1")
    svc = ConversationService(FakeDB(), None, MemorySaver())
    modes = []
    async for mode, _chunk in svc.graph.astream(
        {
            "text": "안녕",
            "user_id": "user-1",
            "conversation_id": "conv-1",
            "job_id": "job-1",
            "access_mode": "SUGGEST",
            "context": {},
        },
        config={"configurable": {"thread_id": "conv-1"}},
        stream_mode=["custom", "values"],
    ):
        modes.append(mode)
    assert modes
    assert set(modes) <= {"custom", "values"}


class _Approvals:
    def __init__(self):
        self.rows = {}
        self.calls = []

    def q(self):
        return self

    async def fetchrow(self, sql, *args):
        self.calls.append((sql, args))
        return self.rows.get(str(args[0]))

    async def execute(self, sql, *args):
        self.calls.append((sql, args))
        self.rows[str(args[0])] = {"id": args[0]}
        return "INSERT 1"


def _edit_graph(mode: str, db):
    tool = next(tool for tool in REGISTRY["personal"].tools if tool.name == "edit_document")
    model = ScriptedChat([{
        "tool_calls": [{
            "name": "edit_document",
            "id": "c1",
            "type": "tool_call",
            "args": {"document_id": "doc-1", "before": "이전", "after": "이후"},
        }],
    }, {"content": "done"}])
    return build_harness_graph(
        type(REGISTRY["personal"])(
            id="personal",
            audience="PERSONAL",
            prompt="p",
            tools=[tool],
        ),
        MemorySaver(),
        model=model,
        db=db,
        core=CoreClient("http://core.test", "secret"),
    )


async def _events(graph, mode: str):
    out = []
    async for event in astream_harness(
        graph,
        {
            "messages": [{"role": "user", "content": "고쳐줘"}],
            "user_id": "user-1",
            "conversation_id": "conv-1",
            "job_id": "job-1",
            "access_mode": mode,
        },
        {"configurable": {"thread_id": "conv-1"}},
    ):
        out.append(event)
    return out


async def test_edit_document_always_ask_is_document_edit():
    db = _Approvals()
    events = await _events(_edit_graph("ALWAYS_ASK", db), "ALWAYS_ASK")
    approvals = [event for event in events if event.get("type") == "approval"]
    assert approvals[0]["kind"] == "DOCUMENT_EDIT"
    assert approvals[0]["options"] == [
        {"id": "apply", "label": "적용"},
        {"id": "skip", "label": "그대로 두기"},
    ]
    assert not any(event.get("kind") == "TOOL_ACTION" for event in events)
    assert events[-1] == {"type": "done", "awaiting": "approval"}


async def test_edit_document_auto_emits_diff():
    events = await _events(_edit_graph("AUTO", _Approvals()), "AUTO")
    diffs = [event for event in events if event.get("type") == "diff"]
    assert diffs[0]["documentId"] == "doc-1"
    assert {"line": None, "sign": "-", "text": "이전"} in diffs[0]["hunks"]
    assert {"line": None, "sign": "+", "text": "이후"} in diffs[0]["hunks"]
    assert not any(event.get("type") == "approval" for event in events)


class _ResumeDB:
    def __init__(self):
        self.calls = []

    def q(self):
        return self

    async def execute(self, sql, *args):
        self.calls.append((sql, args))
        return "UPDATE 1"


async def test_start_document_marks_resume_active():
    tool = next(tool for tool in REGISTRY["personal"].tools if tool.name == "start_document")
    db = _ResumeDB()
    ctx = ToolContext(
        user_id="user-1",
        company_id=None,
        conversation_id="conv-1",
        job_id="job-1",
        tool_call_id="call-1",
        db=db,
        core=CoreClient("http://core.test", "secret"),
    )
    result = await tool.run(ctx, tool.args_model.model_validate({}))
    assert result["resume_state"]["status"] == "active"
    assert "resume_state" in db.calls[0][0]
    assert db.calls[0][1][0] == "conv-1"
