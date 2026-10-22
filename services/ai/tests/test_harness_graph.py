from __future__ import annotations

import json

from langchain_core.messages import HumanMessage, ToolMessage
from langgraph.checkpoint.memory import MemorySaver
from langgraph.types import Command
from pydantic import BaseModel

from app.harness.core_client import CoreError
from app.harness.graph import astream_harness, build_harness_graph
from app.harness.policy import Tier
from app.harness.tools import HarnessSpec, ToolContext, ToolSpec
from tests.fakes import ScriptedChat


class IdArgs(BaseModel):
    id: str


class MemApprovals:
    def __init__(self):
        self.rows = []

    def q(self):
        return self

    async def fetchrow(self, sql, *args):
        wanted = str(args[0])
        for row in self.rows:
            if str(row["id"]) == wanted:
                return row
        return None

    async def execute(self, sql, *args):
        self.rows.append({"id": args[0], "sql": sql, "kind": "TOOL_ACTION"})
        return "INSERT 1"


def _call(name: str, call_id: str, posting: str = "p1") -> dict:
    return {"name": name, "args": {"id": posting}, "id": call_id, "type": "tool_call"}


def _spec(runs: list, bookmark_error: Exception | None = None) -> HarnessSpec:
    async def bookmark(ctx: ToolContext, args: IdArgs) -> dict:
        if bookmark_error is not None:
            raise bookmark_error
        runs.append(("bookmark", args.id))
        return {"bookmarked": True}

    async def apply(ctx: ToolContext, args: IdArgs) -> dict:
        runs.append(("apply", args.id))
        return {"applied": True}

    def summary(args: IdArgs) -> str:
        return args.id

    return HarnessSpec(
        id="personal",
        audience="PERSONAL",
        prompt="help",
        tools=[
            ToolSpec("bookmark_posting", Tier.SAFE_WRITE, IdArgs, bookmark, summary),
            ToolSpec("apply_to_posting", Tier.RISKY_WRITE, IdArgs, apply, summary),
        ],
    )


def _graph(model, runs, bookmark_error=None):
    db = MemApprovals()
    graph = build_harness_graph(
        _spec(runs, bookmark_error),
        MemorySaver(),
        model=model,
        db=db,
        core=object(),
    )
    return graph, db


def _config():
    return {"configurable": {"thread_id": "conv-1"}}


def _input(mode: str, text: str = "hi") -> dict:
    return {
        "messages": [HumanMessage(content=text)],
        "user_id": "user-1",
        "company_id": None,
        "conversation_id": "conv-1",
        "job_id": "job-1",
        "access_mode": mode,
        "tool_calls_used": 0,
    }


async def _events(graph, payload):
    out = []
    async for event in astream_harness(graph, payload, _config()):
        out.append(event)
    return out


async def test_auto_runs_safe_and_asks_risky():
    runs = []
    model = ScriptedChat([
        {"tool_calls": [_call("bookmark_posting", "c1"), _call("apply_to_posting", "c2")]},
        {"content": "waiting"},
    ])
    graph, db = _graph(model, runs)
    events = await _events(graph, _input("AUTO"))
    assert runs == [("bookmark", "p1")]
    assert len(db.rows) == 1
    assert "TOOL_ACTION" in db.rows[0]["sql"]
    assert any(event.get("type") == "done" and event.get("awaiting") == "approval" for event in events)
    approval = next(event for event in events if event.get("type") == "approval")
    assert approval["kind"] == "TOOL_ACTION"
    assert approval["options"] == [{"id": "approve", "label": "실행"}, {"id": "reject", "label": "취소"}]
    assert approval["toolName"] == "apply_to_posting"


async def test_resume_approve_executes_once():
    runs = []
    model = ScriptedChat([
        {"tool_calls": [_call("apply_to_posting", "c2")]},
        {"content": "done"},
    ])
    graph, db = _graph(model, runs)
    await _events(graph, _input("AUTO"))
    assert runs == []
    events = await _events(graph, Command(resume={"option_id": "approve"}))
    assert runs == [("apply", "p1")]
    assert any(event.get("type") == "tool" and event.get("state") == "ok" for event in events)
    assert len(db.rows) == 1


async def test_resume_reject_skips():
    runs = []
    model = ScriptedChat([
        {"tool_calls": [_call("apply_to_posting", "c2")]},
        {"content": "skipped"},
    ])
    graph, _db = _graph(model, runs)
    await _events(graph, _input("AUTO"))
    await _events(graph, Command(resume={"option_id": "reject"}))
    assert runs == []
    tool_messages = [
        message for message in model.seen[-1]
        if isinstance(message, ToolMessage)
    ]
    assert json.loads(tool_messages[-1].content) == {"rejected": True}


async def test_bypass_never_interrupts():
    runs = []
    model = ScriptedChat([
        {"tool_calls": [_call("bookmark_posting", "c1"), _call("apply_to_posting", "c2")]},
        {"content": "done"},
    ])
    graph, db = _graph(model, runs)
    events = await _events(graph, _input("BYPASS"))
    assert runs == [("bookmark", "p1"), ("apply", "p1")]
    assert db.rows == []
    assert not any(event.get("type") == "done" for event in events)


async def test_always_ask_asks_safe_write():
    runs = []
    model = ScriptedChat([
        {"tool_calls": [_call("bookmark_posting", "c1")]},
        {"content": "waiting"},
    ])
    graph, db = _graph(model, runs)
    events = await _events(graph, _input("ALWAYS_ASK"))
    assert runs == []
    assert len(db.rows) == 1
    assert any(event.get("type") == "tool" and event.get("state") == "wait" and event.get("tier") == "SAFE_WRITE" for event in events)


async def test_tool_cap_8():
    runs = []
    calls = [_call("bookmark_posting", f"c{i}", f"p{i}") for i in range(10)]
    model = ScriptedChat([{"tool_calls": calls}, {"content": "한도"}])
    graph, _db = _graph(model, runs)
    await _events(graph, _input("BYPASS"))
    assert len(runs) == 8
    assert "도구 호출 한도" in model.seen[-1][-1].content or any(
        isinstance(message, ToolMessage) and "도구 호출 한도" in message.content
        for message in model.seen[-1]
    )


async def test_core_error_becomes_tool_result():
    runs = []
    model = ScriptedChat([
        {"tool_calls": [_call("bookmark_posting", "c1")]},
        {"content": "cannot"},
    ])
    graph, _db = _graph(model, runs, CoreError(403, "FORBIDDEN", "no"))
    events = await _events(graph, _input("BYPASS"))
    assert runs == []
    assert any(event.get("result") == {"error": "FORBIDDEN"} for event in events)
    assert model.seen[-1][-1].content
    assert "FORBIDDEN" in model.seen[-1][-1].content
