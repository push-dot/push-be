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
from app.harness.approvals import insert_chat_approval
from app.harness.graph import _CAP, turn_model
from app.harness.personal.resume.booster import boost_cycle
from app.harness.personal.resume.drafts import draft_text
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
_TEMPLATES = {"CLASSIC", "MODERN", "COMPACT", "ATS"}
_ARTIFACTS = {
    "present": "06_present.json",
}
_TARGET_IDS = ("resume", "portfolio", "cover_letter")
_APPROACH_IDS = ("bottleneck", "prevention")
_LEVEL_IDS = ("L1", "L2", "L3")
_PREVENTION_IDS = (
    "performance", "security", "scalability", "reliability", "maintainability", "data_integrity",
)
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
    "approach": {
        "title": "어떤 접근 방식으로 진행할까요?",
        "recommended": "prevention",
        "options": [
            {"id": "bottleneck", "label": "병목을 만들게요"},
            {"id": "prevention", "label": "문제를 예방할게요"},
        ],
    },
    "level": {
        "title": "병목 강도를 어느 정도로 할까요?",
        "recommended": "L2",
        "options": [
            {"id": "L1", "label": "가벼운 제약으로"},
            {"id": "L2", "label": "중간 제약으로"},
            {"id": "L3", "label": "강한 제약으로"},
        ],
    },
    "prevention": {
        "title": "어떤 문제를 예방할까요?",
        "recommended": "performance",
        "multiple": True,
        "options": [
            {"id": "performance", "label": "성능"},
            {"id": "security", "label": "보안"},
            {"id": "scalability", "label": "확장성"},
            {"id": "reliability", "label": "안정성"},
            {"id": "maintainability", "label": "유지보수"},
            {"id": "data_integrity", "label": "데이터 무결성"},
        ],
    },
    "projects": {
        "title": "어떤 프로젝트를 구현할까요?",
        "recommended": "skip",
        "options": [{"id": "skip", "label": "기획만 볼게요"}],
    },
    "validate_cap": {
        "title": "검증을 통과하지 못했어요. 다른 방향으로 다시 고를까요?",
        "recommended": "retry",
        "options": [{"id": "retry", "label": "다시 고르기"}],
    },
    "boost": {
        "title": "점수를 한 번 더 올릴까요?",
        "recommended": "continue",
        "options": [
            {"id": "continue", "label": "한 번 더 올리기"},
            {"id": "stop", "label": "여기서 멈추기"},
        ],
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
    template: str | None
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
    approach: str | None
    bottleneck_level: str | None
    prevention_categories: list
    blueprints: dict
    validation_failures: int
    scores: list
    boost_acked: int
    boost_stopped: str


_VALIDATE_CAP = 3


_JOB_KEYS = ("requirements", "required", "preferred", "keywords")
_POSTING_CAP = 6000


def _job_terms(analysis: dict) -> list:
    jobs = analysis.get("jobs") if isinstance(analysis, dict) else None
    if isinstance(jobs, dict):
        nodes = [jobs]
    elif isinstance(jobs, list):
        nodes = jobs
    else:
        nodes = []
    terms = []
    for node in nodes:
        if not isinstance(node, dict):
            continue
        for key in _JOB_KEYS:
            value = node.get(key)
            if isinstance(value, list):
                terms.extend(value)
    return terms


def _page_text(inputs) -> str:
    pages = inputs.get("pages") if isinstance(inputs, dict) else None
    if isinstance(pages, dict):
        chunks = list(pages.values())
    elif isinstance(pages, list):
        chunks = pages
    else:
        return ""
    return "\n".join(
        chunk.strip() for chunk in chunks if isinstance(chunk, str) and chunk.strip()
    )


def _posting(state) -> tuple[list, str]:
    analysis = state.get("analysis") if isinstance(state.get("analysis"), dict) else {}
    jobs = analysis.get("jobs")
    blob = json.dumps(jobs if jobs else analysis, ensure_ascii=False)
    pages = _page_text(state.get("inputs") if isinstance(state.get("inputs"), dict) else {})
    text = f"{blob}\n{pages}" if pages else blob
    return _job_terms(analysis), text[:_POSTING_CAP]


def _boost_detail(step: dict) -> str:
    gain = step["gain"]
    signed = f"+{gain:.1f}" if gain >= 0 else f"{gain:.1f}"
    return f"적합도 {step['before']:.1f} → {step['after']:.1f} ({signed})"


def _fit_user(state: dict):
    raw = state.get("user_id")
    if not raw:
        return None
    try:
        return UUID(str(raw))
    except (TypeError, ValueError):
        return None


def _invalid(output: dict) -> bool:
    return output.get("valid") is False


def _fail_update(state: dict, phase: str) -> dict:
    failed = int(state.get("validation_failures") or 0) + 1
    return {
        "validation_failures": failed,
        "phase": phase,
        "status": "active",
        "retry": failed < _VALIDATE_CAP,
    }


def _capped(state: dict, phase: str) -> bool:
    failures = int(state.get("validation_failures") or 0)
    return state.get("phase") == phase and failures >= _VALIDATE_CAP


def _scenario_letter(state: dict) -> str:
    raw = state.get("scenario") or (state.get("inputs") or {}).get("scenario") or "A"
    letter = str(raw).strip().upper()[:1]
    return letter if letter in "ABCDEF" else "A"


def _after_analyze(state: dict) -> str:
    if state.get("work_mode") == "experience_blueprint":
        return "approach"
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
    if phase in {"mode_select", "validate_cap"}:
        return True
    if (state.get("access_mode") or "AUTO") != "BYPASS":
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


def _choice(
    state: dict, phase: str, *, auto: bool, cycle: int | None = None, detail: str | None = None,
) -> dict:
    gate = _GATES[phase]
    seed = f"push:resume-gate:{state.get('conversation_id')}:{state.get('job_id')}:{phase}"
    if cycle is not None:
        seed = f"{seed}:{cycle}"
    event = {
        "type": "choice",
        "id": str(uuid5(NAMESPACE_URL, seed)),
        "kind": "RESUME_GATE",
        "title": gate["title"],
        "gate": phase,
        "recommended": gate["recommended"],
        "options": [*gate["options"], {"id": "cancel", "label": "그만하기"}],
    }
    if detail:
        event["detail"] = detail
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
    if phase == "blueprints":
        body = _artifact_body("06_experience_blueprints.json", output)
        return [("06_experience_blueprints.json", body)]
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
    template = state.get("template")
    for name, body in _bodies(phase, state, output):
        artifacts[name] = await save_artifact(ctx, name, body, template)
    bucket = {
        "analyze": "analysis",
        "strategy": "strategy",
        "craft": "drafts",
        "review": "review",
        "blueprints": "blueprints",
    }.get(phase)
    update = {"artifacts": artifacts}
    if bucket:
        prior = dict(state.get(bucket) or {})
        merged = {**prior, **output}
        if phase == "strategy":
            for key in ("focus", "steps"):
                if key in prior:
                    merged[key] = prior[key]
        update[bucket] = merged
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
    if phase == "review" and option_id in _TEMPLATES:
        update["template"] = option_id
    if phase == "output_targets":
        picked = [item for item in _option_ids(answer) if item in _TARGET_IDS]
        if not picked and option_id in _TARGET_IDS:
            picked = [str(option_id)]
        if picked:
            update["output_targets"] = picked
    if phase == "tone" and option_id:
        update["tone"] = str(option_id)
    if phase == "approach" and option_id in _APPROACH_IDS:
        update["approach"] = str(option_id)
    if phase == "level" and option_id in _LEVEL_IDS:
        update["bottleneck_level"] = str(option_id)
    if phase == "prevention":
        picked = [item for item in _option_ids(answer) if item in _PREVENTION_IDS]
        if not picked and option_id in _PREVENTION_IDS:
            picked = [str(option_id)]
        if picked:
            update["prevention_categories"] = picked
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
        "phase", "work_mode", "scenario", "inputs", "analysis", "strategy", "drafts", "review",
        "approach", "bottleneck_level", "prevention_categories")}
    prompt = phase_prompt_for_harness(phase)
    if phase == "strategy" and (state.get("strategy") or {}).get("focus") == "bottleneck":
        prompt = f"{prompt}\n{_BOTTLENECK_STEPS}"
    messages = [
        SystemMessage(content=prompt + "\n\n결과는 JSON 객체 하나로만 답하고, 사용자에게 보여줄 한두 문장은 message 키에 넣는다."),
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


_BOTTLENECK_STEPS = (
    "이번에는 content-strategy Step 1–3만 수행한다"
    "(기술 스택 매칭, 적합도 산정, 프로젝트 경험 재평가). "
    "Step 4 이후 섹션 수정 전략과 자기소개서 전략은 쓰지 않는다."
)


_PHASE_DONE = {
    "mode_select": "어떤 방식으로 서류를 만들지 골라 주세요.",
    "intake": "자료를 받았어요. 이대로 분석할지 골라 주세요.",
    "analyze": "자료 분석을 마쳤어요.",
    "strategy": "작성 전략을 세웠어요.",
    "craft": "초안을 썼어요.",
    "review": "품질 검토를 마쳤어요. 디자인을 골라 주세요.",
    "publish": "최종 서류를 만들었어요.",
    "present": "결과를 정리했어요.",
    "blueprints": "프로젝트 기획서를 만들었어요.",
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
    "g_level": "g_level",
    "g_prevention": "g_prevention",
    "p2x_validate": "p2x_validate",
}


def _auto_answer(gate_id: str) -> dict:
    recommended = _GATES[gate_id]["recommended"]
    if _GATES[gate_id].get("multiple"):
        return {"option_id": recommended, "option_ids": [recommended]}
    return {"option_id": recommended}


def _advance(merged: dict, gate_id: str, update: dict) -> dict:
    if gate_id in _INTAKE_NEXT:
        return {**update, "status": "active", "phase": "intake", "goto": _INTAKE_NEXT[gate_id]}
    if gate_id == "approach":
        nxt = "g_level" if merged.get("approach") == "bottleneck" else "g_prevention"
        return {**update, "status": "active", "phase": "approach", "goto": nxt}
    if gate_id in {"level", "prevention"}:
        return {**update, "status": "active", "phase": "approach", "goto": "p2x_validate"}
    if gate_id == "validate_cap":
        phase = merged.get("phase")
        if phase not in {"approach", "blueprints"}:
            phase = "approach"
        return {
            **update,
            "validation_failures": 0,
            "status": "active",
            "phase": phase,
            "goto": "end",
        }
    if gate_id == "projects":
        return {**update, "status": "done", "phase": "blueprints", "goto": "end"}
    if gate_id == "strategy" and (merged.get("strategy") or {}).get("focus") == "bottleneck":
        return {**update, "status": "done", "phase": "strategy", "goto": "end"}
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
        if gate_id in {"level", "prevention"}:
            artifacts = dict(merged.get("artifacts") or {})
            scenario = {
                "work_mode": merged.get("work_mode"),
                "output_targets": _targets(merged),
                "tone": merged.get("tone"),
                "approach": merged.get("approach"),
                "bottleneck_level": merged.get("bottleneck_level"),
                "prevention_categories": list(merged.get("prevention_categories") or []),
            }
            artifacts["01_scenario.json"] = await save_artifact(
                _context(db, merged), "01_scenario.json",
                json.dumps(scenario, ensure_ascii=False, indent=2))
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

    async def score_draft(state: dict) -> dict:
        from app.framework.fit_judge import judge_fit
        from app.harness.personal.tools import current_ai_gate
        from app.infrastructure.posting_fit_cache import read_plan

        user_id = _fit_user(state)
        query = None if db is None else db.q()
        plan = await read_plan(query, user_id)
        terms, description = _posting(state)
        return await judge_fit(
            terms,
            terms,
            description,
            draft_text(state.get("drafts")),
            plan,
            gate=current_ai_gate(),
            job_id=state.get("job_id") or None,
            user_id=user_id,
        )

    async def boost(state: ResumeGraphState) -> dict:
        scores = [float(item) for item in (state.get("scores") or [])]
        if not scores:
            base = await score_draft(state)
            scores.append(float(base["fitScore"]))
        current = {**state, "phase": "craft"}
        ctx = _context(db, state)
        output = await _output(turn_model.get() or model, "craft", current, ctx)
        stored = await _store_output(db, current, "craft", output)
        view = await score_draft({**state, **stored})
        scores.append(float(view["fitScore"]))
        return {**stored, "scores": scores}

    async def _finish_boost(state: ResumeGraphState, outcome: dict, stopped: str) -> dict:
        artifacts = dict(state.get("artifacts") or {})
        artifacts["05_boost_history.json"] = await save_named(
            state, "05_boost_history.json", {"history": outcome["history"]},
        )
        return {
            "phase": "review",
            "scores": [],
            "boost_acked": 0,
            "boost_stopped": stopped,
            "artifacts": artifacts,
            "status": "active",
            "goto": "end",
        }

    async def boost_gate(state: ResumeGraphState) -> dict:
        outcome = boost_cycle({
            "scores": state.get("scores") or [],
            "acked": int(state.get("boost_acked") or 0),
            "defer": True,
        })
        pending = outcome.get("pending")
        phase = state.get("phase") or "review"
        if pending is None:
            stopped = outcome["stopped"]
            if stopped == "continue":
                stopped = "max"
            return await _finish_boost(state, outcome, stopped)
        detail = _boost_detail(pending)
        stopped = outcome["stopped"]
        if stopped in {"stall", "max"}:
            note = (
                "더 올리기 어려워서 여기서 멈출게요."
                if stopped == "stall"
                else "최대 5번까지 올렸어요."
            )
            emit({"token": f"{detail} — {note}"})
            return await _finish_boost(state, outcome, stopped)
        if not _must_stop(state, "boost"):
            emit(_choice(state, "boost", auto=True, cycle=pending["cycle"], detail=detail))
            answer: dict = {"option_id": "continue"}
        else:
            event = _choice(state, "boost", auto=False, cycle=pending["cycle"], detail=detail)
            if await _save_choice(db, state, event):
                emit(event)
            answer = interrupt({
                "approval_id": event["id"],
                "awaiting": "choice",
                "kind": "RESUME_GATE",
                "gate": "boost",
                "cycle": pending["cycle"],
                "before": pending["before"],
                "after": pending["after"],
                "gain": pending["gain"],
            }) or {}
        if _cancelled(answer):
            return {"status": "cancelled", "phase": phase, "goto": "end"}
        option = answer.get("option_id") or "continue"
        stopped = "stop" if option == "stop" else outcome["stopped"]
        if stopped == "continue":
            return {
                "boost_acked": int(outcome["cycles"]),
                "boost_stopped": stopped,
                "status": "active",
                "phase": phase,
                "goto": "p3c_boost",
            }
        return await _finish_boost(state, outcome, stopped)

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

    async def approach_node(state: ResumeGraphState) -> dict:
        current = current_of(state)
        reply = "접근 방식을 골라 주세요."
        emit({"token": reply})
        return {
            "reply": reply, "reply_job": current["job_id"], "phase": "approach", "retry": False,
        }

    async def validate_node(state: ResumeGraphState) -> dict:
        current = current_of(state)
        chat = turn_model.get() or model
        if chat is None:
            output = {"valid": True}
        else:
            messages = [
                SystemMessage(content=(
                    "선택한 접근 방식이 공고와 맞는지 JSON으로 판단한다. "
                    "맞지 않으면 valid를 false로 둔다."
                )),
                HumanMessage(content=json.dumps({
                    "phase": "validate",
                    "approach": current.get("approach"),
                    "bottleneck_level": current.get("bottleneck_level"),
                    "prevention_categories": current.get("prevention_categories") or [],
                    "analysis": current.get("analysis") or {},
                }, ensure_ascii=False)),
            ]
            output = _parsed(await chat.ainvoke(messages))
        if _invalid(output):
            return _fail_update(state, "approach")
        return {
            "phase": "blueprints", "status": "active", "retry": False, "validation_failures": 0,
        }

    async def validate_bp_node(state: ResumeGraphState) -> dict:
        current = current_of(state)
        chat = turn_model.get() or model
        if chat is None:
            output = {"valid": True}
        else:
            messages = [
                SystemMessage(content=phase_prompt_for_harness("validate_bp") + (
                    "\n\n탈락이면 valid를 false로 둔다. 결과는 JSON 객체 하나로만 답한다."
                )),
                HumanMessage(content=json.dumps({
                    "phase": "validate_bp",
                    "approach": current.get("approach"),
                    "bottleneck_level": current.get("bottleneck_level"),
                    "prevention_categories": current.get("prevention_categories") or [],
                    "blueprints": current.get("blueprints") or {},
                    "analysis": current.get("analysis") or {},
                }, ensure_ascii=False)),
            ]
            output = _parsed(await chat.ainvoke(messages))
        artifacts = dict(state.get("artifacts") or {})
        artifacts["04_validation_report.json"] = await save_named(
            state, "04_validation_report.json", output)
        if _invalid(output):
            return {**_fail_update(state, "blueprints"), "artifacts": artifacts}
        return {
            "artifacts": artifacts, "phase": "blueprints", "status": "active", "retry": False,
        }

    def after_validate(state: ResumeGraphState) -> str:
        if state.get("retry"):
            return "end"
        if _capped(state, "approach"):
            return "g_validate_cap"
        return "p2x_blueprints"

    def after_validate_bp(state: ResumeGraphState) -> str:
        if state.get("retry"):
            return "end"
        if _capped(state, "blueprints"):
            return "g_validate_cap"
        return "g2x"

    def fan_out(state: ResumeGraphState):
        payload = dict(state)
        return [
            Send("parse_resume", payload),
            Send("explore_github", payload),
            Send("analyze_job", payload),
        ]

    def route_phase(state: ResumeGraphState) -> str:
        phase = state.get("phase") or "mode_select"
        if state.get("goto") == "p3c_boost":
            return "p3c_boost"
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
            "approach": "p2x_approach",
            "blueprints": "p2x_blueprints",
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
    graph.add_node("p3c_cycle", boost_gate)
    graph.add_node("p4a_review", work_node("review"))
    graph.add_node("g4a", gate_node("review"))
    graph.add_node("p5_publish", work_node("publish"))
    graph.add_node("g5", gate_node("publish"))
    graph.add_node("p6_present", work_node("present"))
    graph.add_node("g6", gate_node("present"))
    graph.add_node("p2x_approach", approach_node)
    graph.add_node("g_approach", gate_node("approach"))
    graph.add_node("g_level", gate_node("level"))
    graph.add_node("g_prevention", gate_node("prevention"))
    graph.add_node("p2x_validate", validate_node)
    graph.add_node("p2x_blueprints", work_node("blueprints"))
    graph.add_node("p2x_validate_bp", validate_bp_node)
    graph.add_node("g_validate_cap", gate_node("validate_cap"))
    graph.add_node("g2x", gate_node("projects"))
    graph.add_conditional_edges(START, route_phase, {name: name for name in (
        "p0_mode", "p0i_intake", "p1_analyze", "p2_strategy", "p2b_feedback", "p3_craft",
        "p4a_review", "p4b_design", "p5_publish", "p6_present", "p3c_boost",
        "p2x_approach", "p2x_blueprints",
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
    graph.add_edge("p2x_approach", "g_approach")
    graph.add_edge("p2x_blueprints", "p2x_validate_bp")
    graph.add_conditional_edges(
        "p2x_validate", after_validate, {
            "end": END, "p2x_blueprints": "p2x_blueprints", "g_validate_cap": "g_validate_cap",
        })
    graph.add_conditional_edges(
        "p2x_validate_bp", after_validate_bp, {
            "end": END, "g2x": "g2x", "g_validate_cap": "g_validate_cap",
        })
    graph.add_conditional_edges("p2_strategy", after_strategy, {"g2": "g2", "end": END})
    graph.add_edge("p3_craft", "g3")
    graph.add_edge("p4a_review", "g4a")
    graph.add_edge("p5_publish", "g5")
    graph.add_edge("p6_present", "g6")
    graph.add_edge("p3c_boost", "p3c_cycle")
    graph.add_conditional_edges(
        "p3c_cycle", route_goto, {"end": END, "p3c_boost": "p3c_boost"})
    for name in (
        "g0", "g_output_targets", "g_tone", "g_intake", "g1", "g_feedback",
        "g2", "g3", "g4a", "g5", "g6",
        "g_approach", "g_level", "g_prevention", "g_validate_cap", "g2x",
    ):
        graph.add_conditional_edges(name, route_goto, _EXITS)
    return graph.compile(checkpointer=checkpointer)
