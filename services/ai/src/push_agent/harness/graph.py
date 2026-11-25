"""The employer graph: the shared agent and tools nodes, routed through the employer flows."""

from __future__ import annotations

import hashlib
import json
from uuid import UUID

from langgraph.graph import END, START, StateGraph

from app.harness.approval import approval_id_for
from app.harness.binding import bound_services
from app.harness.graph import turn_model
from app.harness.memory import memory_update, merge_memory
from app.harness.status import acting_user, job_of
from app.harness.tools import ToolContext, call_structured, emit


async def record_gate_approval(db, ctx, tool, args) -> None:
    approval_id = UUID(approval_id_for(ctx.job_id, ctx.tool_call_id))
    await db.q().execute(
        "INSERT INTO approvals (id, user_id, kind, target_id, payload_hash, status, "
        "option_id, decided_at, conversation_id, title, tool_name, tool_args, tool_call_id, "
        "job_id, created_at) VALUES ($1,$2,'TOOL_ACTION',$1,$3,'APPROVED','approve',now(),"
        "$4,$5,$6,$7::jsonb,$8,$9,now()) "
        "ON CONFLICT (id) DO NOTHING",
        approval_id,
        UUID(ctx.user_id),
        hashlib.sha256(ctx.tool_call_id.encode()).hexdigest(),
        UUID(ctx.conversation_id),
        tool.summarize(args),
        tool.name,
        json.dumps(args.model_dump(mode="json"), ensure_ascii=False),
        ctx.tool_call_id,
        UUID(ctx.job_id),
    )


def build_employer_graph(agent, tools, after_agent, checkpointer, *, db, core=None,
                         tools_by_name=None):
    from langchain_core.messages import AIMessage

    from app.domain.employer_chat import current_employer_plan
    from push_agent.harness.flows import FLOWS, build_flows, flow_of, flow_summary
    from push_agent.harness.llm import gate_generate

    async def research_text(state, name):
        svc = bound_services.get()
        gate = getattr(svc, "ai", None) if svc is not None else None
        if gate is None:
            return ""
        return await gate.company_research(
            name, user_id=state.get("user_id"), job_id=job_of(state))

    def generate_for(_state):
        return gate_generate(turn_model.get())

    async def call_tool(state, name, args, *, approved: bool = False):
        """approved: the employer answered a flow gate that showed this exact write, so it counts
        as the card core asks for."""
        tool = (tools_by_name or {}).get(name)
        if tool is None:
            return {"error": "UNKNOWN_TOOL"}
        ctx = ToolContext(
            user_id=acting_user(state),
            company_id=state.get("company_id"),
            conversation_id=str(state.get("conversation_id") or ""),
            job_id=str(state.get("job_id") or ""),
            # One idempotency key per target, so each offer in a batch is its own write.
            tool_call_id="flow:" + name + ":" + json.dumps(args, sort_keys=True, default=str),
            db=db,
            core=core,
            access_mode=str(state.get("access_mode") or "AUTO"),
        )
        parsed = tool.args_model.model_validate(args)
        if approved:
            await record_gate_approval(db, ctx, tool, parsed)
        result, _ok = await call_structured(tool, parsed, ctx)
        return result

    state_type, flows = build_flows(
        db=db, generate_for=generate_for, research_text=research_text,
        plan_of=lambda _state: current_employer_plan() or "", call_tool=call_tool,
        model_for=lambda _state: turn_model.get())
    flow_nodes = {f"{name}_flow": f"{name}_flow" for name in FLOWS}

    def _target(state) -> str:
        flow = flow_of(state)
        if flow.get("name") in FLOWS and flow.get("status") not in ("done", "cancelled"):
            return f"{flow['name']}_flow"
        return "agent"

    async def route(state) -> dict:
        # A shared company thread grows with every member's turns; fold the old part like a
        # personal thread does, so each turn does not send the whole history.
        memory = await memory_update(
            list(state.get("messages") or []), state.get("summary") or "", turn_model.get())
        start = state.get("start_flow")
        if isinstance(start, dict) and start.get("name") in FLOWS and _target(state) == "agent":
            return merge_memory(memory, {"flow": {"step": "start", **start}, "start_flow": None})
        return merge_memory(memory, {"start_flow": None})

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
