from __future__ import annotations

from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import START, StateGraph
from langgraph.types import Command

from app.harness.employer.flows import Person, Shortlist, build_flows
from app.harness.employer.schemas import OfferDraft


def _graph(calls, messages):
    async def generate(schema, system, user):
        if schema is Shortlist:
            return Shortlist(
                people=[
                    Person(profile_id="p1", name="이하은", reasons=["결제 API 4년", "Kafka 운영"]),
                    Person(profile_id="ghost", name="목록에 없음", reasons=["x"]),
                ]
            )
        if schema is OfferDraft:
            return OfferDraft(message=messages.pop(0), reasons=["a", "b"])
        raise AssertionError(schema)

    async def call_tool(state, name, args):
        calls.append((name, args))
        if name == "search_profiles":
            return {
                "data": {
                    "items": [
                        {"userId": "p1", "displayName": "이하은"},
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
    )
    parent = StateGraph(state_type)
    parent.add_node("sourcing", flows["sourcing"])
    parent.add_edge(START, "sourcing")
    return parent.compile(checkpointer=MemorySaver())


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
    import inspect

    from app.harness import runtime

    assert '"option_ids"' in inspect.getsource(runtime)
