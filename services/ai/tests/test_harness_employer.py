from __future__ import annotations

import json

import httpx
import pytest
from langgraph.checkpoint.memory import MemorySaver
from pydantic import ValidationError

from app.domain.errors import PLAN_REQUIRED, DomainError
from app.harness.core_client import CoreClient
from app.harness.employer.guard import guard_employer_intent
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
}

_PYTHON = {"get_fit_score"}

_CORE = {
    "list_company_postings": ({}, ("GET", "/api/v1/companies/me/postings")),
    "get_posting": ({"posting_id": "p1"}, ("GET", "/api/v1/postings/p1")),
    "list_applicants": (
        {"posting_id": "p1", "stage": "SCREENING"},
        ("GET", "/api/v1/postings/p1/applicants"),
    ),
    "get_applicant": (
        {"posting_id": "p1", "application_id": "a1"},
        ("GET", "/api/v1/postings/p1/applicants/a1"),
    ),
    "get_applicant_counts": ({"posting_id": "p1"}, ("GET", "/api/v1/postings/p1/applicant-counts")),
    "search_profiles": ({"q": "backend"}, ("GET", "/api/v1/profiles")),
    "get_profile": ({"profile_id": "u1"}, ("GET", "/api/v1/profiles/u1")),
    "get_company": ({}, ("GET", "/api/v1/companies/me")),
    "draft_posting": ({"title": "백엔드"}, ("POST", "/api/v1/postings")),
    "update_posting_draft": ({"posting_id": "p1", "title": "백엔드"}, ("PATCH", "/api/v1/postings/p1")),
    "publish_posting": ({"posting_id": "p1"}, ("PATCH", "/api/v1/postings/p1")),
    "update_published_posting": ({"posting_id": "p1", "title": "시니어"}, ("PATCH", "/api/v1/postings/p1")),
    "close_posting": ({"posting_id": "p1"}, ("POST", "/api/v1/postings/p1/close")),
    "change_applicant_stage": (
        {"posting_id": "p1", "application_id": "a1", "stage": "INTERVIEW"},
        ("PATCH", "/api/v1/postings/p1/applicants/a1"),
    ),
    "send_offer": ({"profile_id": "u1", "message": "제안"}, ("POST", "/api/v1/profiles/u1/offer")),
    "create_company_post": ({"body": "채용 중"}, ("POST", "/api/v1/posts")),
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
        return httpx.Response(200, json={"data": {"id": "p1", "title": "백엔드"}})

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
    request = seen[0]
    assert (request.method, request.url.path) == expected
    assert request.headers["x-push-company"] == "co-1"
    if expected[0] in _WRITES:
        assert request.headers["idempotency-key"]
    if name == "draft_posting":
        assert json.loads(request.content)["status"] == "DRAFT"
        assert result["draft"]["id"] == "p1"
    if name == "list_applicants":
        assert request.url.params["stage"] == "SCREENING"
    if name == "change_applicant_stage":
        assert json.loads(request.content)["stage"] == "INTERVIEW"
    if name == "publish_posting":
        assert json.loads(request.content)["status"] == "OPEN"
    if name == "update_posting_draft":
        assert json.loads(request.content)["status"] == "DRAFT"


def test_core_paths_cover_employer_http_tools():
    names = {tool.name for tool in REGISTRY["employer"].tools}
    assert set(_CORE) == names - _PYTHON


def test_basic_interview_requires_pro():
    with pytest.raises(DomainError) as caught:
        guard_employer_intent("BASIC", "interview")
    assert caught.value.status == 403
    assert caught.value.code == PLAN_REQUIRED


async def test_draft_posting_tool_event_has_draft():
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"data": {"id": "p1", "title": "백엔드", "status": "DRAFT"}})

    tool = _tool("draft_posting")
    graph = build_harness_graph(
        HarnessSpec(id="employer", audience="EMPLOYER", prompt="p", tools=[tool]),
        MemorySaver(),
        model=ScriptedChat([{
            "tool_calls": [{
                "name": "draft_posting",
                "id": "c1",
                "type": "tool_call",
                "args": {"title": "백엔드"},
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
