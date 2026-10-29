from __future__ import annotations

import json

import httpx
import pytest
from langgraph.checkpoint.memory import MemorySaver
from pydantic import ValidationError

from app.harness.core_client import CoreClient
from app.harness.graph import astream_harness, build_harness_graph
from app.harness.policy import Tier
from app.harness.registry import REGISTRY
from app.harness.tools import HarnessSpec, ToolContext
from tests.fakes import ScriptedChat

_TIERS = {
    "list_company_postings": Tier.READ,
    "get_posting": Tier.READ,
    "list_applicants": Tier.READ,
    "get_applicant": Tier.READ,
    "get_applicant_counts": Tier.READ,
    "search_profiles": Tier.READ,
    "get_profile": Tier.READ,
    "get_company": Tier.READ,
    "get_fit_score": Tier.READ,
    "draft_posting": Tier.SAFE_WRITE,
    "update_posting_draft": Tier.SAFE_WRITE,
    "publish_posting": Tier.RISKY_WRITE,
    "update_published_posting": Tier.RISKY_WRITE,
    "close_posting": Tier.RISKY_WRITE,
    "change_applicant_stage": Tier.RISKY_WRITE,
    "send_offer": Tier.RISKY_WRITE,
    "create_company_post": Tier.RISKY_WRITE,
    "start_posting": Tier.SAFE_WRITE,
    "review_applicant": Tier.READ,
    "prepare_interview": Tier.READ,
}

_PYTHON = {"get_fit_score", "start_posting", "review_applicant", "prepare_interview"}

P = "11111111-1111-4111-8111-111111111111"
A = "22222222-2222-4222-8222-222222222222"
U = "33333333-3333-4333-8333-333333333333"

_CORE = {
    "list_company_postings": ({}, ("GET", "/api/v1/companies/me/postings")),
    "get_posting": ({"posting_id": P}, ("GET", f"/api/v1/postings/{P}")),
    "list_applicants": (
        {"posting_id": P, "stage": "SCREENING"},
        ("GET", f"/api/v1/postings/{P}/applicants"),
    ),
    "get_applicant": (
        {"posting_id": P, "application_id": A},
        ("GET", f"/api/v1/postings/{P}/applicants/{A}"),
    ),
    "get_applicant_counts": ({"posting_id": P}, ("GET", f"/api/v1/postings/{P}/applicant-counts")),
    "search_profiles": ({"q": "backend"}, ("GET", "/api/v1/profiles")),
    "get_profile": ({"profile_id": U}, ("GET", f"/api/v1/profiles/{U}")),
    "get_company": ({}, ("GET", "/api/v1/companies/me")),
    "draft_posting": (
        {"title": "백엔드", "job_category": "dev", "location": "서울", "employment_type": "full_time"},
        ("POST", "/api/v1/postings"),
    ),
    "update_posting_draft": ({"posting_id": P, "title": "백엔드"}, ("PATCH", f"/api/v1/postings/{P}")),
    "publish_posting": ({"posting_id": P}, ("PATCH", f"/api/v1/postings/{P}")),
    "update_published_posting": ({"posting_id": P, "title": "시니어"}, ("PATCH", f"/api/v1/postings/{P}")),
    "close_posting": ({"posting_id": P}, ("POST", f"/api/v1/postings/{P}/close")),
    "change_applicant_stage": (
        {"posting_id": P, "application_id": A, "stage": "INTERVIEW"},
        ("PATCH", f"/api/v1/postings/{P}/applicants/{A}"),
    ),
    "send_offer": ({"profile_id": U, "message": "제안", "posting_id": P}, ("POST", f"/api/v1/profiles/{U}/offer")),
    "create_company_post": ({"category": "work", "title": "채용", "body": "채용 중"}, ("POST", "/api/v1/posts")),
}

_WRITES = {"POST", "PATCH", "DELETE"}


def _tool(name):
    return next(tool for tool in REGISTRY["employer"].tools if tool.name == name)


def test_employer_tool_tiers():
    tools = {tool.name: tool.tier for tool in REGISTRY["employer"].tools}
    assert tools == _TIERS


def test_employer_args_omit_company_id():
    for tool in REGISTRY["employer"].tools:
        assert "company_id" not in tool.args_model.model_fields
        assert "companyId" not in tool.args_model.model_fields


def test_stage_is_closed():
    with pytest.raises(ValidationError):
        _tool("change_applicant_stage").args_model.model_validate({
            "posting_id": "p1",
            "application_id": "a1",
            "stage": "HIRED",
        })


@pytest.mark.parametrize("name", sorted(_CORE))
async def test_employer_core_tool_paths(name):
    args, expected = _CORE[name]
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"data": {"id": "p1", "title": "백엔드", "status": "DRAFT", "revision": 3}})

    core = CoreClient("http://core.test", "secret", httpx.MockTransport(handler))
    tool = _tool(name)
    ctx = ToolContext(
        user_id="user-1",
        company_id="co-1",
        conversation_id="conv-1",
        job_id="job-1",
        tool_call_id="call-1",
        db=None,
        core=core,
    )
    result = await tool.run(ctx, tool.args_model.model_validate(args))
    request = seen[-1]
    assert (request.method, request.url.path) == expected
    assert request.headers["x-push-company"] == "co-1"
    if expected[0] in _WRITES:
        assert request.headers["idempotency-key"]
    if name == "draft_posting":
        sent = json.loads(request.content)
        assert sent["status"] == "DRAFT"
        assert sent["jobCategory"] == "dev"
        assert sent["employmentType"] == "full_time"
        assert result["draft"]["id"] == "p1"
    if name == "list_applicants":
        assert request.url.params["stage"] == "SCREENING"
    if name == "send_offer":
        assert json.loads(request.content) == {"message": "제안", "postingId": P}
    if name == "change_applicant_stage":
        assert json.loads(request.content)["stage"] == "INTERVIEW"
    if name == "publish_posting":
        assert json.loads(request.content)["status"] == "OPEN"
    if request.method == "PATCH" and "/applicants/" not in request.url.path:
        assert json.loads(request.content)["expectedRevision"] == 3


async def test_update_posting_draft_leaves_open_postings_alone():
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.method)
        return httpx.Response(200, json={"data": {"id": P, "status": "OPEN", "revision": 2}})

    tool = _tool("update_posting_draft")
    ctx = ToolContext(
        user_id="user-1", company_id="co-1", conversation_id="conv-1", job_id="job-1",
        tool_call_id="call-1", db=None,
        core=CoreClient("http://core.test", "secret", httpx.MockTransport(handler)),
    )
    result = await tool.run(ctx, tool.args_model.model_validate({"posting_id": P, "title": "x"}))
    assert result == {"error": "NOT_DRAFT"}
    assert seen == ["GET"]


def test_core_paths_cover_employer_http_tools():
    names = {tool.name for tool in REGISTRY["employer"].tools}
    assert set(_CORE) == names - _PYTHON


async def test_basic_interview_plan_gate_is_core_only():
    from pathlib import Path

    from app.harness.runtime import HarnessRuntime
    from tests.harness_fakes import CONV, USER, Rows, ScriptedLC, run, service

    core = Path(__file__).resolve().parents[2] / "core-api" / "src"
    assert 'employer_interview: { plan: "PRO"' in (core / "jobs" / "config.ts").read_text()
    assert 'assertPlanAllows(owned.plan, "employer_interview")' in (core / "routes" / "conversations.ts").read_text()
    assert not (Path(__file__).resolve().parents[1] / "src" / "app" / "harness" / "employer" / "guard.py").exists()
    svc = service(Rows({"company_id": "co-1", "resume_state": None}))

    async def basic(_company_id):
        return "BASIC"

    svc.conversations.company_plan = basic
    ScriptedLC.replies = [{"content": "질문이에요"}]
    items = await run(HarnessRuntime(svc, model_cls=ScriptedLC), {
        "text": "면접 질문 만들어줘", "user_id": USER, "conversation_id": CONV,
        "job_id": "99999999-9999-4999-8999-999999999999", "access_mode": "AUTO",
        "ai": None, "context": {}, "intent": "interview",
    })
    assert items[-1][0] == "values"


async def test_draft_posting_tool_event_has_draft():
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"data": {"id": "p1", "title": "백엔드", "status": "DRAFT"}})

    tool = _tool("draft_posting")
    graph = build_harness_graph(
        HarnessSpec(id="employer", prompt="p", tools=[tool]),
        MemorySaver(),
        model=ScriptedChat([{
            "tool_calls": [{
                "name": "draft_posting",
                "id": "c1",
                "type": "tool_call",
                "args": {"title": "백엔드", "job_category": "dev", "location": "서울", "employment_type": "full_time"},
            }],
        }, {"content": "done"}]),
        db=None,
        core=CoreClient("http://core.test", "secret", httpx.MockTransport(handler)),
    )
    events = []
    async for event in astream_harness(
        graph,
        {
            "messages": [{"role": "user", "content": "초안"}],
            "user_id": "user-1",
            "company_id": "co-1",
            "conversation_id": "conv-1",
            "job_id": "job-1",
            "access_mode": "AUTO",
        },
        {"configurable": {"thread_id": "conv-1"}},
    ):
        events.append(event)
    tools = [event for event in events if event.get("type") == "tool" and event.get("state") == "ok"]
    assert tools[0]["result"]["draft"]["id"] == "p1"


def test_employer_fit_ids_must_be_uuids():
    from app.harness.employer.tools import FitArgs
    assert FitArgs.model_validate({"posting_id": "", "document_id": ""}).posting_id is None
    with pytest.raises(ValidationError):
        FitArgs.model_validate({"document_id": "not-a-uuid"})
