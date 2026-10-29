from __future__ import annotations

import contextvars
import json
from typing import Annotated, Any, Final

from langchain_core.messages import AIMessage, SystemMessage, ToolMessage
from langchain_core.runnables.config import var_child_runnable_config
from langgraph.config import get_config, get_stream_writer
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages
from langgraph.types import Command, interrupt
from pydantic import ValidationError
from typing_extensions import TypedDict

from app.domain.access_mode import AccessMode
from app.framework.models import _content
from app.harness.approval import create_tool_approval
from app.harness.policy import decide
from app.harness.tools import ToolContext, call_structured, emit, to_structured_tool

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


class PersonalState(HarnessState, total=False):
    resume: dict | None


_FLOW_DONE = {
    "cancelled": "서류 작성을 그만뒀어요.",
    "done": "서류 작성을 끝냈어요.",
}


def enter_flow(name: str, **update) -> Command:
    return Command(update=update, goto=name)


def leave_flow(summary: str, **update) -> Command:
    return Command(
        update={"messages": [SystemMessage(content=summary)], **update},
        goto="agent",
    )


def _resume_dict(state: dict) -> dict:
    raw = state.get("resume") or {}
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except json.JSONDecodeError:
            return {}
    return raw if isinstance(raw, dict) else {}


def _route_resume(state: PersonalState) -> str:
    if _resume_dict(state).get("status") == "active":
        return "resume_flow"
    return "agent"


def _after_resume(state: PersonalState) -> str:
    if _resume_dict(state).get("status") == "active":
        return "resume_flow"
    return "agent"


def _public_resume(result: dict) -> dict:
    from app.harness.personal.resume.state import ResumeState

    return {key: result[key] for key in ResumeState.model_fields if key in result}


def _child_resume(state: dict) -> dict:
    child = dict(_resume_dict(state))
    for key in ("conversation_id", "user_id", "job_id", "access_mode"):
        if not child.get(key):
            child[key] = state.get(key) or ""
    child.setdefault("status", "active")
    child.setdefault("phase", "mode_select")
    return child


async def _mirror_resume(db, conversation_id: str | None, resume: dict) -> None:
    if db is None or not conversation_id:
        return
    await db.q().execute(
        "UPDATE conversations SET resume_state = $2::jsonb WHERE id = $1",
        conversation_id,
        json.dumps(resume, ensure_ascii=False),
    )


def _parts(call: Any) -> tuple[str, dict, str]:
    if isinstance(call, dict):
        return call["name"], call.get("args") or {}, call["id"]
    return call.name, call.args or {}, call.id


def _goto_after_tools(state: HarnessState, answered: set[str]) -> str:
    left = [call for call in _open_calls(state) if _parts(call)[2] not in answered]
    return "tools" if left else "agent"


def _tool_command(state: HarnessState, messages: list, answered: set[str], **update) -> Command:
    payload = {"messages": messages, **update}
    return Command(update=payload, goto=_goto_after_tools(state, answered))


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
    structured = {tool.name: to_structured_tool(tool) for tool in spec.tools}

    async def agent(state: HarnessState) -> dict:
        messages = list(state.get("messages") or [])
        if not messages or not isinstance(messages[0], SystemMessage):
            messages = [SystemMessage(content=spec.prompt), *messages]
        chat = turn_model.get() or model
        if int(state.get("tool_calls_used") or 0) >= _CAP:
            reply = await chat.ainvoke(messages)
            reply = AIMessage(content=reply.content)
        else:
            reply = await chat.bind_tools(list(structured.values())).ainvoke(messages)
        if not reply.tool_calls and _content(reply):
            emit({"token": _content(reply)})
        return {"messages": [reply]}

    async def tools(state: HarnessState) -> Command:
        pending = _open_calls(state)
        used = int(state.get("tool_calls_used") or 0)
        if used >= _CAP:
            # One step answers every remaining call, so the cap cannot exhaust the recursion limit.
            return _tool_command(state, [
                ToolMessage(content=_CAP_NOTE, tool_call_id=_parts(call)[2]) for call in pending
            ], {_parts(call)[2] for call in pending})
        name, raw_args, call_id = _parts(pending[0])
        tool = tools_by_name.get(name)
        bound = structured.get(name)
        if tool is None or bound is None:
            return _tool_command(
                state,
                [ToolMessage(content="unknown tool", tool_call_id=call_id)],
                {call_id},
                tool_calls_used=used + 1,
            )
        try:
            args = tool.args_model.model_validate(raw_args)
        except ValidationError:
            invalid = {"error": "INVALID_ARGS"}
            return _tool_command(
                state,
                [ToolMessage(content=json.dumps(invalid), tool_call_id=call_id)],
                {call_id},
                tool_calls_used=used + 1,
            )
        mode = AccessMode(state.get("access_mode") or AccessMode.AUTO)
        meta = bound.metadata
        summary = meta["summary"](args)
        tier = meta["tier"].value
        if decide(mode, bound).value == "ASK" and meta["approval_kind"] != "DOCUMENT_EDIT":
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
                emit(_tool_event(tool.name, "wait", summary, tier))
                emit(event)
            answer = interrupt({
                "approval_id": event["id"],
                "awaiting": "approval",
                "kind": "TOOL_ACTION",
            }) or {}
            if answer.get("option_id") != "approve":
                rejected = {"rejected": True}
                emit(_tool_event(tool.name, "err", summary, tier, rejected))
                return _tool_command(
                    state,
                    [ToolMessage(content=json.dumps(rejected), tool_call_id=call_id)],
                    {call_id},
                    tool_calls_used=used + 1,
                )
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
        result, ok = await call_structured(tool, args, ctx)
        if isinstance(result, Command):
            entered = {"entered": result.goto}
            emit(_tool_event(tool.name, "ok", summary, tier, entered))
            update = dict(result.update or {})
            update["messages"] = [
                *(update.get("messages") or []),
                ToolMessage(content=json.dumps(entered), tool_call_id=call_id),
            ]
            update["tool_calls_used"] = used + 1
            return Command(update=update, goto=result.goto)
        tool_state = "ok" if ok else "err"
        emit(_tool_event(tool.name, tool_state, summary, tier, result))
        return _tool_command(
            state,
            [ToolMessage(content=json.dumps(result), tool_call_id=call_id)],
            {call_id},
            tool_calls_used=used + 1,
        )

    def after_agent(state: HarnessState) -> str:
        return "tools" if _open_calls(state) else "end"

    use_resume = spec.id == "personal"
    if use_resume:
        from app.harness.personal.resume.graph import build_resume_graph

        subgraph = build_resume_graph(None, model=None, db=db)

        async def route(_state: PersonalState) -> dict:
            return {}

        async def resume_flow(state: PersonalState, config) -> dict | Command:
            parent_config = get_config()
            writer = get_stream_writer()
            result = None
            async for mode, chunk in subgraph.astream(
                _child_resume(state), config, stream_mode=["custom", "values"],
            ):
                if mode == "custom" and isinstance(chunk, dict):
                    token = var_child_runnable_config.set(parent_config)
                    try:
                        writer(chunk)
                    finally:
                        var_child_runnable_config.reset(token)
                elif mode == "values" and isinstance(chunk, dict):
                    result = chunk
            resume = _public_resume(result or {})
            await _mirror_resume(db, state.get("conversation_id"), resume)
            summary = _FLOW_DONE.get(str(resume.get("status") or ""))
            if summary is not None:
                return leave_flow(summary, resume=resume)
            return {"resume": resume}

    graph = StateGraph(PersonalState if use_resume else HarnessState)
    graph.add_node("agent", agent)
    graph.add_node("tools", tools)
    if use_resume:
        graph.add_node("route", route)
        graph.add_node("resume_flow", resume_flow)
        graph.add_edge(START, "route")
        graph.add_conditional_edges(
            "route", _route_resume, {"resume_flow": "resume_flow", "agent": "agent"})
        graph.add_conditional_edges(
            "resume_flow", _after_resume, {"resume_flow": "resume_flow", "agent": "agent"})
    else:
        graph.add_edge(START, "agent")
    graph.add_conditional_edges("agent", after_agent, {"tools": "tools", "end": END})
    return graph.compile(checkpointer=checkpointer)


async def astream_harness(graph, payload, config):
    async for mode, chunk in graph.astream(payload, config, stream_mode=["custom", "values"]):
        if mode == "custom" and isinstance(chunk, dict):
            yield chunk
            continue
        if mode == "values" and isinstance(chunk, dict) and chunk.get("__interrupt__"):
            yield {"type": "done", "awaiting": "approval"}
