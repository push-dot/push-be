from __future__ import annotations

from langgraph.checkpoint.memory import MemorySaver

from app.domain.errors import DomainError
from app.harness.graph import build_harness_graph
from app.harness.policy import Tier
from app.harness.tools import HarnessSpec, ToolContext, ToolSpec
from tests.fakes import ScriptedChat
from tests.test_harness_graph import IdArgs, MemApprovals, _call, _events, _input


def _graph(tier: Tier, failures: list[Exception]):
    calls = []

    async def run(_ctx: ToolContext, args: IdArgs) -> dict:
        calls.append(args.id)
        if failures:
            raise failures.pop(0)
        return {"items": []}

    spec = HarnessSpec(
        id="personal",
        prompt="help",
        tools=[
            ToolSpec("list_bookmarks", tier, IdArgs, run, lambda _args: "저장한 공고를 봐요"),
        ],
    )
    model = ScriptedChat([{"tool_calls": [_call("list_bookmarks", "c1")]}, {"content": "ok"}])
    graph = build_harness_graph(spec, MemorySaver(), model=model, db=MemApprovals(), core=object())
    return graph, calls


def _line(events):
    tools = [event for event in events if event.get("type") == "tool"]
    assert tools[0]["state"] == "run"
    return tools[-1]


async def test_a_read_that_fails_once_is_retried_and_flagged():
    graph, calls = _graph(Tier.READ, [ValueError("timeout")])
    line = _line(await _events(graph, _input("BYPASS")))
    assert len(calls) == 2
    assert line["state"] == "ok"
    assert line["warning"] == "시간이 오래 걸려서 한 번 더 시도했어요"


async def test_a_read_that_fails_twice_stays_an_error_with_the_warning():
    graph, calls = _graph(Tier.READ, [ValueError("a"), ValueError("b")])
    line = _line(await _events(graph, _input("BYPASS")))
    assert len(calls) == 2
    assert (line["state"], line["warning"]) == ("err", "시간이 오래 걸려서 한 번 더 시도했어요")


async def test_a_known_error_or_a_write_is_not_retried():
    graph, calls = _graph(Tier.READ, [DomainError(404, "NOT_FOUND", "gone")])
    assert "warning" not in _line(await _events(graph, _input("BYPASS")))
    assert len(calls) == 1
    graph, calls = _graph(Tier.SAFE_WRITE, [ValueError("timeout")])
    assert "warning" not in _line(await _events(graph, _input("BYPASS")))
    assert len(calls) == 1
