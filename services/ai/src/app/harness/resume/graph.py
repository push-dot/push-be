from __future__ import annotations

import json
from uuid import NAMESPACE_URL, UUID, uuid5

from langgraph.config import get_stream_writer
from langgraph.graph import END, START, StateGraph
from langgraph.types import interrupt
from typing_extensions import TypedDict

from app.graphs.chat_surface import insert_chat_approval
from app.harness.resume.prompts import phase_prompt_for_harness
from app.harness.resume.state import ResumeState

# shortcut: resume thread_id is conversation_id + ":resume" so it does not collide with the chat harness

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


async def _enqueue(poster, phase: str, option_id: str) -> None:
    if poster is None:
        return
    await poster({"resume": {"gate": phase, "optionId": option_id, "auto": True}})


def _store_output(state: dict, phase: str, output: dict) -> dict:
    artifacts = dict(state.get("artifacts") or {})
    name = _ARTIFACTS.get(phase)
    if name:
        artifacts[name] = json.dumps(output, ensure_ascii=False)
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


async def _output(model, phase: str, state: dict) -> dict:
    if model is None:
        return {"summary": phase}
    prompt = phase_prompt_for_harness(phase)
    if hasattr(model, "with_structured_output"):
        runnable = model.with_structured_output(dict)
        result = await runnable.ainvoke([{"role": "system", "content": prompt}, {"phase": phase}])
        return result if isinstance(result, dict) else {"summary": phase}
    return {"summary": phase}


def build_resume_graph(checkpointer, *, model=None, db=None, poster=None):
    async def phase_node(state: ResumeGraphState) -> dict:
        current = ResumeState.model_validate(state).model_dump()
        name = current["phase"]
        output = await _output(model, name, current)
        stored = _store_output(current, name, output)
        if name == "strategy" and output.get("valid") is False:
            return {**stored, "phase": "strategy", "status": "active"}
        if not _must_stop(current, name):
            recommended = _GATES[name][0]
            answer = {"option_id": recommended}
            _emit(_choice(current, name, auto=True))
            merged = {**current, **stored, **_apply_answer(current, name, answer)}
            return await _finish(merged, name, recommended, stored)
        event = _choice(current, name, auto=False)
        if await _save_choice(db, current, event):
            _emit(event)
        answer = interrupt({
            "approval_id": event["id"],
            "awaiting": "approval",
            "kind": "RESUME_GATE",
            "gate": name,
        }) or {}
        if _cancelled(answer):
            return {**stored, "status": "cancelled", "phase": name}
        if answer.get("text") and not answer.get("option_id"):
            stayed = _apply_answer(current, name, answer)
            if str(answer.get("text") or "").startswith("피드백만"):
                stayed["phase"] = "strategy"
            else:
                stayed["phase"] = name
            stayed["status"] = "active"
            return {**stored, **stayed}
        option_id = str(answer.get("option_id") or _GATES[name][0])
        merged = {**current, **stored, **_apply_answer(current, name, answer)}
        return await _finish(merged, name, option_id, stored)

    async def _finish(merged: dict, name: str, option_id: str, stored: dict) -> dict:
        nxt = _next_phase(merged, name)
        await _enqueue(poster, name, option_id)
        if nxt is None:
            return {**stored, **_apply_answer(merged, name, {"option_id": option_id}), "status": "done", "phase": "present"}
        return {
            **stored,
            **_apply_answer(merged, name, {"option_id": option_id}),
            "status": "active",
            "phase": nxt,
        }

    graph = StateGraph(ResumeGraphState)
    graph.add_node("phase", phase_node)
    graph.add_edge(START, "phase")
    graph.add_edge("phase", END)
    return graph.compile(checkpointer=checkpointer)
