from __future__ import annotations

import contextvars
import json
from dataclasses import replace
from uuid import NAMESPACE_URL, UUID, uuid5

from langchain_core.messages import HumanMessage, SystemMessage, ToolMessage
from langgraph.graph import END, START, StateGraph
from langgraph.types import Send, interrupt
from pydantic import ValidationError
from typing_extensions import TypedDict

from app.framework.models import _content
from app.graphs.chat_surface import insert_chat_approval
from app.harness.graph import _CAP, turn_model
from app.harness.personal.resume.boost import boost_cycle
from app.harness.personal.resume.prompts import phase_prompt_for_harness
from app.harness.personal.resume.state import ResumeState
from app.harness.personal.resume.tools import RESUME_TOOLS, save_artifact
from app.harness.policy import Tier
from app.harness.tools import ToolContext, call_structured, emit, to_structured_tool

bound_core: contextvars.ContextVar = contextvars.ContextVar("resume_core", default=None)

_ORDER = (
    "mode_select", "intake", "analyze", "strategy", "craft", "review", "publish", "present",
)
_SKIP_C = {"strategy", "craft"}
_ARTIFACTS = {
    "present": "06_present.json",
}
_TARGET_IDS = ("resume", "portfolio", "cover_letter")
_GATES = {
    "mode_select": {
        "title": "어떤 방식으로 진행할까요?",
        "recommended": "resume_based",
        "options": [
            {"id": "resume_based", "label": "이력서부터 쓸게요"},
            {"id": "experience_blueprint", "label": "경험부터 정리할게요"},
        ],
    },
    "output_targets": {
        "title": "어떤 산출물을 만들까요?",
        "recommended": "resume",
        "multiple": True,
        "options": [
            {"id": "resume", "label": "이력서"},
            {"id": "portfolio", "label": "포트폴리오"},
            {"id": "cover_letter", "label": "자기소개서"},
        ],
    },
    "tone": {
        "title": "어떤 말투로 쓸까요?",
        "recommended": "preserve",
        "options": [
            {"id": "professional", "label": "전문적으로"},
            {"id": "confident", "label": "자신 있게"},
            {"id": "concise", "label": "짧게"},
            {"id": "technical", "label": "기술 중심으로"},
            {"id": "collaborative", "label": "협업 중심으로"},
            {"id": "preserve", "label": "원래 말투로"},
        ],
    },
    "intake": {
        "title": "입력한 자료를 확인했어요. 분석을 시작할까요?",
        "recommended": "ready",
        "options": [
            {"id": "ready", "label": "이 자료로 진행할게요"},
            {"id": "C", "label": "시나리오 C로 갈게요"},
        ],
    },
    "analyze": {
        "title": "이 공고에 맞춰 고칠까요?",
        "recommended": "continue",
        "options": [{"id": "continue", "label": "전략으로 갈게요"}],
    },
    "feedback": {
        "title": "피드백을 반영해서 수정할까요?",
        "recommended": "continue",
        "options": [{"id": "continue", "label": "반영해서 수정할게요"}],
    },
    "strategy": {
        "title": "이 전략대로 초안을 쓸까요?",
        "recommended": "continue",
        "options": [
            {"id": "continue", "label": "초안 쓸게요"},
            {"id": "2-B", "label": "피드백만 볼게요"},
        ],
    },
    "craft": {
        "title": "첫 번째 초안(v1)이에요. 이대로 검토할까요?",
        "recommended": "continue",
        "options": [{"id": "continue", "label": "검토할게요"}],
    },
    "review": {
        "title": "검증을 마쳤어요. 어떤 디자인을 적용할까요?",
        "recommended": "CLASSIC",
        "options": [
            {"id": "CLASSIC", "label": "클래식"},
            {"id": "MODERN", "label": "모던"},
            {"id": "COMPACT", "label": "컴팩트"},
            {"id": "ATS", "label": "ATS"},
        ],
    },
    "publish": {
        "title": "디자인을 적용했어요. PDF로 만들까요?",
        "recommended": "confirm",
        "options": [{"id": "confirm", "label": "이대로 마무리할게요"}],
    },
    "present": {
        "title": "PDF를 만들었어요. 결과를 확인할까요?",
        "recommended": "done",
        "options": [{"id": "done", "label": "확인했어요"}],
    },
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
    output_targets: list
    tone: str | None
    warnings: list
    access_mode: str
    goto: str
    conversation_id: str
    user_id: str
    job_id: str
    retry: bool
    reply: str
    reply_job: str
    parsed_file: str
    github_file: str
    job_file: str


def _scenario_letter(state: dict) -> str:
    raw = state.get("scenario") or (state.get("inputs") or {}).get("scenario") or "A"
    letter = str(raw).strip().upper()[:1]
    return letter if letter in "ABCDEF" else "A"


def _after_analyze(state: dict) -> str:
    return {
        "B": "feedback",
        "C": "review",
        "D": "craft",
        "E": "present",
        "F": "craft",
    }.get(_scenario_letter(state), "strategy")


def _next_phase(state: dict, phase: str) -> str | None:
    if phase == "present":
        return None
    if phase == "feedback":
        return "craft"
    if phase == "analyze":
        return _after_analyze(state)
    index = _ORDER.index(phase) + 1
    nxt = _ORDER[index]
    if _scenario_letter(state) == "C" and nxt in _SKIP_C:
        return "review"
    return nxt


def _must_stop(state: dict, phase: str) -> bool:
    if (state.get("access_mode") or "AUTO") != "BYPASS":
        return True
    if phase == "mode_select":
        return True
    inputs = state.get("inputs") or {}
    if phase == "intake" and not (inputs.get("attachments") or inputs.get("pages")):
        return True
    return False


def _cancelled(answer: dict) -> bool:
    if answer.get("option_id") == "cancel":
        return True
    text = str(answer.get("text") or "").strip()
    return text.startswith(("그만", "취소", "중단"))


def _choice(state: dict, phase: str, *, auto: bool) -> dict:
    gate = _GATES[phase]
    event = {
        "type": "choice",
        "id": str(uuid5(
            NAMESPACE_URL,
            f"push:resume-gate:{state.get('conversation_id')}:{state.get('job_id')}:{phase}",
        )),
        "kind": "RESUME_GATE",
        "title": gate["title"],
        "gate": phase,
        "recommended": gate["recommended"],
        "options": [*gate["options"], {"id": "cancel", "label": "그만하기"}],
    }
    if gate.get("multiple"):
        event["multiple"] = True
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


def _context(db, state: dict) -> ToolContext:
    return ToolContext(
        user_id=str(state.get("user_id") or ""), company_id=None,
        conversation_id=str(state.get("conversation_id") or ""),
        job_id=str(state.get("job_id") or ""), tool_call_id="", db=db,
        core=bound_core.get(), inputs=dict(state.get("inputs") or {}))


def _targets(state: dict) -> list[str]:
    picked = [str(item) for item in (state.get("output_targets") or []) if str(item) in _TARGET_IDS]
    return picked or ["resume"]


def _bodies(phase: str, state: dict, output: dict) -> list[tuple[str, str]]:
    if phase == "craft":
        version = int(state.get("draft_version") or 1)
        body = _artifact_body(f"03_draft_resume_v{version}.md", output)
        return [(f"03_draft_{target}_v{version}.md", body) for target in _targets(state)]
    if phase == "publish":
        body = _artifact_body("05_final_resume.md", output)
        return [(f"05_final_{target}.md", body) for target in _targets(state)]
    if phase == "strategy":
        return [
            ("02_strategy.json", _artifact_body("02_strategy.json", output)),
            ("02_fit_score.json", json.dumps({"fit": output.get("fit")}, ensure_ascii=False)),
        ]
    if phase == "review":
        return [("04_review_report.json", _artifact_body("04_review_report.json", output))]
    name = _ARTIFACTS.get(phase)
    if not name:
        return []
    return [(name, _artifact_body(name, output))]


async def _store_output(db, state: dict, phase: str, output: dict) -> dict:
    artifacts = dict(state.get("artifacts") or {})
    ctx = _context(db, state)
    for name, body in _bodies(phase, state, output):
        artifacts[name] = await save_artifact(ctx, name, body)
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


def _option_ids(answer: dict) -> list[str]:
    raw = answer.get("option_ids")
    if raw is None:
        raw = answer.get("optionIds")
    if not isinstance(raw, list):
        return []
    return [str(item) for item in raw if str(item)]


def _apply_answer(state: dict, phase: str, answer: dict) -> dict:
    update: dict = {}
    option_id = answer.get("option_id")
    if phase == "mode_select" and option_id in {"resume_based", "experience_blueprint"}:
        update["work_mode"] = option_id
    if phase == "intake" and option_id == "C":
        update["scenario"] = "C"
    if phase == "output_targets":
        picked = [item for item in _option_ids(answer) if item in _TARGET_IDS]
        if not picked and option_id in _TARGET_IDS:
            picked = [str(option_id)]
        if picked:
            update["output_targets"] = picked
    if phase == "tone" and option_id:
        update["tone"] = str(option_id)
    if option_id == "2-B" or str(answer.get("text") or "").startswith("피드백만"):
        update["strategy"] = {**(state.get("strategy") or {}), "branch": "2-B"}
    text = answer.get("text")
    if text or answer.get("pages") or answer.get("attachments"):
        inputs = merge_inputs(state.get("inputs") or {}, answer)
        if text:
            inputs["gate_text"] = text
        update["inputs"] = inputs
    return update


def merge_inputs(inputs: dict, extra: dict) -> dict:
    merged = dict(inputs)
    merged["pages"] = {**(inputs.get("pages") or {}), **(extra.get("pages") or {})}
    attachments = list(inputs.get("attachments") or [])
    for item in extra.get("attachments") or []:
        if item not in attachments:
            attachments.append(item)
    merged["attachments"] = attachments
    return merged


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


_READ_TOOLS = {tool.name: tool for tool in RESUME_TOOLS if tool.tier is Tier.READ}


async def _read_tool(call: dict, ctx: ToolContext) -> dict:
    tool = _READ_TOOLS.get(call["name"])
    if tool is None:
        return {"error": "UNKNOWN_TOOL"}
    try:
        args = tool.args_model.model_validate(call.get("args") or {})
    except ValidationError:
        return {"error": "INVALID_ARGS"}
    result, _ok = await call_structured(tool, args, replace(ctx, tool_call_id=call["id"]))
    emit({"type": "tool", "name": tool.name, "state": "err" if "error" in result else "ok",
           "summary": tool.summarize(args), "tier": tool.tier.value})
    return result


async def _output(model, phase: str, state: dict, ctx: ToolContext) -> dict:
    if model is None:
        return {"summary": phase}
    context = {key: state.get(key) for key in (
        "phase", "work_mode", "scenario", "inputs", "analysis", "strategy", "drafts", "review")}
    messages = [
        SystemMessage(content=phase_prompt_for_harness(phase) + "\n\n결과는 JSON 객체 하나로만 답하고, 사용자에게 보여줄 한두 문장은 message 키에 넣는다."),
        HumanMessage(content=json.dumps(context, ensure_ascii=False)),
    ]
    used = 0
    while True:
        if used >= _CAP or not hasattr(model, "bind_tools"):
            return _parsed(await model.ainvoke(messages))
        reply = await model.bind_tools(
            [to_structured_tool(tool) for tool in _READ_TOOLS.values()],
        ).ainvoke(messages)
        calls = getattr(reply, "tool_calls", None) or []
        if not calls:
            return _parsed(reply)
        messages.append(reply)
        for call in calls:
            result = await _read_tool(call, ctx) if used < _CAP else {"error": "도구 호출 한도"}
            used += 1
            messages.append(ToolMessage(content=json.dumps(result, ensure_ascii=False), tool_call_id=call["id"]))


def _reply(phase: str, output: dict) -> str:
    for key in ("message", "summary", "text"):
        value = output.get(key)
        if isinstance(value, str) and value.strip() and value != phase:
            return value.strip()
    return _PHASE_DONE[phase]


_PHASE_DONE = {
    "mode_select": "어떤 방식으로 서류를 만들지 골라 주세요.",
    "intake": "자료를 받았어요. 이대로 분석할지 골라 주세요.",
    "analyze": "자료 분석을 마쳤어요.",
    "strategy": "작성 전략을 세웠어요.",
    "craft": "초안을 썼어요.",
    "review": "품질 검토를 마쳤어요. 디자인을 골라 주세요.",
    "publish": "최종 서류를 만들었어요.",
    "present": "결과를 정리했어요.",
}


_GATE_PHASE = {
    "output_targets": "intake",
    "tone": "intake",
}
_INTAKE_NEXT = {
    "output_targets": "g_tone",
    "tone": "g_intake",
}
_EXITS = {
    "end": END,
    "g_tone": "g_tone",
    "g_intake": "g_intake",
    "p3c_boost": "p3c_boost",
}


def _auto_answer(gate_id: str) -> dict:
    recommended = _GATES[gate_id]["recommended"]
    if _GATES[gate_id].get("multiple"):
        return {"option_id": recommended, "option_ids": [recommended]}
    return {"option_id": recommended}


def _advance(merged: dict, gate_id: str, update: dict) -> dict:
    if gate_id in _INTAKE_NEXT:
        return {**update, "status": "active", "phase": "intake", "goto": _INTAKE_NEXT[gate_id]}
    phase = _GATE_PHASE.get(gate_id, gate_id)
    nxt = _next_phase(merged, phase)
    if nxt is None:
        return {**update, "status": "done", "phase": "present", "goto": "end"}
    landed = {**update, "status": "active", "phase": nxt, "goto": "end"}
    if gate_id == "craft" and nxt == "review":
        landed["goto"] = "p3c_boost"
    return landed


def build_resume_graph(checkpointer, *, model=None, db=None):
    def current_of(state: ResumeGraphState) -> dict:
        return ResumeState.model_validate(state).model_dump()

    def work_node(phase: str):
        async def node(state: ResumeGraphState) -> dict:
            current = {**current_of(state), "phase": phase}
            output = await _output(turn_model.get() or model, phase, current, _context(db, current))
            stored = await _store_output(db, current, phase, output)
            reply = _reply(phase, output)
            emit({"token": reply})
            stored = {**stored, "reply": reply, "reply_job": current["job_id"], "retry": False}
            retries = int((current.get("strategy") or {}).get("retries") or 0)
            if phase == "strategy" and output.get("valid") is False and retries < 2:
                stored["strategy"] = {**stored["strategy"], "retries": retries + 1}
                return {**stored, "phase": "strategy", "status": "active", "retry": True}
            return stored
        return node

    async def accepted(current: dict, gate_id: str, answer: dict) -> dict:
        update = _apply_answer(current, gate_id, answer)
        merged = {**current, **update}
        if gate_id == "intake":
            artifacts = dict(merged.get("artifacts") or {})
            body = json.dumps({
                "work_mode": merged.get("work_mode"),
                "output_targets": _targets(merged),
                "tone": merged.get("tone"),
            }, ensure_ascii=False, indent=2)
            artifacts["01_scenario.json"] = await save_artifact(
                _context(db, merged), "01_scenario.json", body)
            update["artifacts"] = artifacts
            merged = {**merged, "artifacts": artifacts}
        return _advance(merged, gate_id, update)

    def gate_node(gate_id: str):
        async def node(state: ResumeGraphState) -> dict:
            current = current_of(state)
            if not _must_stop(current, gate_id):
                if gate_id not in _INTAKE_NEXT:
                    emit(_choice(current, gate_id, auto=True))
                return await accepted(current, gate_id, _auto_answer(gate_id))
            event = _choice(current, gate_id, auto=False)
            if await _save_choice(db, current, event):
                emit(event)
            answer = interrupt({
                "approval_id": event["id"],
                "awaiting": "choice",
                "kind": "RESUME_GATE",
                "gate": gate_id,
            }) or {}
            if _cancelled(answer):
                return {"status": "cancelled", "phase": current["phase"], "goto": "end"}
            if answer.get("text") and not answer.get("option_id") and not _option_ids(answer):
                stayed = _apply_answer(current, gate_id, answer)
                text = str(answer["text"])
                stayed["phase"] = "strategy" if text.startswith("피드백만") else current["phase"]
                stayed["status"] = "active"
                stayed["goto"] = "end"
                return stayed
            if not answer.get("option_id") and not _option_ids(answer):
                answer = {**answer, **_auto_answer(gate_id)}
            return await accepted(current, gate_id, answer)
        return node

    async def boost(state: ResumeGraphState) -> dict:
        extra = boost_cycle(dict(state)) or {}
        if not isinstance(extra, dict):
            extra = {}
        skipped = {"phase", "status", "goto"}
        kept = {key: value for key, value in extra.items() if key not in skipped}
        return {**kept, "phase": state.get("phase") or "review", "status": "active", "goto": "end"}

    async def save_named(state: dict, name: str, payload: dict) -> str:
        body = json.dumps(payload, ensure_ascii=False)
        return await save_artifact(_context(db, state), name, body)

    async def parse_resume(state: ResumeGraphState) -> dict:
        analysis = state.get("analysis") or {}
        return {"parsed_file": await save_named(state, "01_parsed_resume.json", analysis)}

    async def explore_github(state: ResumeGraphState) -> dict:
        analysis = state.get("analysis") or {}
        findings = analysis.get("github") if isinstance(analysis.get("github"), dict) else {}
        return {"github_file": await save_named(state, "01_github_findings.json", findings)}

    async def analyze_job(state: ResumeGraphState) -> dict:
        analysis = state.get("analysis") or {}
        jobs = analysis.get("jobs") if isinstance(analysis.get("jobs"), dict) else {}
        return {"job_file": await save_named(state, "01_job_analyses.json", jobs)}

    async def classify_scenario(state: ResumeGraphState) -> dict:
        analysis = state.get("analysis") or {}
        scenario = state.get("scenario") or analysis.get("scenario") or "A"
        artifacts = dict(state.get("artifacts") or {})
        artifacts["01_parsed_resume.json"] = state.get("parsed_file") or ""
        artifacts["01_github_findings.json"] = state.get("github_file") or ""
        artifacts["01_job_analyses.json"] = state.get("job_file") or ""
        fit_body = json.dumps({"fit": analysis.get("fit")}, ensure_ascii=False)
        artifacts["02_fit_score.json"] = await save_artifact(
            _context(db, state), "02_fit_score.json", fit_body)
        return {"scenario": str(scenario), "artifacts": artifacts}

    async def feedback_node(state: ResumeGraphState) -> dict:
        current = current_of(state)
        reply = "피드백을 정리했어요."
        emit({"token": reply})
        return {"reply": reply, "reply_job": current["job_id"], "phase": "feedback"}

    async def design_node(state: ResumeGraphState) -> dict:
        current = current_of(state)
        reply = "디자인을 골라 주세요."
        emit({"token": reply})
        return {"reply": reply, "reply_job": current["job_id"], "phase": "review"}

    def fan_out(state: ResumeGraphState):
        payload = dict(state)
        return [
            Send("parse_resume", payload),
            Send("explore_github", payload),
            Send("analyze_job", payload),
        ]

    def route_phase(state: ResumeGraphState) -> str:
        phase = state.get("phase") or "mode_select"
        if phase == "review" and _scenario_letter(state) == "C":
            return "p4b_design"
        return {
            "mode_select": "p0_mode",
            "intake": "p0i_intake",
            "analyze": "p1_analyze",
            "strategy": "p2_strategy",
            "craft": "p3_craft",
            "feedback": "p2b_feedback",
            "review": "p4a_review",
            "publish": "p5_publish",
            "present": "p6_present",
        }.get(phase, "p0_mode")

    def route_goto(state: ResumeGraphState) -> str:
        return state.get("goto") or "end"

    def after_strategy(state: ResumeGraphState) -> str:
        return "end" if state.get("retry") else "g2"

    graph = StateGraph(ResumeGraphState)
    graph.add_node("p0_mode", work_node("mode_select"))
    graph.add_node("g0", gate_node("mode_select"))
    graph.add_node("p0i_intake", work_node("intake"))
    graph.add_node("g_output_targets", gate_node("output_targets"))
    graph.add_node("g_tone", gate_node("tone"))
    graph.add_node("g_intake", gate_node("intake"))
    graph.add_node("p1_analyze", work_node("analyze"))
    graph.add_node("parse_resume", parse_resume)
    graph.add_node("explore_github", explore_github)
    graph.add_node("analyze_job", analyze_job)
    graph.add_node("classify_scenario", classify_scenario)
    graph.add_node("g1", gate_node("analyze"))
    graph.add_node("p2b_feedback", feedback_node)
    graph.add_node("g_feedback", gate_node("feedback"))
    graph.add_node("p4b_design", design_node)
    graph.add_node("p2_strategy", work_node("strategy"))
    graph.add_node("g2", gate_node("strategy"))
    graph.add_node("p3_craft", work_node("craft"))
    graph.add_node("g3", gate_node("craft"))
    graph.add_node("p3c_boost", boost)
    graph.add_node("p4a_review", work_node("review"))
    graph.add_node("g4a", gate_node("review"))
    graph.add_node("p5_publish", work_node("publish"))
    graph.add_node("g5", gate_node("publish"))
    graph.add_node("p6_present", work_node("present"))
    graph.add_node("g6", gate_node("present"))
    graph.add_conditional_edges(START, route_phase, {name: name for name in (
        "p0_mode", "p0i_intake", "p1_analyze", "p2_strategy", "p2b_feedback", "p3_craft",
        "p4a_review", "p4b_design", "p5_publish", "p6_present",
    )})
    graph.add_edge("p0_mode", "g0")
    graph.add_edge("p0i_intake", "g_output_targets")
    graph.add_conditional_edges(
        "p1_analyze", fan_out, ["parse_resume", "explore_github", "analyze_job"])
    graph.add_edge("parse_resume", "classify_scenario")
    graph.add_edge("explore_github", "classify_scenario")
    graph.add_edge("analyze_job", "classify_scenario")
    graph.add_edge("classify_scenario", "g1")
    graph.add_edge("p2b_feedback", "g_feedback")
    graph.add_edge("p4b_design", "g4a")
    graph.add_conditional_edges("p2_strategy", after_strategy, {"g2": "g2", "end": END})
    graph.add_edge("p3_craft", "g3")
    graph.add_edge("p4a_review", "g4a")
    graph.add_edge("p5_publish", "g5")
    graph.add_edge("p6_present", "g6")
    graph.add_edge("p3c_boost", END)
    for name in (
        "g0", "g_output_targets", "g_tone", "g_intake", "g1", "g_feedback",
        "g2", "g3", "g4a", "g5", "g6",
    ):
        graph.add_conditional_edges(name, route_goto, _EXITS)
    return graph.compile(checkpointer=checkpointer)
