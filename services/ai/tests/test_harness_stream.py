from __future__ import annotations

from types import SimpleNamespace
from uuid import uuid4

from langchain_core.messages import AIMessage, AIMessageChunk, HumanMessage
from langgraph.checkpoint.memory import MemorySaver

from app.domain import entities as ent
from app.harness.graph import astream_harness, build_harness_graph
from app.harness.model import GateModel
from app.harness.tools import HarnessSpec
from tests.harness_fakes import USER, Gate, managed_ai


class _Chunks:
    def bind_tools(self, tools, **kwargs):
        return self

    async def astream(self, messages, **kwargs):
        yield AIMessageChunk(content="안")
        yield AIMessageChunk(content="녕")


class _Store:
    def __init__(self) -> None:
        self.settled: list = []

    async def settle(self, reservation_id, incoming, outgoing, cost) -> None:
        self.settled.append((incoming, outgoing))

    async def release(self, reservation_id) -> None:
        self.settled.append(("release", reservation_id))


class _Streaming:
    def __init__(self, **kwargs):
        self.kwargs = kwargs

    def bind_tools(self, tools, **kwargs):
        return self

    async def astream(self, messages, **kwargs):
        callbacks = (kwargs.get("config") or {}).get("callbacks") or []
        yield AIMessageChunk(content="안")
        yield AIMessageChunk(content="녕")
        message = AIMessage(
            content="안녕",
            usage_metadata={"input_tokens": 4, "output_tokens": 2, "total_tokens": 6},
        )
        response = SimpleNamespace(
            generations=[[SimpleNamespace(message=message)]], llm_output=None)
        for callback in callbacks:
            await callback.on_llm_end(response, run_id=uuid4())


async def test_one_reply_produces_multiple_token_events():
    graph = build_harness_graph(
        HarnessSpec(id="personal", prompt="help", tools=[]),
        MemorySaver(),
        model=_Chunks(),
        db=object(),
        core=object(),
    )
    events = []
    async for event in astream_harness(graph, {
        "messages": [HumanMessage(content="안녕")],
        "user_id": "user-1",
        "conversation_id": "conv-1",
        "job_id": "job-1",
        "access_mode": "AUTO",
        "tool_calls_used": 0,
    }, {"configurable": {"thread_id": "conv-1"}}):
        events.append(event)
    assert [event["token"] for event in events if "token" in event] == ["안", "녕"]


async def test_streamed_model_call_settles_usage_once():
    store = _Store()
    gate = Gate()
    gate.usage = store
    model = GateModel(
        gate, USER, ent.AiOptions(**managed_ai()), "job", {}, cls=_Streaming)
    parts = []
    async for chunk in model.astream([HumanMessage(content="안녕")]):
        parts.append(chunk.content)
    assert parts == ["안", "녕"]
    assert store.settled == [(4, 2)]
