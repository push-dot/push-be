from __future__ import annotations

import json
from uuid import NAMESPACE_URL, UUID, uuid5

from langchain_core.messages import HumanMessage, SystemMessage
from langgraph.config import get_stream_writer
from langgraph.graph import END, START, StateGraph
from langgraph.types import interrupt
from typing_extensions import TypedDict

from app.framework.models import _content
from app.graphs.chat_surface import insert_chat_approval
from app.harness.graph import turn_model
from app.harness.resume.prompts import phase_prompt_for_harness
from app.harness.resume.state import ResumeState
from app.harness.resume.tools import save_artifact
from app.harness.tools import ToolContext

_ORDER = (
    "mode_select", "intake", "analyze", "strategy", "craft", "review", "publish", "present",
)
_SKIP_C = {"strategy", "craft"}
_ARTIFACTS = {
    "analyze": "01_parsed_resume.json",
    "strategy": "02_strategy.json",
    "craft": "03_draft.md",
    "review": "04_review.json",
    "publish": "05_final_resume.md",
    "present": "06_present.json",
}
_GATES = {
    "mode_select": ("resume_based", [
        {"id": "resume_based", "label": "이력서부터 쓸게요"},
        {"id": "experience_blueprint", "label": "경험부터 정리할게요"},
    ]),
    "intake": ("ready", [
        {"id": "ready", "label": "이 자료로 진행할게요"},
        {"id": "C", "label": "시나리오 C로 갈게요"},
    ]),
    "analyze": ("continue", [{"id": "continue", "label": "전략으로 갈게요"}]),
    "strategy": ("continue", [
        {"id": "continue", "label": "초안 쓸게요"},
        {"id": "2-B", "label": "피드백만 볼게요"},
    ]),
    "craft": ("continue", [{"id": "continue", "label": "검토할게요"}]),
    "review": ("CLASSIC", [
        {"id": "CLASSIC", "label": "클래식"},
        {"id": "MODERN", "label": "모던"},
        {"id": "COMPACT", "label": "컴팩트"},
        {"id": "ATS", "label": "ATS"},
    ]),
    "publish": ("confirm", [{"id": "confirm", "label": "이대로 마무리할게요"}]),
    "present": ("done", [{"id": "done", "label": "확인했어요"}]),
}


class ResumeGraphState(TypedDict, total=False):
    status: str
    phase: str
    work_mode: str | None
    scenario: str | None
    inputs: dict
    analysis: dict
    strategy: dict
    drafts: dict
    review: dict
    artifacts: dict
    warnings: list
    access_mode: str
    conversation_id: str
    user_id: str
    job_id: str
    retry: bool


def _emit(event: dict) -> None:
    try:
        get_stream_writer()(event)
    except Exception:
        return


def _scenario_c(state: dict) -> bool:
    if state.get("scenario") == "C":
        return True
    return (state.get("inputs") or {}).get("scenario") == "C"


def _next_phase(state: dict, phase: str) -> str | None:
    if phase == "present":
        return None
    if phase == "analyze" and _scenario_c(state):
        return "review"
    index = _ORDER.index(phase) + 1
    nxt = _ORDER[index]
    if _scenario_c(state) and nxt in _SKIP_C:
        return "review"
    return nxt


def _must_stop(state: dict, phase: str) -> bool:
    if (state.get("access_mode") or "AUTO") != "BYPASS":
        return True
    if phase == "mode_select":
        return True
    if phase == "intake" and not (state.get("inputs") or {}).get("attachments"):
        return True
    return False


def _cancelled(answer: dict) -> bool:
    if answer.get("option_id") == "cancel":
        return True
    text = str(answer.get("text") or "").strip()
    return text.startswith(("그만", "취소", "중단"))


def _choice(state: dict, phase: str, *, auto: bool) -> dict:
    recommended, options = _GATES[phase]
    event = {
        "type": "choice",
        "id": str(uuid5(
            NAMESPACE_URL,
            f"push:resume-gate:{state.get('conversation_id')}:{state.get('job_id')}:{phase}",
        )),
        "kind": "RESUME_GATE",
        "title": phase,
        "gate": phase,
        "recommended": recommended,
        "options": [*options, {"id": "cancel", "label": "그만하기"}],
    }
    if auto:
        event["auto"] = True
    return event


async def _save_choice(db, state: dict, event: dict) -> bool:
    if db is None:
        return True
    approval_id = UUID(str(event["id"]))
    row = await db.q().fetchrow("SELECT id FROM approvals WHERE id = $1", approval_id)
    if row is not None:
        return False
    await insert_chat_approval(
        db, state.get("user_id"), state.get("conversation_id"), event, None)
    return True


def _artifact_body(name: str, output: dict) -> str:
    if name.endswith(".md"):
        text = output.get("markdown") or output.get("text")
        if isinstance(text, str) and text.strip():
            return text
    return json.dumps(output, ensure_ascii=False, indent=2)


async def _store_output(db, state: dict, phase: str, output: dict) -> dict:
    artifacts = dict(state.get("artifacts") or {})
    name = _ARTIFACTS.get(phase)
    if name:
        ctx = ToolContext(
            user_id=str(state.get("user_id") or ""), company_id=None,
            conversation_id=str(state.get("conversation_id") or ""),
            job_id=str(state.get("job_id") or ""), tool_call_id="", db=db, core=None)
        artifacts[name] = await save_artifact(ctx, name, _artifact_body(name, output))
    bucket = {
        "analyze": "analysis",
        "strategy": "strategy",
        "craft": "drafts",
        "review": "review",
    }.get(phase)
    update = {"artifacts": artifacts}
    if bucket:
        update[bucket] = {**(state.get(bucket) or {}), **output}
    return update


def _apply_answer(state: dict, phase: str, answer: dict) -> dict:
    update: dict = {}
    option_id = answer.get("option_id")
    if phase == "mode_select" and option_id in {"resume_based", "experience_blueprint"}:
        update["work_mode"] = option_id
    if phase == "intake" and option_id == "C":
        update["scenario"] = "C"
    if option_id == "2-B" or str(answer.get("text") or "").startswith("피드백만"):
        update["strategy"] = {**(state.get("strategy") or {}), "branch": "2-B"}
    text = answer.get("text")
    if text:
        inputs = dict(state.get("inputs") or {})
        inputs["gate_text"] = text
        update["inputs"] = inputs
    return update


def _parsed(reply) -> dict:
    if isinstance(reply, dict):
        return reply
    text = _content(reply).strip()
    if text.startswith("```"):
        text = text.strip("`").removeprefix("json").strip()
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        return {"text": text}
    return parsed if isinstance(parsed, dict) else {"text": text}


async def _output(model, phase: str, state: dict) -> dict:
    if model is None:
        return {"summary": phase}
    context = {key: state.get(key) for key in (
        "phase", "work_mode", "scenario", "inputs", "analysis", "strategy", "drafts", "review")}
    messages = [
        SystemMessage(content=phase_prompt_for_harness(phase) + "\n\n결과는 JSON 객체 하나로만 답한다."),
        HumanMessage(content=json.dumps(context, ensure_ascii=False)),
    ]
    return _parsed(await model.ainvoke(messages))


def _finish(merged: dict, name: str, option_id: str) -> dict:
    update = _apply_answer(merged, name, {"option_id": option_id})
    nxt = _next_phase({**merged, **update}, name)
    if nxt is None:
        return {**update, "status": "done", "phase": "present"}
    return {**update, "status": "active", "phase": nxt}


def build_resume_graph(checkpointer, *, model=None, db=None):
    async def work(state: ResumeGraphState) -> dict:
        current = ResumeState.model_validate(state).model_dump()
        name = current["phase"]
        output = await _output(turn_model.get() or model, name, current)
        stored = await _store_output(db, current, name, output)
        if name == "strategy" and output.get("valid") is False:
            return {**stored, "phase": "strategy", "status": "active", "retry": True}
        return {**stored, "retry": False}

    async def gate(state: ResumeGraphState) -> dict:
        current = ResumeState.model_validate(state).model_dump()
        name = current["phase"]
        if not _must_stop(current, name):
            recommended = _GATES[name][0]
            _emit(_choice(current, name, auto=True))
            return _finish({**current, **_apply_answer(current, name, {"option_id": recommended})},
                           name, recommended)
        event = _choice(current, name, auto=False)
        if await _save_choice(db, current, event):
            _emit(event)
        answer = interrupt({
            "approval_id": event["id"],
            "awaiting": "choice",
            "kind": "RESUME_GATE",
            "gate": name,
        }) or {}
        if _cancelled(answer):
            return {"status": "cancelled", "phase": name}
        if answer.get("text") and not answer.get("option_id"):
            stayed = _apply_answer(current, name, answer)
            stayed["phase"] = "strategy" if str(answer["text"]).startswith("피드백만") else name
            stayed["status"] = "active"
            return stayed
        option_id = str(answer.get("option_id") or _GATES[name][0])
        return _finish({**current, **_apply_answer(current, name, answer)}, name, option_id)

    def after_work(state: ResumeGraphState) -> str:
        return "end" if state.get("retry") else "gate"

    graph = StateGraph(ResumeGraphState)
    graph.add_node("work", work)
    graph.add_node("gate", gate)
    graph.add_edge(START, "work")
    graph.add_conditional_edges("work", after_work, {"gate": "gate", "end": END})
    graph.add_edge("gate", END)
    return graph.compile(checkpointer=checkpointer)
