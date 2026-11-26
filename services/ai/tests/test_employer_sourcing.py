from __future__ import annotations

import pytest
from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import START, StateGraph
from langgraph.types import Command

from push_agent.harness.flows import Person, Shortlist, build_flows
from push_agent.harness.schemas import OfferDraft


def _graph(calls, messages, drafted: list | None = None, claim_gate=None):
    async def generate(schema, system, user):
        if schema is Shortlist:
            return Shortlist(
                people=[
                    Person(profile_id="p1", name="이하은", reasons=["결제 API 4년", "Kafka 운영"]),
                    Person(profile_id="ghost", name="목록에 없음", reasons=["x"]),
                ]
            )
        if schema is OfferDraft:
            if drafted is not None:
                drafted.append(user)
            # A list of one repeats, so a redo after a failed check gets the same message.
            return OfferDraft(message=messages.pop(0) if len(messages) > 1 else messages[0], reasons=["a", "b"])
        raise AssertionError(schema)

    async def call_tool(state, name, args, *, gate=None):
        calls.append((name, args))
        if name == "send_offer":
            assert gate is not None and gate[1] == "send", "a send carries the gate as its card"
        if name == "search_profiles":
            return {
                "data": {
                    "items": [
                        {"userId": "p1", "displayName": "이하은", "headline": "Kafka 운영 3년"},
                        {"userId": "p2", "displayName": "김민준"},
                    ]
                }
            }
        return {"data": {"id": "offer-1"}}

    state_type, flows = build_flows(
        db=None,
        generate_for=lambda _s: generate,
        research_text=None,
        plan_of=lambda _s: "PRO",
        call_tool=call_tool,
        claim_gate=claim_gate,
    )
    parent = StateGraph(state_type)
    parent.add_node("sourcing", flows["sourcing"])
    parent.add_edge(START, "sourcing")
    return parent.compile(checkpointer=MemorySaver())


async def _sub_flow(graph, config) -> dict:
    """The sourcing subgraph's flow while it waits at a gate (the parent sees it only at the end)."""
    snap = await graph.aget_state(config, subgraphs=True)
    return snap.tasks[0].state.values["flow"]


STATE = {
    "user_id": "u1",
    "conversation_id": "c1",
    "company_id": "co1",
    "job_id": "j1",
    "messages": [],
    "flow": {"name": "sourcing", "step": "start", "query": "결제 백엔드"},
}


async def test_shortlist_drops_people_not_in_search_and_sends_after_approval():
    calls: list = []
    graph = _graph(calls, ["결제 승인 API 경험을 보고 연락드려요."])
    config = {"configurable": {"thread_id": "s1"}}
    out = await graph.ainvoke(dict(STATE), config)
    gate = out["__interrupt__"][0].value
    assert gate["kind"] == "EMPLOYER_GATE" and gate["gate"] == "sc_shortlist"
    out = await graph.ainvoke(Command(resume={"option_ids": ["p1", "ghost"]}), config)
    assert out["__interrupt__"][0].value["gate"] == "sc_send"
    assert not any(name == "send_offer" for name, _ in calls), "nothing is sent before approval"
    out = await graph.ainvoke(Command(resume={"option_id": "send"}), config)
    sent = [args for name, args in calls if name == "send_offer"]
    assert sent == [
        {"profileId": "p1", "message": "결제 승인 API 경험을 보고 연락드려요.", "postingId": None}
    ]
    assert out["flow"]["status"] == "done" and "1명" in out["flow"]["reply"]


async def test_declining_the_send_gate_sends_nothing():
    calls: list = []
    graph = _graph(calls, ["안녕하세요"])
    config = {"configurable": {"thread_id": "s2"}}
    await graph.ainvoke(dict(STATE), config)
    await graph.ainvoke(Command(resume={"option_id": "p1"}), config)
    out = await graph.ainvoke(Command(resume={"option_id": "cancel"}), config)
    assert out["flow"]["status"] == "cancelled"
    assert not any(name == "send_offer" for name, _ in calls)


async def test_offer_with_discriminatory_wording_is_dropped():
    calls: list = []
    graph = _graph(calls, ["20대 젊은 분을 찾고 있어요."])
    config = {"configurable": {"thread_id": "s3"}}
    await graph.ainvoke(dict(STATE), config)
    out = await graph.ainvoke(Command(resume={"option_id": "p1"}), config)
    assert out["flow"]["status"] == "cancelled"
    assert not any(name == "send_offer" for name, _ in calls)


def test_runtime_forwards_multi_select_answers():
    from app.harness.runtime import _gate_answer

    assert _gate_answer({"optionIds": ["a", "b"]}) == {"option_id": None, "option_ids": ["a", "b"]}


async def test_unsupported_reason_is_dropped_and_the_person_stays():
    graph = _graph([], ["안녕하세요"])
    config = {"configurable": {"thread_id": "s4"}}
    out = await graph.ainvoke(dict(STATE), config)
    people = (await _sub_flow(graph, config))["people"]
    # "Kafka 운영" is in the profile; "결제 API 4년" is not.
    assert people == [{"profile_id": "p1", "name": "이하은", "reasons": ["Kafka 운영"]}]
    assert out["__interrupt__"][0].value["gate"] == "sc_shortlist"


async def test_offer_with_an_invented_number_is_redone_once_then_dropped():
    calls: list = []
    drafted: list = []
    graph = _graph(calls, ["팀원 40명과 함께 일해요."], drafted)
    config = {"configurable": {"thread_id": "s5"}}
    await graph.ainvoke(dict(STATE), config)
    out = await graph.ainvoke(Command(resume={"option_id": "p1"}), config)
    assert out["flow"]["status"] == "cancelled"
    assert len(drafted) == 2 and "40명" in drafted[1]


async def test_offer_redo_that_passes_is_kept_and_final_reply_has_the_shape():
    calls: list = []
    graph = _graph(calls, ["팀원 40명과 함께 일해요.", "Kafka 운영 경험을 보고 연락드려요."])
    config = {"configurable": {"thread_id": "s6"}}
    await graph.ainvoke(dict(STATE), config)
    await graph.ainvoke(Command(resume={"option_id": "p1"}), config)
    assert (await _sub_flow(graph, config))["drafts"][0]["message"] == "Kafka 운영 경험을 보고 연락드려요."
    out = await graph.ainvoke(Command(resume={"option_id": "send"}), config)
    reply = out["flow"]["reply"]
    assert reply.startswith("만든 것\n• 1명에게 제안을 보냈어요") and "\n\n다음\n• " in reply


async def test_offers_are_drafted_concurrently():
    import asyncio

    running, peak = 0, 0

    async def generate(schema, system, user):
        nonlocal running, peak
        if schema is Shortlist:
            return Shortlist(people=[Person(profile_id="p1", name="가"), Person(profile_id="p2", name="나")])
        running += 1
        peak = max(peak, running)
        await asyncio.sleep(0.01)
        running -= 1
        return OfferDraft(message="경험을 보고 연락드려요.")

    async def call_tool(state, name, args, **_kw):
        return {"data": {"items": [{"userId": "p1"}, {"userId": "p2"}]}}

    state_type, flows = build_flows(db=None, generate_for=lambda _s: generate, research_text=None,
                                    plan_of=lambda _s: "PRO", call_tool=call_tool)
    parent = StateGraph(state_type)
    parent.add_node("sourcing", flows["sourcing"])
    parent.add_edge(START, "sourcing")
    graph = parent.compile(checkpointer=MemorySaver())
    config = {"configurable": {"thread_id": "s7"}}
    await graph.ainvoke(dict(STATE), config)
    out = await graph.ainvoke(Command(resume={"option_ids": ["p1", "p2"]}), config)
    assert out["__interrupt__"][0].value["gate"] == "sc_send"
    assert peak == 2
    drafts = (await _sub_flow(graph, config))["drafts"]
    assert [d["profile_id"] for d in drafts] == ["p1", "p2"]


async def test_one_failing_offer_draft_leaves_the_other_and_names_the_skipped_person():
    async def generate(schema, system, user):
        if schema is Shortlist:
            return Shortlist(people=[Person(profile_id="p1", name="가"),
                                     Person(profile_id="p2", name="나")])
        if '"p2"' in user:
            raise RuntimeError("provider error")
        return OfferDraft(message="경험을 보고 연락드려요.")

    async def call_tool(state, name, args, **_kw):
        return {"data": {"items": [{"userId": "p1"}, {"userId": "p2"}]}}

    state_type, flows = build_flows(db=None, generate_for=lambda _s: generate, research_text=None,
                                    plan_of=lambda _s: "PRO", call_tool=call_tool)
    parent = StateGraph(state_type)
    parent.add_node("sourcing", flows["sourcing"])
    parent.add_edge(START, "sourcing")
    graph = parent.compile(checkpointer=MemorySaver())
    config = {"configurable": {"thread_id": "s8"}}
    await graph.ainvoke(dict(STATE), config)
    out = await graph.ainvoke(Command(resume={"option_ids": ["p1", "p2"]}), config)
    assert out["__interrupt__"][0].value["gate"] == "sc_send"
    flow = await _sub_flow(graph, config)
    assert [d["profile_id"] for d in flow["drafts"]] == ["p1"]
    assert flow["skipped"] == ["나: 제안 문구를 만들지 못했어요"]
    out = await graph.ainvoke(Command(resume={"option_id": "send"}), config)
    assert "나: 제안 문구를 만들지 못했어요" in out["flow"]["reply"]


@pytest.mark.parametrize(("reason", "profile", "grounded"), [
    ("5년 경력의 리더",
     {"userId": "u1", "name": "김", "headline": "신입 개발자", "bio": "의 리더십"}, False),
    ("headline", {"headline": "a"}, False),
    ("AWS", {"skills": ["AWS"]}, True),
    ("Go", {"skills": ["Go", "Rust"]}, True),
    ("Kafka 운영", {"headline": "Kafka 운영 3년"}, True),
    ("결제 API 4년", {"headline": "결제 API 3년"}, False),
])
def test_a_shortlist_reason_must_come_from_the_profile_values(reason, profile, grounded):
    from push_agent.harness.flows import _grounded

    assert _grounded(reason, profile) is grounded


async def test_the_shortlist_card_lets_the_employer_pick_several_people():
    graph = _graph([], ["안녕하세요"])
    config = {"configurable": {"thread_id": "s-multi"}}
    stream = graph.astream(dict(STATE), config, stream_mode="custom", subgraphs=True)
    cards = [event async for _ns, event in stream if event.get("type") == "choice"]
    assert [(card["gate"], card.get("multiple")) for card in cards] == [("sc_shortlist", True)]


async def test_a_send_gate_whose_answer_cannot_be_claimed_sends_nothing():
    calls: list = []
    claims: list = []

    async def claim_gate(state, card, option, shown):
        claims.append((option, shown))
        return False

    graph = _graph(calls, ["결제 승인 API 경험을 보고 연락드려요."], claim_gate=claim_gate)
    config = {"configurable": {"thread_id": "s-claim"}}
    await graph.ainvoke(dict(STATE), config)
    await graph.ainvoke(Command(resume={"option_ids": ["p1"]}), config)
    out = await graph.ainvoke(Command(resume={"option_id": "send"}), config)
    assert claims == [("send", {"offers": [
        {"profile_id": "p1", "message": "결제 승인 API 경험을 보고 연락드려요."}]})]
    assert not any(name == "send_offer" for name, _ in calls)
    assert out["flow"]["status"] == "cancelled"
