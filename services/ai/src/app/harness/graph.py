from __future__ import annotations

import contextvars
import json
from functools import partial
from typing import Annotated, Any, Final

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_core.runnables.config import var_child_runnable_config
from langgraph.config import get_config, get_stream_writer
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages
from langgraph.types import Command, interrupt
from pydantic import ValidationError
from typing_extensions import TypedDict

from app.domain.access_mode import AccessMode
from app.framework.models import _content
from app.harness.approval import (
    APPROVE_ALWAYS,
    APPROVING,
    create_tool_approval,
    remember_site,
    site_granted,
    user_supplied,
)
from app.harness.policy import Decision, Tier, decide
from app.harness.status import thinking, waiting, working
from app.harness.tools import (
    RETRY_WARNING,
    ToolContext,
    call_retrying,
    call_structured,
    emit,
    to_structured_tool,
)

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
    bot: dict[str, Any] | None


class PersonalState(HarnessState, total=False):
    resume: dict | None
    intent: str | None
    context: dict | None
    quick_start: dict | None
    quick_start_done: bool


_FLOW_DONE = {
    "cancelled": "서류 작성을 그만뒀어요.",
    "done": "서류 작성을 끝냈어요.",
}


def enter_flow(name: str, **update) -> Command:
    return Command(update=update, goto=name)


_CARRY = ("inputs", "analysis", "drafts", "artifacts", "output_targets", "tone")


def _present(value: object) -> bool:
    return value not in (None, "", {}, [])


def _carried(current: dict) -> dict:
    return {key: current[key] for key in _CARRY if _present(current.get(key))}


def quick_start_resume(intent: object, current: dict | None = None) -> dict | None:
    if not isinstance(intent, str):
        return None
    current = current if isinstance(current, dict) else {}
    if intent == "match_posting":
        seed = {
            "status": "active", "phase": "intake",
            "work_mode": "resume_based", "scenario": "A",
        }
    elif intent == "fit":
        from app.harness.personal.resume.drafts import draft_text, drafts_from_chosen

        drafts = drafts_from_chosen(current.get("drafts"), current.get("inputs"))
        seed = {
            "status": "active",
            "phase": "analyze" if _present(current.get("inputs")) else "intake",
            "work_mode": "resume_based", "scenario": "E",
        }
        if draft_text(drafts):
            seed["drafts"] = drafts
    elif intent == "gaps":
        seed = {
            "status": "active",
            "phase": "strategy" if _present(current.get("analysis")) else "intake",
            "work_mode": "resume_based", "scenario": "A",
            "strategy": {"focus": "bottleneck", "steps": [1, 2, 3]},
        }
    elif intent == "experience":
        seed = {
            "status": "active",
            "phase": "approach" if _present(current.get("analysis")) else "intake",
            "work_mode": "experience_blueprint",
        }
    elif intent == "boost":
        from app.harness.personal.resume.drafts import draft_text

        drafts = current.get("drafts") if isinstance(current.get("drafts"), dict) else {}
        if draft_text(drafts):
            seed = {
                "status": "active", "phase": "craft", "work_mode": "resume_based",
                "goto": "p3c_boost",
            }
        else:
            seed = {"status": "active", "phase": "intake", "work_mode": "resume_based"}
    else:
        return None
    return {**_carried(current), **seed}


def write_needs_approval(mode, tier, quick_start, tool: str | None = None, *,
                         supplied: bool = False, granted: bool = False) -> bool:
    resolved = tier if isinstance(tier, Tier) or hasattr(tier, "metadata") else Tier(str(tier))
    return decide(mode, resolved, tool, quick_start=isinstance(quick_start, dict),
                  supplied=supplied, granted=granted) is Decision.ASK


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


def _human_text(state: dict) -> str:
    for message in reversed(state.get("messages") or []):
        if isinstance(message, HumanMessage):
            return _content(message)
    return ""


_RESUME_FIX = ("고쳐", "고치", "맞춰", "맞추", "개선", "tailor", "improve")


def _wants_resume_fix(text: str) -> bool:
    folded = text.casefold()
    return any(mark in folded for mark in _RESUME_FIX)


def _attachment_inputs(state: dict) -> dict:
    context = state.get("context") if isinstance(state.get("context"), dict) else {}
    attachments = []
    for item in context.get("evidenceIds") or []:
        text = str(item).strip()
        if text and text not in attachments:
            attachments.append(text)
    inputs = {"attachments": attachments}
    document_id = context.get("documentId")
    if document_id:
        inputs["documentId"] = str(document_id)
    return inputs


async def _resume_from_attachment(db, state: dict) -> dict | None:
    if state.get("intent"):
        return None
    if not _wants_resume_fix(_human_text(state)):
        return None
    inputs = _attachment_inputs(state)
    if not inputs.get("attachments") and not inputs.get("documentId"):
        return None
    from app.harness.personal.resume.profile_document import resolve_uploaded_source

    stamped = await resolve_uploaded_source(db, {"user_id": state.get("user_id"), "inputs": inputs})
    found = stamped.get("inputs") if isinstance(stamped, dict) else None
    if not isinstance(found, dict) or found.get("source") != "external":
        return None
    return quick_start_resume("match_posting", {"inputs": found})


def _route_resume(state: PersonalState) -> str:
    if state.get("quick_start_done"):
        return "end"
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


def _stream_writer():
    try:
        return get_stream_writer()
    except Exception:
        return lambda _chunk: None


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


def _tool_event(name: str, state: str, summary: str, tier: str, result: dict | None = None,
                retried: bool = False) -> dict:
    event = {"type": "tool", "name": name, "state": state, "summary": summary, "tier": tier}
    if result is not None:
        event["result"] = result
    if retried:
        event["warning"] = RETRY_WARNING
    return event


def _tool_chunk(chunk) -> bool:
    return bool(getattr(chunk, "tool_call_chunks", None) or getattr(chunk, "tool_calls", None))


async def _complete(chat, messages, *, text_only: bool = False):
    stream = getattr(chat, "astream", None)
    if stream is None:
        reply = await chat.ainvoke(messages)
    else:
        reply = None
        saw_tool = False
        async for chunk in stream(messages):
            if not text_only:
                if _tool_chunk(chunk):
                    saw_tool = True
                elif not saw_tool and _content(chunk):
                    emit({"token": _content(chunk)})
            reply = chunk if reply is None else reply + chunk
    if text_only and reply is not None:
        reply = AIMessage(content=_content(reply))
    one_shot = stream is None or text_only
    if (
        one_shot
        and reply is not None
        and not getattr(reply, "tool_calls", None)
        and _content(reply)
    ):
        emit({"token": _content(reply)})
    return reply


def bot_prompt(prompt: str, bot: dict[str, Any] | None) -> str:
    """The system prompt of a thread. A bot thread exists only in the app, where the model is a
    봇 and never an 에이전트, so the bot's line takes the place of the prompt's first line. The app
    also says 플랜 where the web says 요금제."""
    if not bot:
        return prompt
    # Names and titles are written by users and employers. Quoted, they stay data.
    quote = partial(json.dumps, ensure_ascii=False)
    if bot.get("kind") == "push":
        name, helps = "Push Bot", "구직자의 커리어를"
    else:
        name = f"{bot.get('name') or bot.get('company')} 봇"
        helps = f"{quote(bot.get('company') or '')} 회사에 지원하는 구직자를"
    line = f"당신은 Push에서 {helps} 돕는 {quote(name)}이에요."
    if bot.get("postingId"):
        title = quote(bot.get("postingTitle") or "제목 없음")
        line += f" 기준 공고: {title} (posting_id {bot['postingId']})."
    line += f" 자신을 말할 때는 {quote(name)}이나 봇이라고 하고, 에이전트라고 하지 않아요."
    return line + "\n" + prompt.partition("\n")[2].replace("요금제", "플랜")


def build_harness_graph(spec, checkpointer, *, model, db, core):
    tools_by_name = {tool.name: tool for tool in spec.tools}
    structured = {tool.name: to_structured_tool(tool) for tool in spec.tools}
    progress: dict[str, str] = {}
    labels: dict[str, str] = {}
    if spec.id == "personal":
        from app.harness.personal.tools import CARD_LABEL as labels
        from app.harness.personal.tools import PROGRESS as progress

    async def agent(state: HarnessState) -> dict:
        messages = list(state.get("messages") or [])
        content = spec.prompt
        if spec.id == "personal":
            from app.harness.personal.reference import reference_lines
            content = bot_prompt(content, state.get("bot"))
            try:
                lines = await reference_lines(
                    db, state.get("user_id"), state.get("conversation_id"))
            except Exception:
                lines = []
            if lines:
                content = content.rstrip() + "\n\n" + "\n".join(lines)
            quick = state.get("quick_start")
            if isinstance(quick, dict) and quick.get("instruction"):
                sheet = json.dumps(quick.get("inputs") or {}, ensure_ascii=False)
                content = content.rstrip() + "\n\n" + quick["instruction"] + "\n시트 입력: " + sheet
        if not messages or not isinstance(messages[0], SystemMessage):
            messages = [SystemMessage(content=content), *messages]
        chat = turn_model.get() or model
        over = int(state.get("tool_calls_used") or 0) >= _CAP
        target = chat if over else chat.bind_tools(list(structured.values()))
        thinking()
        reply = await _complete(target, messages, text_only=over)
        return {"messages": [reply]} if reply is not None else {}

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
        # shortcut: an outside read goes out as READ, because the api-client's ToolTier has three
        # values and may not change shape before push-fe F3. Send EXTERNAL_READ once it knows it.
        tier = (Tier.READ if meta["tier"] is Tier.EXTERNAL_READ else meta["tier"]).value
        page = {}
        if meta["tier"] is Tier.EXTERNAL_READ:
            thread = state.get("conversation_id")
            page = {
                "supplied": await user_supplied(db, thread, state.get("user_id"), args.url),
                "granted": await site_granted(db, thread, args.url),
            }
        if (
            write_needs_approval(mode, meta["tier"], state.get("quick_start"), tool.name, **page)
            and meta["approval_kind"] != "DOCUMENT_EDIT"
        ):
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
                waiting(event["id"], "confirm", labels.get(tool.name))
                emit(event)
            answer = interrupt({
                "approval_id": event["id"],
                "awaiting": "approval",
                "kind": "TOOL_ACTION",
            }) or {}
            if answer.get("option_id") not in APPROVING:
                rejected = {"rejected": True}
                emit(_tool_event(tool.name, "err", summary, tier, rejected))
                return _tool_command(
                    state,
                    [ToolMessage(content=json.dumps(rejected), tool_call_id=call_id)],
                    {call_id},
                    tool_calls_used=used + 1,
                )
            if answer.get("option_id") == APPROVE_ALWAYS:
                await remember_site(db, state.get("conversation_id"), args.url)
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
        if tool.name in progress:
            working(progress[tool.name])
        emit(_tool_event(tool.name, "run", summary, tier))
        result, ok, retried = await call_retrying(tool, args, ctx)
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
        emit(_tool_event(tool.name, tool_state, summary, tier, result, retried))
        return _tool_command(
            state,
            [ToolMessage(content=json.dumps(result), tool_call_id=call_id)],
            {call_id},
            tool_calls_used=used + 1,
        )

    def after_agent(state: HarnessState) -> str:
        return "tools" if _open_calls(state) else "end"

    if spec.id == "employer":
        return _build_employer_graph(
            agent, tools, after_agent, checkpointer, db=db, core=core, tools_by_name=tools_by_name)

    use_resume = spec.id == "personal"
    if use_resume:
        from app.harness.personal.resume.graph import build_resume_graph

        subgraph = build_resume_graph(None, model=None, db=db)

        async def route(state: PersonalState) -> dict | Command:
            if _resume_dict(state).get("status") == "active":
                return {}
            if state.get("quick_start_done"):
                return {}
            seed = quick_start_resume(state.get("intent"), _resume_dict(state))
            if seed is not None:
                return enter_flow("resume_flow", resume=seed)
            attached = await _resume_from_attachment(db, state)
            if attached is not None:
                return enter_flow("resume_flow", resume=attached)
            from app.domain.quick_starts import quick_start_seed

            started = quick_start_seed(
                state.get("intent"), _human_text(state), state.get("context") or {})
            if started is None:
                return {}
            if started["intent"] == "find_postings":
                from app.domain.services import posting_match as matching

                result = await matching.run_quick_match(
                    db,
                    state.get("user_id"),
                    started["inputs"],
                    job_id=state.get("job_id"),
                ) or {}
                text_out = result.get("text") or "조건에 맞는 공고가 없어요."
                payload = {"items": result.get("items") or [], "text": text_out}
                emit(_tool_event(
                    "find_matching_postings", "ok", "공고를 찾아요", Tier.READ.value, payload))
                emit({"token": text_out})
                return Command(
                    update={
                        "messages": [AIMessage(content=text_out)],
                        "quick_start_done": True,
                    },
                    goto=END,
                )
            return {"quick_start": started}

        async def resume_flow(state: PersonalState, config) -> dict | Command:
            parent_config = get_config()
            writer = _stream_writer()
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
            "route", _route_resume,
            {"resume_flow": "resume_flow", "agent": "agent", "end": END})
        graph.add_conditional_edges(
            "resume_flow", _after_resume, {"resume_flow": "resume_flow", "agent": "agent"})
    else:
        graph.add_edge(START, "agent")
    graph.add_conditional_edges("agent", after_agent, {"tools": "tools", "end": END})
    return graph.compile(checkpointer=checkpointer)


def _build_employer_graph(agent, tools, after_agent, checkpointer, *, db, core=None,
                          tools_by_name=None):
    from langchain_core.messages import AIMessage

    from app.domain.employer_chat import current_employer_plan
    from app.harness.employer.flows import FLOWS, build_flows, flow_of, flow_summary
    from app.harness.employer.llm import gate_generate

    async def research_text(state, name):
        from app.harness.personal.tools import bound_services

        svc = bound_services.get()
        gate = getattr(svc, "ai", None) if svc is not None else None
        if gate is None:
            return ""
        return await gate.company_research(
            name, user_id=state.get("user_id"), job_id=state.get("job_id"))

    def generate_for(_state):
        return gate_generate(turn_model.get())

    async def call_tool(state, name, args):
        tool = (tools_by_name or {}).get(name)
        if tool is None:
            return {"error": "UNKNOWN_TOOL"}
        ctx = ToolContext(
            user_id=str(state.get("user_id") or ""),
            company_id=state.get("company_id"),
            conversation_id=str(state.get("conversation_id") or ""),
            job_id=str(state.get("job_id") or ""),
            # One idempotency key per target, so each offer in a batch is its own write.
            tool_call_id="flow:" + name + ":" + json.dumps(args, sort_keys=True, default=str),
            db=db,
            core=core,
            access_mode=str(state.get("access_mode") or "AUTO"),
        )
        result, _ok = await call_structured(tool, tool.args_model.model_validate(args), ctx)
        return result

    state_type, flows = build_flows(
        db=db, generate_for=generate_for, research_text=research_text,
        plan_of=lambda _state: current_employer_plan() or "", call_tool=call_tool)
    flow_nodes = {f"{name}_flow": f"{name}_flow" for name in FLOWS}

    def _target(state) -> str:
        flow = flow_of(state)
        if flow.get("name") in FLOWS and flow.get("status") not in ("done", "cancelled"):
            return f"{flow['name']}_flow"
        return "agent"

    async def route(state) -> dict:
        start = state.get("start_flow")
        if isinstance(start, dict) and start.get("name") in FLOWS and _target(state) == "agent":
            return {"flow": {"step": "start", **start}, "start_flow": None}
        return {"start_flow": None}

    async def leave(state) -> dict:
        flow = flow_of(state)
        reply = flow.get("reply") or flow_summary(flow)
        if not flow.get("reply"):
            emit({"token": reply})
        return {"messages": [AIMessage(content=reply)], "flow": None}

    def after_flow(state) -> str:
        target = _target(state)
        return "leave" if target == "agent" else target

    graph = StateGraph(state_type)
    graph.add_node("route", route)
    graph.add_node("agent", agent)
    graph.add_node("tools", tools)
    graph.add_node("leave", leave)
    for name, sub in flows.items():
        graph.add_node(f"{name}_flow", sub)
        graph.add_conditional_edges(f"{name}_flow", after_flow, {**flow_nodes, "leave": "leave"})
    graph.add_edge(START, "route")
    graph.add_conditional_edges("route", _target, {**flow_nodes, "agent": "agent"})
    graph.add_edge("leave", END)
    graph.add_conditional_edges("agent", after_agent, {"tools": "tools", "end": END})
    return graph.compile(checkpointer=checkpointer)


async def astream_harness(graph, payload, config):
    async for mode, chunk in graph.astream(payload, config, stream_mode=["custom", "values"]):
        if mode == "custom" and isinstance(chunk, dict):
            yield chunk
            continue
        if mode == "values" and isinstance(chunk, dict) and chunk.get("__interrupt__"):
            yield {"type": "done", "awaiting": "approval"}
