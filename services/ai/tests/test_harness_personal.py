from __future__ import annotations

import json

from types import SimpleNamespace

import httpx
import pytest
from langgraph.checkpoint.memory import MemorySaver
from langgraph.types import Command

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
    "send_offer_message": ({"offer_id": O, "body": "hi"}, ("POST", f"/api/v1/me/offers/{O}/messages")),
    "list_calendar_events": ({}, ("GET", "/api/v1/calendar/events")),
    "create_calendar_event": ({"type": "INTERVIEW", "title": "면접", "starts_at": "2026-10-23T01:00:00Z", "ends_at": "2026-10-23T02:00:00Z"}, ("POST", "/api/v1/calendar/events")),
    "update_calendar_event": ({"event_id": E, "title": "면접"}, ("PATCH", f"/api/v1/calendar/events/{E}")),
    "delete_calendar_event": ({"event_id": E}, ("DELETE", f"/api/v1/calendar/events/{E}")),
    "list_posts": ({}, ("GET", "/api/v1/posts")),
    "create_post": ({"category": "dev", "title": "t", "body": "hello"}, ("POST", "/api/v1/posts")),
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
    if seen[0].content:
        assert set(json.loads(seen[0].content)) <= _CORE_FIELDS


_CORE_FIELDS = {"type", "title", "startsAt", "endsAt", "body", "category", "displayName", "headline"}


async def test_calendar_and_profile_bodies_use_core_names():
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(json.loads(request.content))
        return httpx.Response(200, json={"data": {}})

    core = CoreClient("http://core.test", "secret", httpx.MockTransport(handler))
    ctx = ToolContext(user_id="user-1", company_id=None, conversation_id="conv-1",
                      job_id="job-1", tool_call_id="call-1", db=None, core=core)
    tools = {tool.name: tool for tool in REGISTRY["personal"].tools}
    await tools["update_calendar_event"].run(ctx, tools["update_calendar_event"].args_model.model_validate(
        {"event_id": E, "starts_at": "2026-10-23T01:00:00Z"}))
    await tools["update_my_profile"].run(ctx, tools["update_my_profile"].args_model.model_validate(
        {"display_name": "김"}))
    assert seen == [{"startsAt": "2026-10-23T01:00:00Z"}, {"displayName": "김"}]


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


def _edit_graph(mode: str, db, core=None):
    tool = next(tool for tool in REGISTRY["personal"].tools if tool.name == "edit_document")
    model = ScriptedChat([{
        "tool_calls": [{
            "name": "edit_document",
            "id": "c1",
            "type": "tool_call",
            "args": {"document_id": DOC_ID, "before": "이전", "after": "이후"},
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
        core=core or CoreClient("http://core.test", "secret"),
    )


async def _events(graph, mode: str):
    out = []
    async for event in astream_harness(
        graph,
        {
            "messages": [{"role": "user", "content": "고쳐줘"}],
            "user_id": EDIT_USER,
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


EDIT_USER = "99999999-9999-4999-8999-999999999999"
DOC_ID = "12121212-1212-4212-8212-121212121212"


class _CoreEdits:
    """Stands in for core's POST /documents/{id}/edits."""

    def __init__(self, error: str | None = None):
        self.requests = []
        self.error = error

    def handler(self, request):
        self.requests.append(request)
        if self.error:
            return httpx.Response(409, json={"error": {"code": self.error, "message": "resource was modified"}})
        return httpx.Response(200, json={"data": {"document": {"id": DOC_ID}, "version": {"id": "v2"}}})

    def client(self):
        return CoreClient("http://core.test", "secret", httpx.MockTransport(self.handler))


async def test_edit_document_auto_applies_the_edit_through_core():
    core = _CoreEdits()
    events = await _events(_edit_graph("AUTO", _Approvals(), core.client()), "AUTO")
    diffs = [event for event in events if event.get("type") == "diff"]
    assert diffs[0]["documentId"] == DOC_ID
    request = core.requests[0]
    assert request.method == "POST"
    assert request.url.path == f"/api/v1/documents/{DOC_ID}/edits"
    assert request.headers["x-push-act-as"] == EDIT_USER
    assert request.headers["Idempotency-Key"]
    assert json.loads(request.content)["hunks"] == [
        {"line": None, "sign": "-", "text": "이전"}, {"line": None, "sign": "+", "text": "이후"}]
    assert not any(event.get("type") == "approval" for event in events)


async def test_edit_document_conflict_is_a_tool_error():
    core = _CoreEdits(error="REVISION_CONFLICT")
    events = await _events(_edit_graph("BYPASS", _Approvals(), core.client()), "BYPASS")
    tool = next(event for event in events if event.get("type") == "tool" and event.get("result"))
    assert tool["result"] == {"error": "REVISION_CONFLICT"}
    assert not any(event.get("type") == "diff" for event in events)


async def test_edit_document_always_ask_applies_after_approve():
    core = _CoreEdits()
    graph = _edit_graph("ALWAYS_ASK", _Approvals(), core.client())
    await _events(graph, "ALWAYS_ASK")
    assert core.requests == []
    async for _event in astream_harness(
            graph, Command(resume={"option_id": "apply"}), {"configurable": {"thread_id": "conv-1"}}):
        pass
    assert len(core.requests) == 1


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
