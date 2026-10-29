from __future__ import annotations

import pytest
from langchain_core.messages import AIMessage
from langgraph.checkpoint.memory import MemorySaver
from langgraph.types import Command

from app.domain.employer_chat import bind_employer_plan, reset_employer_plan
from app.harness.employer.flows import RoleOption, RoleOptions
from app.harness.employer.schemas import CompanyProfile, PostingDraft, PostingReview, RoleSpec
from app.harness.graph import build_harness_graph, turn_model
from app.harness.registry import REGISTRY


class FakeTurn:
    def __init__(self):
        self.calls = []

    def bind_tools(self, tools, **kw):
        return self

    async def ainvoke(self, messages, **kw):
        return AIMessage(content="네")

    async def astructured(self, schema, messages):
        self.calls.append(schema)
        if schema is CompanyProfile:
            return CompanyProfile(name="모아페이", summary="결제 회사")
        if schema is RoleOptions:
            return RoleOptions(options=[RoleOption(id="pay", label="결제 승인 API를 키울 사람")])
        if schema is RoleSpec:
            return RoleSpec(need="결제 승인", career_min=4, career_max=6)
        if schema is PostingDraft:
            return PostingDraft(
                title="결제 승인 백엔드 엔지니어",
                description=["승인 API를 설계해요"],
                requirements=["Kotlin 서버 개발 4년 이상"],
                preferred=["Kafka"],
            )
        if schema is PostingReview:
            draft = PostingDraft(
                title="결제 승인 백엔드 엔지니어",
                description=["승인 API를 설계해요"],
                requirements=["Kotlin 서버 개발 4년 이상"],
                preferred=["Kafka"],
            )
            return PostingReview(draft=draft)
        raise AssertionError(schema)


@pytest.fixture
def employer_graph():
    graph = build_harness_graph(REGISTRY["employer"], MemorySaver(), model=None, db=None, core=None)
    fake = FakeTurn()
    token = turn_model.set(fake)
    plan = bind_employer_plan("PRO")
    yield graph, fake
    reset_employer_plan(plan)
    turn_model.reset(token)


def _interrupt(result) -> dict:
    return result["__interrupt__"][0].value


BASE = {
    "user_id": "u1",
    "conversation_id": "c1",
    "job_id": "j1",
    "company_id": None,
    "access_mode": "AUTO",
    "messages": [],
}


async def test_posting_flow_stops_at_role_then_confirm_then_saves(employer_graph):
    graph, fake = employer_graph
    config = {"configurable": {"thread_id": "c1"}}
    out = await graph.ainvoke({**BASE, "start_flow": {"name": "posting"}}, config)
    assert _interrupt(out)["kind"] == "EMPLOYER_GATE" and _interrupt(out)["gate"] == "pf_role"
    out = await graph.ainvoke(Command(resume={"option_id": "pay"}), config)
    assert _interrupt(out)["gate"].startswith("pf_confirm")
    out = await graph.ainvoke(Command(resume={"option_id": "save"}), config)
    assert "__interrupt__" not in out
    last = out["messages"][-1]
    assert isinstance(last, AIMessage) and "```posting-draft" in last.content
    assert out.get("flow") is None
    # Resuming a gate must not replay model calls made before it.
    assert fake.calls == [CompanyProfile, RoleOptions, RoleSpec, PostingDraft, PostingReview]


async def test_cancel_at_role_gate_leaves_in_the_same_turn(employer_graph):
    graph, _fake = employer_graph
    config = {"configurable": {"thread_id": "c2"}}
    await graph.ainvoke(
        {**BASE, "conversation_id": "c2", "start_flow": {"name": "posting"}}, config
    )
    out = await graph.ainvoke(Command(resume={"text": "그만할게요"}), config)
    assert "__interrupt__" not in out
    assert out["messages"][-1].content == "기업 흐름을 그만뒀어요."


async def test_rewrite_loops_back_to_draft(employer_graph):
    graph, fake = employer_graph
    config = {"configurable": {"thread_id": "c3"}}
    await graph.ainvoke(
        {**BASE, "conversation_id": "c3", "start_flow": {"name": "posting"}}, config
    )
    await graph.ainvoke(Command(resume={"option_id": "pay"}), config)
    out = await graph.ainvoke(Command(resume={"text": "연봉 범위 6천-8천으로 넣어 줘"}), config)
    assert _interrupt(out)["gate"] == "pf_confirm_2"
    assert fake.calls.count(PostingDraft) == 2


async def test_review_without_application_asks_to_pick(employer_graph):
    graph, _fake = employer_graph
    config = {"configurable": {"thread_id": "c4"}}
    out = await graph.ainvoke(
        {**BASE, "conversation_id": "c4", "start_flow": {"name": "review"}}, config
    )
    assert "지원자 목록에서 골라" in out["messages"][-1].content


async def test_interview_is_locked_below_pro():
    graph = build_harness_graph(REGISTRY["employer"], MemorySaver(), model=None, db=None, core=None)
    token = turn_model.set(FakeTurn())
    plan = bind_employer_plan("BASIC")
    try:
        out = await graph.ainvoke(
            {
                **BASE,
                "conversation_id": "c5",
                "start_flow": {"name": "interview", "application_id": "a1"},
            },
            {"configurable": {"thread_id": "c5"}},
        )
    finally:
        reset_employer_plan(plan)
        turn_model.reset(token)
    assert "Pro 요금제부터" in out["messages"][-1].content


def test_entry_tools_are_registered():
    names = {t.name for t in REGISTRY["employer"].tools}
    assert {"start_posting", "review_applicant", "prepare_interview"} <= names


def test_employer_start_reads_intent_and_conversation():
    from app.harness.runtime import employer_start

    conv = {"posting_id": "p1", "application_id": "a1"}
    assert employer_start({"intent": "posting"}, conv) == {
        "name": "posting",
        "reference_posting_id": "p1",
    }
    assert employer_start({"intent": "review"}, conv) == {"name": "review", "application_id": "a1"}
    assert employer_start({"intent": "general"}, conv) is None
    assert employer_start({}, conv) is None
