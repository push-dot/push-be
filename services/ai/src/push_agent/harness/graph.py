"""The employer graph: the shared agent and tools nodes, routed through the employer flows."""

from __future__ import annotations

import json

from langgraph.graph import END, START, StateGraph

from app.harness.binding import bound_services
from app.harness.graph import turn_model
from app.harness.status import job_of
from app.harness.tools import ToolContext, call_structured, emit


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
        plan_of=lambda _state: current_employer_plan() or "", call_tool=call_tool,
        model_for=lambda _state: turn_model.get())
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
