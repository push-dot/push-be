from __future__ import annotations

import json
from itertools import pairwise
from typing import ClassVar

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage

from app.harness.memory import (
    COMPACT_ABOVE,
    KEEP_RECENT,
    SUMMARY_MAX,
    compact,
    estimate_tokens,
    message_text,
    plan_compaction,
)
from app.harness.registry import REGISTRY
from app.harness.runtime import HarnessRuntime
from app.harness.state import ThreadMemory
from tests.harness_fakes import CONV, USER, managed_ai, run, service


def _bulk(chars: int) -> str:
    return "가" * chars


def _human(text: str, mid: str) -> HumanMessage:
    return HumanMessage(content=text, id=mid)


def _ai(text: str, mid: str, calls: list | None = None) -> AIMessage:
    return AIMessage(content=text, id=mid, tool_calls=calls or [])


def _over_budget() -> list:
    messages = []
    for index in range(8):
        messages.append(_human(_bulk(8000), f"h{index}"))
        messages.append(_ai(_bulk(8000), f"a{index}"))
    return messages


def _held(messages: list, summary: str = "") -> int:
    body = sum(estimate_tokens(message_text(message)) for message in messages)
    return body + estimate_tokens(summary)


class _SummaryModel:
    def __init__(self, content: str = "사용자가 결정한 내용만 남겼어요."):
        self.content = content
        self.seen: list = []
        self.calls = 0

    async def ainvoke(self, messages, **kwargs):
        self.calls += 1
        self.seen.append(list(messages))
        return AIMessage(
            content=self.content,
            usage_metadata={"input_tokens": 3, "output_tokens": 2, "total_tokens": 5},
        )


class _Boom:
    async def ainvoke(self, messages, **kwargs):
        raise RuntimeError("down")


def test_thread_memory_state_has_summary():
    assert "summary" in ThreadMemory.__annotations__


def test_plan_is_none_at_the_budget():
    messages = [_human(_bulk(COMPACT_ABOVE * 2), "h0")]
    assert estimate_tokens(message_text(messages[0])) == COMPACT_ABOVE
    assert plan_compaction(messages, "") is None


def test_plan_counts_the_running_summary_toward_the_budget():
    body = _bulk((COMPACT_ABOVE - 4) * 2)
    messages = [_human(body, "h0"), _human("다음", "h1")]
    assert _held(messages) == COMPACT_ABOVE - 3
    assert plan_compaction(messages, _bulk(6)) is None
    cut = plan_compaction(messages, _bulk(6) + "가가")
    assert cut is not None and [message.id for message in cut] == ["h0"]
    wide = [_human(_bulk(COMPACT_ABOVE * 2), "h0"), _human("다음", "h1")]
    assert [message.id for message in plan_compaction(wide, "")] == ["h0"]


def _big_turns(count: int = 6) -> list:
    messages = []
    for index in range(count):
        messages.append(_human(_bulk(6000), f"h{index}"))
        messages.append(_ai(_bulk(6000), f"a{index}"))
    return messages


def _call(name: str, call_id: str) -> list:
    return [{"id": call_id, "name": name, "args": {}, "type": "tool_call"}]


def test_plan_keeps_a_tool_call_with_its_result():
    messages = _big_turns()
    messages.extend(
        [
            _human("도구 써", "ht"),
            _ai("호출", "at", _call("list_bookmarks", "call-1")),
            ToolMessage(content="결과", tool_call_id="call-1", id="tm"),
            _ai("끝", "af"),
            _human("최근", "hr"),
            _ai("답", "ar"),
        ]
    )
    prefix = plan_compaction(messages, "")
    assert prefix is not None
    ids = [message.id for message in prefix]
    assert ("at" in ids) == ("tm" in ids)


def test_plan_does_not_split_a_tool_call_across_the_cut():
    messages = _big_turns()
    messages.extend(
        [
            _human("도구", "ht"),
            _ai("호출", "at", _call("list_bookmarks", "call-1")),
            _human("끼임", "hm"),
            ToolMessage(content="결과", tool_call_id="call-1", id="tm"),
        ]
    )
    prefix = plan_compaction(messages, "")
    if prefix is None:
        return
    ids = [message.id for message in prefix]
    assert "at" not in ids or "tm" in ids


def test_plan_leaves_an_open_interrupt():
    messages = _big_turns()
    messages.extend(
        [
            _human("카드", "hp"),
            _ai("대기", "ap", _call("apply_to_posting", "call-park")),
        ]
    )
    prefix = plan_compaction(messages, "")
    assert prefix is not None
    ids = {message.id for message in prefix}
    assert "hp" not in ids and "ap" not in ids
    assert _held(messages[len(prefix) :]) <= KEEP_RECENT


async def test_compact_rewrites_the_summary_and_stops():
    model = _SummaryModel()
    messages = _over_budget()
    done = await compact(messages, "기존 요약", model)
    assert done is not None and done.remove_ids
    assert "결정" in done.summary
    assert "거절" in model.seen[0][0].content
    kept = [message for message in messages if message.id not in set(done.remove_ids)]
    assert await compact(kept, done.summary, model) is None


async def test_compact_continues_when_the_model_fails(caplog):
    caplog.set_level("WARNING")
    assert await compact(_over_budget(), "", _Boom()) is None
    assert "thread summary failed" in caplog.text


async def test_blank_summary_is_not_stored():
    assert await compact(_over_budget(), "", _SummaryModel("  ")) is None


async def test_summary_is_capped():
    done = await compact(_over_budget(), "", _SummaryModel(_bulk(SUMMARY_MAX * 4)))
    assert done is not None
    assert estimate_tokens(done.summary) <= SUMMARY_MAX


async def test_compact_skips_messages_without_ids():
    messages = _over_budget()
    messages[0].id = None
    assert await compact(messages, "", _SummaryModel()) is None


async def test_two_hundred_turns_stay_within_one_turn_of_the_budget():
    model = _SummaryModel()
    messages: list = []
    summary = ""
    sizes: list[int] = []
    for index in range(200):
        messages.append(_human(f"질문 {index} " + _bulk(500), f"h{index}"))
        messages.append(_ai(f"답변 {index} " + _bulk(500), f"a{index}"))
        sizes.append(_held(messages, summary))
        done = await compact(messages, summary, model)
        if done is None:
            continue
        drop = set(done.remove_ids)
        messages = [message for message in messages if message.id not in drop]
        summary = done.summary
        assert _held(messages) <= KEEP_RECENT
        assert estimate_tokens(summary) <= SUMMARY_MAX
    assert model.calls >= 1
    steps = [sizes[0], *[cur - prev for prev, cur in pairwise(sizes)]]
    assert max(sizes) <= COMPACT_ABOVE + max(step for step in steps if step > 0)


async def test_summary_call_uses_the_cheapest_pinned_model():
    seen: list = []

    class Recorder:
        def __init__(self, **kwargs):
            seen.append(kwargs.get("model"))

        async def ainvoke(self, messages, **kwargs):
            return AIMessage(
                content="결정만 남겼어요.",
                usage_metadata={"input_tokens": 4, "output_tokens": 2, "total_tokens": 6},
            )

    class GateLLM:
        def __init__(self):
            self.gate = object()
            self.cls = Recorder
            self.added: list = []

        def _add_usage(self, reply):
            self.added.append(reply.usage_metadata["input_tokens"])

    llm = GateLLM()
    done = await compact(_over_budget(), "기존 요약", llm)
    assert done is not None
    assert seen == ["deepseek/deepseek-v4.1-flash"]
    assert llm.added == [4]


class UsageLC:
    calls: ClassVar[list] = []
    models: ClassVar[list] = []
    seen: ClassVar[list] = []

    def __init__(self, **kwargs):
        UsageLC.models.append(kwargs.get("model"))

    def bind_tools(self, tools, **kwargs):
        return self

    async def ainvoke(self, messages, **kwargs):
        sent = sum(estimate_tokens(message_text(message)) for message in messages)
        UsageLC.calls.append(sent)
        UsageLC.seen.append(list(messages))
        return AIMessage(
            content="기억한 사실만 답해요.",
            usage_metadata={"input_tokens": sent, "output_tokens": 4, "total_tokens": sent + 4},
        )


async def _series(off: bool, monkeypatch):
    UsageLC.calls = []
    UsageLC.models = []
    UsageLC.seen = []
    if off:

        async def _off(messages, summary, llm):
            return None

        monkeypatch.setattr("app.harness.memory.compact", _off)
    svc = service()
    runtime = HarnessRuntime(svc, model_cls=UsageLC)
    agents: list[int] = []
    rows: list[int] = []
    for index in range(60):
        before = len(UsageLC.calls)
        settled = len(svc.ai.settled)
        await run(
            runtime,
            {
                "text": f"질문 {index} " + ("가" * 2400),
                "user_id": USER,
                "conversation_id": CONV,
                "job_id": f"{index:08d}-0000-4000-8000-000000000000",
                "access_mode": "AUTO",
                "ai": managed_ai(),
                "context": {},
            },
        )
        fresh = UsageLC.calls[before:]
        assert fresh, index
        assert len(svc.ai.settled) == settled + 1
        row = svc.ai.settled[-1][1]
        assert row == sum(fresh)
        agents.append(fresh[-1])
        rows.append(row)
    return runtime, agents, rows


async def test_sixty_turn_thread_stays_under_the_budget(monkeypatch):
    on_runtime, on_agent, on_row = await _series(False, monkeypatch)
    graph = on_runtime._graph(REGISTRY["personal"])
    values = (await graph.aget_state({"configurable": {"thread_id": str(CONV)}})).values
    summary = (values.get("summary") or "").strip()
    assert summary
    sent = UsageLC.seen[-1]
    assert isinstance(sent[0], SystemMessage)
    assert not str(sent[0].content).startswith(summary)
    assert isinstance(sent[1], SystemMessage) and sent[1].content == summary
    assert "deepseek/deepseek-v4.1-flash" in UsageLC.models
    stored = _held(values["messages"], summary)
    assert stored <= COMPACT_ABOVE + 20
    _, off_agent, off_row = await _series(True, monkeypatch)
    limit = COMPACT_ABOVE + COMPACT_ABOVE // 10
    assert all(tokens <= limit for tokens in on_agent)
    assert all(tokens <= limit for tokens in on_row)
    assert on_agent[59] * 5 <= off_agent[59] * 2
    assert on_row[59] * 5 <= off_row[59] * 2
    print(
        json.dumps(
            {
                "limit": limit,
                "on_agent_max": max(on_agent),
                "on_turn_60": on_agent[59],
                "off_turn_60": off_agent[59],
                "on_row_60": on_row[59],
                "off_row_60": off_row[59],
                "on_row_max": max(on_row),
            }
        )
    )
