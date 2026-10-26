from __future__ import annotations

import contextvars
import json
from typing import Annotated, Any, Final

from langchain_core.messages import AIMessage, SystemMessage, ToolMessage
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages
from langgraph.types import interrupt
from pydantic import ValidationError
from typing_extensions import TypedDict

from app.domain.access_mode import AccessMode
from app.framework.models import _content
from app.harness.approval import create_tool_approval
from app.harness.policy import decide
from app.harness.tools import ToolContext, emit, run_tool

_CAP = 8
_CAP_NOTE = "도구 호출 한도"
# Worst case is one agent and one tools step per counted call, plus the over-cap flush and final answer.
RECURSION_LIMIT: Final = 2 * _CAP + 4

turn_model: contextvars.ContextVar = contextvars.ContextVar("harness_turn_model", default=None)


class HarnessState(TypedDict, total=False):
    messages: Annotated[list, add_messages]
    user_id: str
    company_id: str | None
    conversation_id: str
    job_id: str
    access_mode: str
    tool_calls_used: int


def _parts(call: Any) -> tuple[str, dict, str]:
    if isinstance(call, dict):
        return call["name"], call.get("args") or {}, call["id"]
    return call.name, call.args or {}, call.id


def _open_calls(state: HarnessState) -> list:
    messages = state.get("messages") or []
    last_ai = None
    for message in messages:
        if isinstance(message, AIMessage) and message.tool_calls:
            last_ai = message
    if last_ai is None:
        return []
    answered = {
        message.tool_call_id
        for message in messages
        if isinstance(message, ToolMessage)
    }
    return [call for call in last_ai.tool_calls if call["id"] not in answered]


def _tool_event(name: str, state: str, summary: str, tier: str, result: dict | None = None) -> dict:
    event = {"type": "tool", "name": name, "state": state, "summary": summary, "tier": tier}
    if result is not None:
        event["result"] = result
    return event


def build_harness_graph(spec, checkpointer, *, model, db, core):
    tools_by_name = {tool.name: tool for tool in spec.tools}

    async def agent(state: HarnessState) -> dict:
        messages = list(state.get("messages") or [])
        if not messages or not isinstance(messages[0], SystemMessage):
            messages = [SystemMessage(content=spec.prompt), *messages]
        chat = turn_model.get() or model
        if int(state.get("tool_calls_used") or 0) >= _CAP:
            reply = await chat.ainvoke(messages)
            reply = AIMessage(content=reply.content)
        else:
            reply = await chat.bind_tools(spec.tools).ainvoke(messages)
        if not reply.tool_calls and _content(reply):
            emit({"token": _content(reply)})
        return {"messages": [reply]}

    async def tools(state: HarnessState) -> dict:
        pending = _open_calls(state)
        used = int(state.get("tool_calls_used") or 0)
        if used >= _CAP:
            # One step answers every remaining call, so the cap cannot exhaust the recursion limit.
            return {"messages": [
                ToolMessage(content=_CAP_NOTE, tool_call_id=_parts(call)[2]) for call in pending]}
        name, raw_args, call_id = _parts(pending[0])
        tool = tools_by_name.get(name)
        if tool is None:
            return {
                "messages": [ToolMessage(content="unknown tool", tool_call_id=call_id)],
                "tool_calls_used": used + 1,
            }
        try:
            args = tool.args_model.model_validate(raw_args)
        except ValidationError:
            invalid = {"error": "INVALID_ARGS"}
            return {
                "messages": [ToolMessage(content=json.dumps(invalid), tool_call_id=call_id)],
                "tool_calls_used": used + 1,
            }
        mode = AccessMode(state.get("access_mode") or AccessMode.AUTO)
        if decide(mode, tool.tier).value == "ASK" and tool.approval_kind != "DOCUMENT_EDIT":
            event, created = await create_tool_approval(
                db,
                user_id=state.get("user_id"),
                conversation_id=state.get("conversation_id"),
                job_id=state.get("job_id"),
                tool=tool,
                args=args,
                tool_call_id=call_id,
            )
            if created:
                emit(_tool_event(tool.name, "wait", tool.summarize(args), tool.tier.value))
                emit(event)
            answer = interrupt({
                "approval_id": event["id"],
                "awaiting": "approval",
                "kind": "TOOL_ACTION",
            }) or {}
            if answer.get("option_id") != "approve":
                rejected = {"rejected": True}
                emit(_tool_event(tool.name, "err", tool.summarize(args), tool.tier.value, rejected))
                return {
                    "messages": [ToolMessage(content=json.dumps(rejected), tool_call_id=call_id)],
                    "tool_calls_used": used + 1,
                }
        ctx = ToolContext(
            user_id=str(state.get("user_id") or ""),
            company_id=state.get("company_id"),
            conversation_id=str(state.get("conversation_id") or ""),
            job_id=str(state.get("job_id") or ""),
            tool_call_id=call_id,
            db=db,
            core=core,
            access_mode=mode.value,
        )
        result, ok = await run_tool(tool, ctx, args)
        tool_state = "ok" if ok else "err"
        emit(_tool_event(tool.name, tool_state, tool.summarize(args), tool.tier.value, result))
        return {
            "messages": [ToolMessage(content=json.dumps(result), tool_call_id=call_id)],
            "tool_calls_used": used + 1,
        }

    def after_agent(state: HarnessState) -> str:
        return "tools" if _open_calls(state) else "end"

    def after_tools(state: HarnessState) -> str:
        return "tools" if _open_calls(state) else "agent"

    graph = StateGraph(HarnessState)
    graph.add_node("agent", agent)
    graph.add_node("tools", tools)
    graph.add_edge(START, "agent")
    graph.add_conditional_edges("agent", after_agent, {"tools": "tools", "end": END})
    graph.add_conditional_edges("tools", after_tools, {"tools": "tools", "agent": "agent"})
    return graph.compile(checkpointer=checkpointer)


async def astream_harness(graph, payload, config):
    async for mode, chunk in graph.astream(payload, config, stream_mode=["custom", "values"]):
        if mode == "custom" and isinstance(chunk, dict):
            yield chunk
            continue
        if mode == "values" and isinstance(chunk, dict) and chunk.get("__interrupt__"):
            yield {"type": "done", "awaiting": "approval"}
