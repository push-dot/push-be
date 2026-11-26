from __future__ import annotations

import pytest
from langchain_core.messages import AIMessage
from langgraph.checkpoint.memory import MemorySaver
from langgraph.types import Command

from app.domain.employer_chat import bind_employer_plan, reset_employer_plan
from push_agent.harness.flows import RoleOption, RoleOptions
from push_agent.harness.schemas import CompanyProfile, PostingDraft, PostingReview, RoleSpec
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
    assert last.content.startswith("만든 것\n• 공고 초안: ")
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
    from push_agent.harness.spec import employer_start

    conv = {"posting_id": "p1", "application_id": "a1"}
    assert employer_start({"intent": "posting"}, conv) == {
        "name": "posting",
        "reference_posting_id": "p1",
        "asked": "",
    }
    assert employer_start({"intent": "review"}, conv) == {"name": "review", "application_id": "a1"}
    assert employer_start({"intent": "general"}, conv) is None
    assert employer_start({}, conv) is None


# ---- k-style: stage one, reviewers, late research, final replies ---------------------------------
import asyncio  # noqa: E402

from langgraph.graph import START, StateGraph  # noqa: E402

from push_agent.harness import flows as flows_module  # noqa: E402
from push_agent.harness.flows import Matches, build_flows  # noqa: E402
from push_agent.harness.schemas import Flag, Match, ReviewReport  # noqa: E402
from tests.kstyle_fakes import RoleModel  # noqa: E402

DOCS = "회사 A에서 주문 API를 3년 운영했어요. 장애 대응 문서를 직접 만들었어요."


class ReviewStore:
    async def application(self, app_id, company_id):
        return {"user_id": "u9", "job_category": "백엔드", "title": "주문 백엔드", "career_min": 3}

    async def snapshots(self, app_id, company_id):
        return [{"title": "이력서", "content": DOCS}]

    async def applicant_context(self, user_id):
        return None

    async def save_review(self, *args, **kwargs):
        return "rev-1"


def _sub(flow: str, flows, state_type):
    parent = StateGraph(state_type)
    parent.add_node(flow, flows[flow])
    parent.add_edge(START, flow)
    return parent.compile(checkpointer=MemorySaver())


async def _sub_flow(graph, config) -> dict:
    snap = await graph.aget_state(config, subgraphs=True)
    return snap.tasks[0].state.values["flow"]


async def test_review_runs_match_and_claims_together_and_checks_what_they_say():
    matched, claimed = asyncio.Event(), asyncio.Event()

    async def generate(schema, system, user):
        if schema is Matches:
            matched.set()
            await asyncio.wait_for(claimed.wait(), 1)  # deadlocks unless claims runs in the same stage
            return Matches(matches=[
                Match(requirement="API 운영", status="MET", evidence="주문 API를 3년  운영했어요"),
                Match(requirement="Kafka", status="MET", evidence="Kafka 5년"),
            ])
        if schema is ReviewReport:
            assert "[서류에서 확인된 주장]" in user and "E1" in user
            return ReviewReport(summary="", flags=[
                Flag(title="운영 기간", level="SUPPORTED", reason="주문 API를 5년 운영했어요."),
                Flag(title="역할", level="CHECK", reason="직접 한 일이 짧아요."),
            ])
        raise AssertionError(schema)

    async def claims(_messages):
        claimed.set()
        await asyncio.wait_for(matched.wait(), 1)
        return {"claims": [{"quote": "주문 API를 3년 운영했어요", "claim": "3년 운영"},
                           {"quote": "서류에 없는 문장이에요", "claim": "x"}]}

    model = RoleModel({
        "서류 주장 읽기": claims,
        "너는 완성된 검토 결과를": {"mismatches": [
            {"sentence": "운영 기간: 주문 API를 5년 운영했어요.", "problem": "서류는 3년"}]},
    })
    state_type, flows = build_flows(
        db=None, generate_for=lambda _s: generate, research_text=None, plan_of=lambda _s: "PRO",
        store=ReviewStore(), model_for=lambda _s: model)
    graph = _sub("review", flows, state_type)
    config = {"configurable": {"thread_id": "k1"}}
    out = await graph.ainvoke({**BASE, "flow": {"name": "review", "step": "start", "application_id": "a1"}}, config)
    assert _interrupt(out)["gate"] == "rv_report"
    flow = await _sub_flow(graph, config)
    assert [e["quote"] for e in flow["notes"]["evidence"]] == ["주문 API를 3년 운영했어요"]
    assert [m["status"] for m in flow["matches"]] == ["MET", "PARTIAL"]
    assert [f["title"] for f in flow["report"]["flags"]] == ["역할"]
    reply = flow["reply"]
    assert reply.split("\n\n")[0].startswith("만든 것\n• 요건 2개")
    assert "대신 정한 것\n• 비교할 참고 서류가 충분하지 않아" in reply
    assert "'일부'로 낮춘 요건: Kafka" in reply and "서류와 맞지 않아 뺀 항목: 운영 기간" in reply
    assert reply.endswith("다음\n• 면접 질문 만들기")


def _posting_generate(seen: list, review_draft=None):
    async def generate(schema, system, user):
        seen.append((schema, user))
        if schema is CompanyProfile:
            return CompanyProfile(name="회사 A")
        if schema is RoleOptions:
            return RoleOptions(options=[RoleOption(id="api", label="Kotlin API를 맡을 사람")])
        if schema is RoleSpec:
            return RoleSpec(need="Kotlin API", career_min=3, career_max=5, must_skills=["Kotlin"])
        draft = PostingDraft(title="API 엔지니어", requirements=["Kotlin 서버 개발 3년 이상"],
                             preferred=["Kafka"], career_min=3, career_max=5)
        if schema is PostingDraft:
            return draft
        if schema is PostingReview:
            return PostingReview(draft=review_draft or draft)
        raise AssertionError(schema)

    return generate


_STANCES = {"자격을 갖춘 지원자": {"objections": [{"target": "req0", "objection": "무슨 API인지 모호해요"}]},
            "채용 관리자의 동료": {"objections": [{"target": "nope", "objection": "대상 없음"}]}}


async def _posting_until_confirm(plan: str, model, thread: str, *, research_text=None, review_draft=None):
    seen: list = []

    async def no_research(_state, _name):
        return ""

    state_type, flows = build_flows(
        db=None, generate_for=lambda _s: _posting_generate(seen, review_draft),
        research_text=research_text or no_research, plan_of=lambda _s: plan, model_for=lambda _s: model)
    graph = _sub("posting", flows, state_type)
    config = {"configurable": {"thread_id": thread}}
    out = await graph.ainvoke({**BASE, "flow": {"name": "posting", "step": "start"}}, config)
    assert _interrupt(out)["gate"] == "pf_role"
    out = await graph.ainvoke(Command(resume={"text": "Kotlin API를 맡을 사람"}), config)
    assert _interrupt(out)["gate"] == "pf_confirm_1"
    return graph, config, seen


async def test_posting_reviewers_run_only_on_pro_and_above():
    model = RoleModel(dict(_STANCES))
    _graph, _config, seen = await _posting_until_confirm("BASIC", model, "k2")
    assert model.calls == []
    review_user = next(user for schema, user in seen if schema is PostingReview)
    assert "검토자 반대 의견" not in review_user

    model = RoleModel(dict(_STANCES))
    _graph, _config, seen = await _posting_until_confirm("PRO", model, "k3")
    assert sorted(role for role, _tier in model.calls) == ["자격을 갖춘 지원자", "채용 관리자의 동료"]
    review_user = next(user for schema, user in seen if schema is PostingReview)
    assert "Kotlin 서버 개발 3년 이상: 무슨 API인지 모호해요" in review_user
    assert "대상 없음" not in review_user


async def test_late_research_continues_and_the_save_reply_says_so(monkeypatch):
    monkeypatch.setattr(flows_module, "RESEARCH_SECONDS", 0.05)

    async def slow(_state, _name):
        await asyncio.sleep(5)
        return ""

    graph, config, seen = await _posting_until_confirm("BASIC", RoleModel({}), "k4", research_text=slow)
    assert CompanyProfile not in [schema for schema, _ in seen]
    assert (await _sub_flow(graph, config))["late"] == ["research"]
    out = await graph.ainvoke(Command(resume={"option_id": "save"}), config)
    reply = out["flow"]["reply"]
    assert reply.startswith("만든 것\n• 공고 초안: API 엔지니어")
    assert "대신 정한 것\n• 경력은 3~5년으로 잡았어요" in reply
    assert "확인이 필요한 점\n• 연봉 범위가 비어 있어요" in reply
    assert "회사 조사: 시간 안에 끝나지 않아 빼고 진행했어요" in reply
    assert ("다음\n• 아직 저장하지 않았어요. 공고 편집에서 열기를 눌러 저장하고 게시해 주세요"
            "\n\n```posting-draft") in reply


async def test_review_cutting_a_named_requirement_asks_once_in_the_confirm_title():
    cut = PostingDraft(title="API 엔지니어", requirements=["서버 개발 3년 이상"], preferred=["Kafka"])
    graph, config, _seen = await _posting_until_confirm("BASIC", RoleModel({}), "k5", review_draft=cut)
    flow = await _sub_flow(graph, config)
    assert flow["ask_lines"] == "1. Kotlin — 검수에서 뺐어요"
    assert flow["notes"]["ask"]["gate"] == "pf_confirm_1"
    out = await graph.ainvoke(Command(resume={"text": "Kotlin 다시 넣어 줘"}), config)
    assert _interrupt(out)["gate"] == "pf_confirm_2"
    assert (await _sub_flow(graph, config))["ask_lines"] == ""  # asked once per flow
    # Cut again after the one ask: the save reply still names it.
    out = await graph.ainvoke(Command(resume={"option_id": "save"}), config)
    assert "확인이 필요한 점\n" in out["flow"]["reply"]
    assert "말씀하신 요건 Kotlin: 검수에서 뺐어요" in out["flow"]["reply"]


async def test_interview_kit_keeps_only_questions_tied_to_a_flag():
    from push_agent.harness.schemas import InterviewKit, InterviewQuestion

    class KitStore(ReviewStore):
        saved = None

        async def latest_review(self, company_id, app_id):
            return {"id": "rev-1", "report": {"flags": [
                {"title": "역할", "level": "CHECK", "reason": "직접 한 일이 짧아요."}]}}

        async def save_kit(self, *args):
            KitStore.saved = args[-1]

    async def generate(schema, system, user):
        assert schema is InterviewKit
        return InterviewKit(questions=[
            InterviewQuestion(text="주문 API에서 직접 바꾼 부분을 설명해 주세요.", verify="본인 기여", from_flag="역할"),
            InterviewQuestion(text="가장 자랑스러운 일은요?", verify="x"),
            InterviewQuestion(text="팀 규모는요?", verify="x", from_flag="없는 항목"),
        ])

    state_type, flows = build_flows(db=None, generate_for=lambda _s: generate, research_text=None,
                                    plan_of=lambda _s: "PRO", store=KitStore())
    out = await _sub("interview", flows, state_type).ainvoke(
        {**BASE, "flow": {"name": "interview", "step": "start", "application_id": "a1"}},
        {"configurable": {"thread_id": "k6"}})
    assert [q["from_flag"] for q in KitStore.saved["questions"]] == ["역할"]
    reply = out["flow"]["reply"]
    assert reply.startswith("만든 것\n• 면접 질문 1개를 만들었어요")
    assert "확인이 필요한 점\n• 검토 항목에 묶이지 않은 질문 2개는 뺐어요" in reply


# ---- defects: a failed match, failed vs late stages, career line, kit ties, asks, numbers ---
async def _review(generate, model, thread: str, store=None):
    state_type, flows = build_flows(
        db=None, generate_for=lambda _s: generate, research_text=None, plan_of=lambda _s: "PRO",
        store=store or ReviewStore(), model_for=lambda _s: model)
    graph = _sub("review", flows, state_type)
    config = {"configurable": {"thread_id": thread}}
    out = await graph.ainvoke(
        {**BASE, "flow": {"name": "review", "step": "start", "application_id": "a1"}}, config)
    return graph, config, out


async def test_a_failed_requirement_match_stops_the_review_and_saves_nothing():
    saved = []

    class Store(ReviewStore):
        async def save_review(self, *args, **kwargs):
            saved.append(args)

    async def generate(schema, system, user):
        if schema is Matches:
            raise RuntimeError("provider error")
        return ReviewReport(summary="", flags=[])

    with pytest.raises(RuntimeError):
        await _review(generate, RoleModel({"서류 주장 읽기": {"claims": []}}), "d1", Store())
    assert saved == []


async def test_a_fact_check_fragment_shared_by_two_flags_drops_neither():
    async def generate(schema, system, user):
        if schema is Matches:
            return Matches(matches=[])
        return ReviewReport(summary="", flags=[
            Flag(title="운영 기간", level="SUPPORTED", reason="주문 API를 3년 운영했어요."),
            Flag(title="장애 대응", level="SUPPORTED", reason="장애 대응 문서를 운영했어요."),
        ])

    mismatch = {"mismatches": [{"sentence": "운영", "problem": "x"}]}
    model = RoleModel({"서류 주장 읽기": {"claims": []}, "너는 완성된 검토 결과를": mismatch})
    graph, config, _out = await _review(generate, model, "d2")
    flags = (await _sub_flow(graph, config))["report"]["flags"]
    assert [f["title"] for f in flags] == ["운영 기간", "장애 대응"]


async def test_a_mismatch_on_one_sentence_of_a_reason_keeps_the_flag_and_says_the_sentence():
    async def generate(schema, system, user):
        if schema is Matches:
            return Matches(matches=[])
        return ReviewReport(summary="", flags=[
            Flag(title="운영 기간", level="SUPPORTED",
                 reason="주문 API를 3년 운영했어요. 팀원 5명을 이끌었어요."),
        ])

    mismatch = {"mismatches": [{"sentence": "팀원 5명을 이끌었어요.", "problem": "서류에 없음"}]}
    model = RoleModel({"서류 주장 읽기": {"claims": []}, "너는 완성된 검토 결과를": mismatch})
    graph, config, _out = await _review(generate, model, "d5")
    flow = await _sub_flow(graph, config)
    assert [f["title"] for f in flow["report"]["flags"]] == ["운영 기간"]
    assert "서류와 맞지 않을 수 있는 문장: 팀원 5명을 이끌었어요." in flow["reply"]


async def test_a_stage_that_failed_is_not_reported_as_late():
    async def broken(_state, _name):
        raise ValueError("search broke")

    graph, config, _seen = await _posting_until_confirm(
        "BASIC", RoleModel({}), "d3", research_text=broken)
    out = await graph.ainvoke(Command(resume={"option_id": "save"}), config)
    reply = out["flow"]["reply"]
    assert "회사 조사: 끝내지 못해 빼고 진행했어요" in reply and "시간 안에" not in reply


async def _saved_reply(role: dict, draft: dict, requests=(), thread: str = "d4") -> str:
    state_type, flows = build_flows(
        db=None, generate_for=None, research_text=None, plan_of=lambda _s: "")
    flow = {"name": "posting", "step": "save", "role": RoleSpec(need="x", **role).model_dump(),
            "draft": PostingDraft(title="API 엔지니어", salary_range="협의", **draft).model_dump(),
            "requests": list(requests)}
    out = await _sub("posting", flows, state_type).ainvoke(
        {**BASE, "flow": flow}, {"configurable": {"thread_id": thread}})
    return out["flow"]["reply"]


@pytest.mark.parametrize(("role", "draft", "requests", "differs"), [
    ({"career_min": 3}, {"career_min": 3, "career_max": 0}, (), False),
    ({}, {"career_min": 0, "career_max": 0}, (), False),
    ({"career_min": 0, "career_max": 0}, {}, (), False),
    ({}, {"career_min": 3, "career_max": 5}, (), False),
    ({"career_min": 3, "career_max": 5}, {"career_min": 5}, ("경력 5년 이상으로",), False),
    ({"career_min": 3, "career_max": 5}, {"career_min": 7, "career_max": 10}, (), True),
])
async def test_the_career_line_names_only_a_real_difference(role, draft, requests, differs):
    reply = await _saved_reply(role, draft, requests)
    assert ("답한 경력 조건(3~5년)과 초안의" in reply) is differs


class _KitStore(ReviewStore):
    def __init__(self, flags):
        self.flags, self.saved = flags, []

    async def latest_review(self, company_id, app_id):
        return {"id": "rev-1", "report": {"flags": self.flags}}

    async def save_kit(self, *args):
        self.saved.append(args[-1])


async def _kit(flags: list[dict], from_flags: list[str | None]):
    from push_agent.harness.schemas import InterviewKit, InterviewQuestion

    calls = []

    async def generate(schema, system, user):
        calls.append(schema)
        return InterviewKit(questions=[
            InterviewQuestion(text=f"질문 {i}", verify="x", from_flag=flag)
            for i, flag in enumerate(from_flags)])

    store = _KitStore(flags)
    state_type, flows = build_flows(db=None, generate_for=lambda _s: generate, research_text=None,
                                    plan_of=lambda _s: "PRO", store=store)
    out = await _sub("interview", flows, state_type).ainvoke(
        {**BASE, "flow": {"name": "interview", "step": "start", "application_id": "a1"}},
        {"configurable": {"thread_id": "kit"}})
    return out["flow"]["reply"], store.saved, calls


_CHECKS = [{"title": "역할", "level": "CHECK", "reason": "직접 한 일이 짧아요."},
           {"title": "기간", "level": "CHECK", "reason": "기간이 겹쳐요."},
           {"title": "운영", "level": "SUPPORTED", "reason": "운영 문서가 있어요."}]


async def test_kit_titles_with_stray_spaces_or_quotes_keep_their_questions():
    reply, saved, _calls = await _kit(_CHECKS, ["역할 ", "'기간'", "운영"])
    assert [q["from_flag"] for q in saved[0]["questions"]] == ["역할", "기간"]
    assert reply.startswith("만든 것\n• 면접 질문 2개를 만들었어요")
    assert "검토 항목에 묶이지 않은 질문 1개는 뺐어요" in reply


async def test_kit_with_no_question_tied_saves_nothing_and_says_so():
    reply, saved, _calls = await _kit(_CHECKS, ["없는 항목", None])
    assert saved == []
    assert "질문을 검토 항목에 묶지 못해 만들지 못했어요" in reply
    assert "확인이 필요한 곳이 없어" not in reply and "묶었어요" not in reply
    assert "질문이 묶이지 않은 확인 항목: 역할" in reply


async def test_kit_without_check_flags_makes_no_model_call():
    reply, saved, calls = await _kit(_CHECKS[2:], ["운영"])
    assert calls == [] and saved == []
    assert "확인이 필요한 곳이 없어 질문을 만들지 않았어요" in reply


def test_a_skill_left_only_in_the_title_reads_as_cut_not_moved():
    from push_agent.harness.flows import _cut_asks

    before = PostingDraft(title="Kotlin 백엔드", requirements=["Kotlin 3년 이상", "Python"])
    after = PostingDraft(title="Kotlin 백엔드", requirements=["Python"])
    role = RoleSpec(need="Kotlin", must_skills=["Kotlin"])
    cut = [{"what": "Kotlin", "why": "검수에서 뺐어요"}]
    assert _cut_asks(before, after, role, "Kotlin 개발자") == cut


async def test_a_number_only_in_the_reference_posting_is_cut():
    draft = PostingDraft(title="API 엔지니어", requirements=["팀 40명과 일해요", "Kotlin 경험"])
    seen: list = []
    state_type, flows = build_flows(
        db=None, generate_for=lambda _s: _posting_generate(seen, draft), research_text=None,
        plan_of=lambda _s: "BASIC")
    graph = _sub("posting", flows, state_type)
    config = {"configurable": {"thread_id": "d5"}}
    flow = {"name": "posting", "step": "review", "need": "Kotlin API",
            "profile": CompanyProfile(name="회사 A").model_dump(by_alias=True),
            "role": RoleSpec(need="Kotlin API").model_dump(), "draft": draft.model_dump(),
            "reference": "누적 투자 200억, 팀 40명"}
    out = await graph.ainvoke({**BASE, "flow": flow}, config)
    assert _interrupt(out)["gate"] == "pf_confirm_1"
    assert (await _sub_flow(graph, config))["removed"] == ["팀 40명과 일해요"]


async def test_the_role_choices_start_from_this_turns_request_only():
    from langchain_core.messages import HumanMessage

    from push_agent.harness.flows import RoleOptions
    from push_agent.harness.spec import employer_start

    seen = []

    async def generate(schema, system, user):
        if schema is RoleOptions:
            seen.append(user)
            return RoleOptions(options=[{"id": "data", "label": "데이터 엔지니어"}])
        raise AssertionError(schema)

    state_type, flows = build_flows(
        db=None, generate_for=lambda _s: generate, research_text=None, plan_of=lambda _s: "PRO")
    graph = _sub("posting", flows, state_type)
    stale = HumanMessage(content="지난주에 물어본 프론트엔드 공고")
    typed = employer_start(
        {"intent": "posting", "text": "데이터 엔지니어 공고, 3년 이상, 서울"}, {})
    button = employer_start({"intent": "posting", "text": ""}, {})
    assert typed["asked"] == "데이터 엔지니어 공고, 3년 이상, 서울" and button["asked"] == ""
    for n, start in enumerate((typed, button)):
        flow = {**start, "step": "role_options", "profile": {"name": "에이전트테스트"}}
        out = await graph.ainvoke({**BASE, "messages": [stale], "flow": flow},
                                  {"configurable": {"thread_id": f"asked-{n}"}})
        assert _interrupt(out)["gate"] == "pf_role"
    assert "[담당자 요청]\n데이터 엔지니어 공고, 3년 이상, 서울" in seen[0]
    assert "[담당자 요청]\n없음" in seen[1]
    assert "프론트엔드" not in seen[1], "an older message is not this request"


def test_flow_calls_run_at_the_plan_effort_but_never_above_high(monkeypatch):
    from app.domain.entities import AiOptions
    from app.harness.model import GateModel
    from push_agent.harness import llm
    from push_agent.harness.graph import flow_generate

    monkeypatch.setattr(llm, "gate_generate", lambda model: model.ai.effort)
    for plan_effort, used in (("MEDIUM", "MEDIUM"), ("HIGH", "HIGH"), ("MAX", "HIGH")):
        ai = AiOptions(provider="OPENROUTER", model="m", effort=plan_effort)
        assert flow_generate(GateModel(None, "u", ai, "j", {})) == used, plan_effort
