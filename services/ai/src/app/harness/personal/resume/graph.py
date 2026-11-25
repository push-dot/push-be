from __future__ import annotations

import asyncio
import contextvars
import json
import logging
import re
import time
from collections.abc import Mapping
from dataclasses import replace
from typing import Any
from uuid import NAMESPACE_URL, UUID, uuid5

from langchain_core.messages import HumanMessage, SystemMessage, ToolMessage
from langgraph.graph import END, START, StateGraph
from langgraph.types import Send, interrupt
from pydantic import ValidationError
from typing_extensions import TypedDict

from app.domain.a2ui import auto_pick_line
from app.domain.posting_text import posting_terms
from app.framework.models import _content
from app.framework.untrusted import DATA_RULE, as_data
from app.harness.approvals import insert_chat_approval
from app.harness.graph import _CAP, turn_model
from app.harness.kstyle.ask import ask_once, ask_options, ask_title, needs_ask
from app.harness.kstyle.final import Final, late_lines, render
from app.harness.kstyle.ledger import assume
from app.harness.kstyle.review import Reviewer, run_reviewers
from app.harness.kstyle.subagent import mid_model, squash
from app.harness.kstyle.verify import finding, fix_once
from app.harness.personal.resume.booster import boost_cycle
from app.harness.personal.resume.drafts import chosen_document_text, draft_text, drafts_from_chosen
from app.harness.personal.resume.explore import budget_for, prefetch, run_explore
from app.harness.personal.resume.github_agent import github_agent
from app.harness.personal.resume.profile_document import (
    load_document_markdown,
    profile_card_names,
    resolve_uploaded_source,
    save_edited_file,
    save_profile_document,
)
from app.harness.personal.resume.progress import (
    added_keywords,
    analyze_steps,
    apply_recommendations_line,
    blueprints_plan,
    blueprints_text,
    boost_fit,
    boost_line,
    boost_rounds,
    company_line,
    craft_text,
    done_summary,
    feedback_line,
    feedback_plan,
    fit_card,
    fit_failed_line,
    fit_line,
    github_line,
    intake_panel,
    paper_event,
    posting_line,
    quality_diff,
    quality_line,
    quality_text,
    resume_line,
    strategy_line,
    strategy_plan,
    think_event,
    titled_projects,
    todo_event,
    verify_items,
    verify_text,
    without_materials,
)
from app.harness.personal.resume.prompts import phase_prompt_for_harness
from app.harness.personal.resume.source_agents import fact_check_agent, stage_one
from app.harness.personal.resume.state import ResumeState
from app.harness.personal.resume.subagent import light_model
from app.harness.personal.resume.subject import github_links
from app.harness.personal.resume.tools import (
    RESUME_TOOLS,
    FitArgs,
    _fit_document,
    _github_targets,
    _repo_target,
    save_artifact,
)
from app.harness.personal.resume.verify import verify_draft
from app.harness.personal.resume.workspace import ledger_text, load_notes, save_notes
from app.harness.policy import Tier
from app.harness.status import (
    SAVE_DOCUMENT,
    SCORE_FIT,
    job_of,
    notice,
    running_job,
    waiting,
    with_status,
    working,
)
from app.harness.tools import (
    RETRY_WARNING,
    ToolContext,
    call_retrying,
    emit,
    to_structured_tool,
)

bound_core: contextvars.ContextVar = contextvars.ContextVar("resume_core", default=None)

_ORDER = (
    "mode_select",
    "intake",
    "analyze",
    "strategy",
    "craft",
    "review",
    "publish",
    "present",
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
    "performance",
    "security",
    "scalability",
    "reliability",
    "maintainability",
    "data_integrity",
)
_GATES = {
    "mode_select": {
        "title": "어떤 방식으로 진행할까요?",
        "recommended": "resume_based",
        "options": [
            {"id": "resume_based", "label": "이력서부터 쓰기"},
            {"id": "experience_blueprint", "label": "경험부터 정리하기"},
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
            {"id": "preserve", "label": "원래 말투로"},
            {"id": "professional", "label": "전문적으로"},
            {"id": "confident", "label": "자신 있게"},
            {"id": "concise", "label": "짧게"},
            {"id": "technical", "label": "기술 중심으로"},
            {"id": "collaborative", "label": "협업 중심으로"},
        ],
    },
    "intake": {
        "title": "이대로 분석을 시작할까요?",
        "recommended": "ready",
        "options": [
            {"id": "ready", "label": "시작하기"},
            {"id": "change", "label": "자료 바꾸기"},
        ],
    },
    "analyze": {
        "title": "이 공고에 맞춰 이력서를 고칠까요?",
        "recommended": "continue",
        "options": [
            {"id": "continue", "label": "고치기"},
            {"id": "feedback", "label": "피드백만 받기"},
            {"id": "score", "label": "점수만 보기"},
        ],
    },
    "feedback": {
        "title": "피드백을 반영해서 수정할까요?",
        "recommended": "continue",
        "options": [
            {"id": "continue", "label": "수정하기"},
            {"id": "keep", "label": "그대로 둘게요"},
        ],
    },
    "strategy": {
        "title": "이 전략대로 초안을 쓸까요?",
        "recommended": "continue",
        "options": [
            {"id": "continue", "label": "초안 쓰기"},
            {"id": "2-B", "label": "피드백만 보기"},
        ],
    },
    "craft": {
        "title": "첫 번째 초안(v1)이에요. 이대로 검토할까요?",
        "recommended": "continue",
        "options": [{"id": "continue", "label": "검토할게요"}],
    },
    "review": {
        "title": "어떤 디자인으로 만들까요?",
        "detail": "템플릿을 골라 주세요. 처음이라면 클래식을 추천해요.",
        "recommended": "CLASSIC",
        "options": [
            {"id": "CLASSIC", "label": "클래식", "badge": "추천"},
            {"id": "MODERN", "label": "모던"},
            {"id": "COMPACT", "label": "컴팩트"},
            {"id": "ATS", "label": "ATS"},
        ],
    },
    "present": {
        "title": "결과를 확인할까요?",
        "recommended": "done",
        "options": [{"id": "done", "label": "확인했어요"}],
    },
    "approach": {
        "title": "어떤 방식으로 경험을 만들까요?",
        "recommended": "prevention",
        "options": [
            {"id": "bottleneck", "label": "병목 만들기"},
            {"id": "prevention", "label": "문제 예방하기"},
        ],
    },
    "level": {
        "title": "병목 강도를 어느 정도로 할까요?",
        "recommended": "L2",
        "options": [
            {"id": "L1", "label": "가벼운 제약"},
            {"id": "L2", "label": "중간 제약"},
            {"id": "L3", "label": "강한 제약"},
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
        "recommended": "",
        "options": [],
    },
    "read_failed": {
        "title": "어떻게 할까요?",
        "recommended": "paste",
        "options": [
            {"id": "paste", "label": "공고 내용을 붙여넣을게요"},
            {"id": "proceed", "label": "이대로 진행해 주세요"},
            {"id": "pick", "label": "Push 공고에서 고를게요"},
        ],
    },
    "ask": {
        "title": "하나만 확인할게요",
        "recommended": "",
        "options": [],
    },
    "validate_cap": {
        "title": "어떻게 할까요?",
        "recommended": "retry",
        "options": [
            {"id": "retry", "label": "다시 시도"},
            {"id": "change", "label": "방향 바꾸기"},
        ],
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
    profile_photo: bool
    draft_version: int
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
    chosen_project: str | None
    blueprints: dict
    validation_failures: int
    scores: list
    boost_acked: int
    boost_parts: dict
    boost_rounds: dict
    boost_stopped: str
    profile_document_id: str
    source_saved: bool | None
    intake_asks: int
    gate_epoch: int
    fit_from: float | None
    fit_to: float | None


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


def _jobs_node(analysis: dict) -> dict:
    jobs = analysis.get("jobs") if isinstance(analysis, dict) else None
    if isinstance(jobs, list):
        jobs = next((item for item in jobs if isinstance(item, dict)), {})
    return jobs if isinstance(jobs, dict) else {}


def _read_error(analysis: dict) -> str:
    reason = _jobs_node(analysis).get("read_error")
    return reason.strip() if isinstance(reason, str) else ""


_JOB_FIELDS = (
    "company", "title", "required", "requirements", "preferred", "keywords", "read_error",
)


def _job_nodes(output: dict) -> list[dict]:
    """Every posting shape the analyze model has returned, as a flat list of dicts."""
    for key in ("jobs", "job", "posting"):
        value = output.get(key)
        if isinstance(value, dict) and isinstance(value.get("postings"), list):
            value = value["postings"]
        elif (
            isinstance(value, dict)
            and value
            and not any(field in value for field in _JOB_FIELDS)
            and all(isinstance(item, dict) for item in value.values())
        ):
            value = list(value.values())
        nodes = [value] if isinstance(value, dict) else value if isinstance(value, list) else []
        nodes = [node for node in nodes if isinstance(node, dict)]
        if nodes:
            return nodes
    return []


def _term(item) -> str:
    if isinstance(item, dict):
        item = next((value for value in item.values() if isinstance(value, str)), "")
    return str(item).strip() if isinstance(item, (str, int, float)) else ""


def _unique(items) -> list[str]:
    return list(dict.fromkeys(term for term in map(_term, items) if term))


def _gathered(nodes: list[dict], *keys: str) -> list[str]:
    return _unique(
        item
        for node in nodes
        for key in keys
        if isinstance(node.get(key), list)
        for item in node[key]
    )


def _posting_page_text(inputs: dict) -> str:
    pages = inputs.get("pages") if isinstance(inputs.get("pages"), dict) else {}
    posting = inputs.get("posting") if isinstance(inputs.get("posting"), dict) else {}
    chunks = [posting.get("description")] + [
        body for url, body in pages.items() if "github.com" not in str(url).lower()
    ]
    return "\n".join(chunk for chunk in chunks if isinstance(chunk, str) and chunk.strip())


def normalize_analysis(inputs: dict, output: dict) -> dict:
    """One canonical `jobs` dict, filled from the posting we already hold when the model left
    the terms out, so a readable page never lands on the read_failed gate."""
    bag = inputs if isinstance(inputs, dict) else {}
    nodes = _job_nodes(output)
    required = _gathered(nodes, "requirements", "required")
    preferred = _gathered(nodes, "preferred")
    keywords = _gathered(nodes, "keywords")
    posting = bag.get("posting") if isinstance(bag.get("posting"), dict) else {}
    if not (required or preferred or keywords):
        if posting.get("requirements") or posting.get("preferred"):
            required = _gathered([posting], "requirements")
            preferred = _gathered([posting], "preferred")
        else:
            found = posting_terms(_posting_page_text(bag))
            required, preferred = found["required"], found["preferred"]
    if not (nodes or required or preferred):
        return output
    job = {key: value for key, value in dict(nodes[0] if nodes else {}).items()
           if key not in ("requirements", "postings")}
    for key in ("company", "title"):
        if not job.get(key) and posting.get(key):
            job[key] = posting[key]
    job.update(required=required, preferred=preferred, keywords=keywords)
    if required or preferred or keywords:
        job.pop("read_error", None)
    rest = {key: value for key, value in output.items() if key not in ("job", "posting")}
    return {**rest, "jobs": job}


def posting_unreadable(inputs: dict, analysis: dict | None) -> bool:
    found = analysis if isinstance(analysis, dict) else {}
    if _read_error(found) and not _job_terms(found):
        return True
    bag = inputs if isinstance(inputs, dict) else {}
    steps, _added = analyze_steps(bag, found)
    if not any(key == "posting" for key, _label in steps):
        return False
    return not _job_terms(found)


_POSTING_ID = re.compile(
    r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
)


def _posting_id_in(text: str) -> str:
    found = _POSTING_ID.search(text or "")
    return found.group(0) if found else ""


def _page_text(inputs) -> str:
    pages = inputs.get("pages") if isinstance(inputs, dict) else None
    if isinstance(pages, dict):
        chunks = list(pages.values())
    elif isinstance(pages, list):
        chunks = pages
    else:
        return ""
    return "\n".join(chunk.strip() for chunk in chunks if isinstance(chunk, str) and chunk.strip())


def _posting(state) -> tuple[list, str]:
    analysis = state.get("analysis") if isinstance(state.get("analysis"), dict) else {}
    jobs = analysis.get("jobs")
    blob = json.dumps(jobs if jobs else analysis, ensure_ascii=False)
    pages = _page_text(state.get("inputs") if isinstance(state.get("inputs"), dict) else {})
    text = f"{blob}\n{pages}" if pages else blob
    return _job_terms(analysis), text[:_POSTING_CAP]


def _fit_posting(state) -> dict:
    """The terms every fit score of one posting reads, so boost rounds compare like with like."""
    inputs = state.get("inputs") if isinstance(state.get("inputs"), dict) else {}
    if isinstance(inputs.get("fit_posting"), dict):
        return inputs["fit_posting"]
    analysis = state.get("analysis") if isinstance(state.get("analysis"), dict) else {}
    nodes = _job_nodes(analysis)
    return {
        "required": _gathered(nodes, "requirements", "required"),
        "preferred": _gathered(nodes, "preferred"),
        "keywords": _gathered(nodes, "keywords"),
    }


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


def _fail_update(state: Mapping[str, Any], phase: str) -> dict[str, Any]:
    failed = int(state.get("validation_failures") or 0) + 1
    return {
        "validation_failures": failed,
        "phase": phase,
        "status": "active",
        "retry": failed < _VALIDATE_CAP,
    }


def _failed_check(state: Mapping[str, Any], phase: str, said: str) -> dict[str, Any]:
    update = _fail_update(state, phase)
    if not update["retry"]:
        notice(said)
    return update


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
        "E": "craft",
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


# The profile is saved before this card, and its one answer only repeats what the user asked for (rule 39):
# the server goes on and sends the card with auto set, so the app has nothing to confirm.
_NEVER_ASKED = frozenset({"present"})


def _ask_of(state: dict) -> dict:
    analysis = state.get("analysis") if isinstance(state.get("analysis"), dict) else {}
    ask = analysis.get("ask")
    return ask if isinstance(ask, dict) else {}


def _gate_options(state: dict, phase: str) -> list[dict]:
    if phase == "ask":
        options = [str(item).strip() for item in _ask_of(state).get("options") or [] if str(item).strip()]
        return [{"id": f"o{index}", "label": label} for index, label in enumerate(options[:3], 1)]
    if phase == "strategy" and _strategy_ask(state):
        keep, restore = ask_options()
        return [{"id": "continue", "label": keep["label"]}, {"id": "restore", "label": restore["label"]},
                *[option for option in _GATES[phase]["options"] if option["id"] != "continue"]]
    if phase != "projects":
        return list(_GATES[phase]["options"])
    projects = (state.get("blueprints") or {}).get("projects")
    items = projects if isinstance(projects, list) else []
    return [
        {
            "id": str(item.get("id") or index) if isinstance(item, dict) else str(index),
            "label": str((item.get("title") or item.get("name") or "") if isinstance(item, dict) else "")
            or f"프로젝트 {index}",
        }
        for index, item in enumerate(items, 1)
    ]


# AUTO stops only where the user really decides something; the rest is answered with the
# recommended pick and said in the chat, as a Claude Code run would just go on.
_DECISION_GATES = frozenset({"output_targets", "strategy", "review", "projects", "approach", "level", "prevention"})
_BLOCKED_GATES = frozenset({"mode_select", "validate_cap", "read_failed", "ask"})


def _must_stop(state: dict, phase: str) -> bool:
    if len(_gate_options(state, phase)) < 2:
        return False
    if phase in _BLOCKED_GATES:
        return True
    if phase in _NEVER_ASKED:
        return False
    mode = state.get("access_mode") or "AUTO"
    if mode == "ALWAYS_ASK":
        return True
    inputs = state.get("inputs") or {}
    if phase == "intake" and not (inputs.get("attachments") or inputs.get("pages") or inputs.get("documentId")):
        return True
    if mode == "BYPASS":
        return False
    return phase in _DECISION_GATES


_RESUME_EXT = (".pdf", ".docx", ".doc")
_SAVED_LINE = "내 서류에 자동 저장됨"
_FILE_GATE = "결과를 확인할까요?"
_FILE_TASK = "이력서 수정 · 올린 파일 · 경력"
_PROFILE_TASK = "프로필 수정 · Push 프로필 · 경력"
_PROFILE_SUB = "Push 프로필 · 방금 수정"
_FILE_STEPS = (
    "이력서 읽기",
    "공고 요건 정리",
    "적합도 계산",
    "경력 섹션 고치기",
    "PDF로 만들기",
)
_FILE_STEPS_OPEN = (
    "이력서 읽기",
    "고칠 점 찾기",
    "경력 섹션 고치기",
    "PDF로 만들기",
)
_PROFILE_STEPS = (
    "프로필 읽기",
    "공고 요건 정리",
    "적합도 계산",
    "경력 섹션 고치기",
    "프로필에 저장",
)
_EXTERNAL_NOTE = (
    "올린 파일을 고친 결과다. PDF를 만들어 내 서류에 저장한다. PDF로 만들지 묻지 않는다."
)


def _file_label(value) -> str:
    return value.strip() if isinstance(value, str) else ""


def _is_resume_file(name: str) -> bool:
    return name.lower().endswith(_RESUME_EXT)


def resume_source(state: dict) -> str:
    inputs = state.get("inputs") if isinstance(state.get("inputs"), dict) else {}
    if inputs.get("source") == "external":
        return "external"
    for item in inputs.get("attachments") or []:
        if isinstance(item, dict):
            mime = str(item.get("mimeType") or item.get("mime_type") or item.get("mime") or "")
            name = _file_label(item.get("fileName") or item.get("file_name") or item.get("name"))
            lowered = mime.lower()
            file_mime = "pdf" in lowered or "word" in lowered or "officedocument" in lowered
            if file_mime or _is_resume_file(name):
                return "external"
        elif _is_resume_file(_file_label(item)):
            return "external"
    if _is_resume_file(_file_label(inputs.get("fileName") or inputs.get("file_name"))):
        return "external"
    return "profile"


_ROLE_ENUM = {"dev", "data", "design", "plan", "marketing", "sales", "hr", "ops"}
_ROLE_WORDS = (
    "프론트엔드",
    "백엔드",
    "풀스택",
    "데이터",
    "디자인",
    "기획",
    "마케팅",
    "머신러닝",
    "devops",
    "ios",
    "android",
    "qa",
)
_NAME_CAP = 80
_UNSAFE = set('/\\:*?"<>|')


def _file_part(value: str) -> str:
    kept = [ch for ch in value if ch not in _UNSAFE and ord(ch) >= 32 and not ch.isspace()]
    return "".join(kept).strip("._")


def _cap_stem(stem: str) -> str:
    stem = stem.strip("._")
    if len(stem) > _NAME_CAP:
        stem = stem[:_NAME_CAP].rstrip("._")
    return stem or "이력서"


def _role_word(text: str) -> str:
    lowered = text.lower()
    for word in _ROLE_WORDS:
        if word.lower() in lowered:
            return word
    return ""


def _target_role(state: dict) -> str:
    posting = _target_posting(state)
    if not posting:
        return ""
    labeled = []
    for key in ("role", "job_category", "jobCategory", "category"):
        value = posting.get(key)
        if isinstance(value, str) and value.strip():
            labeled.append(value.strip())
    title = posting.get("title")
    title = title.strip() if isinstance(title, str) else ""
    for field in labeled:
        if field.lower() in _ROLE_ENUM:
            continue
        hit = _role_word(field)
        if hit:
            return hit
        if len(field) <= 20 and not any(ch.isspace() for ch in field):
            return _file_part(field)
    return _role_word(title)


def _original_stem(state: dict) -> str:
    inputs = state.get("inputs") if isinstance(state.get("inputs"), dict) else {}
    raw = ""
    for item in inputs.get("attachments") or []:
        if isinstance(item, dict):
            raw = _file_label(item.get("fileName") or item.get("file_name") or item.get("name"))
        elif _is_resume_file(_file_label(item)):
            raw = _file_label(item)
        if raw:
            break
    if not raw:
        raw = _file_label(inputs.get("fileName") or inputs.get("file_name")) or "이력서.pdf"
    return raw.rsplit(".", 1)[0] if "." in raw else raw


def edited_pdf_name(state: dict, display_name: str) -> str:
    company = _file_part(_target_company(state))
    if company:
        parts = [_file_part(display_name), company, _file_part(_target_role(state))]
        return _cap_stem("_".join(part for part in parts if part)) + ".pdf"
    stem = _file_part(_original_stem(state)) or "이력서"
    suffix = "_수정본"
    room = _NAME_CAP - len(suffix)
    if len(stem) > room:
        stem = stem[:room].rstrip("._") or "이력서"
    return _cap_stem(f"{stem}{suffix}") + ".pdf"


def _target_posting(state: dict) -> dict | None:
    inputs = state.get("inputs") if isinstance(state.get("inputs"), dict) else {}
    posting = inputs.get("posting")
    if isinstance(posting, dict):
        return posting
    analysis = state.get("analysis") if isinstance(state.get("analysis"), dict) else {}
    jobs = analysis.get("jobs")
    if isinstance(jobs, dict):
        return jobs
    if isinstance(jobs, list):
        for item in jobs:
            if isinstance(item, dict):
                return item
    return None


def _target_company(state: dict) -> str:
    posting = _target_posting(state)
    if not posting:
        return ""
    company = posting.get("company")
    return company.strip() if isinstance(company, str) else ""


def _apply_fields(state: dict, follow: dict | None) -> dict:
    actions = []
    company = _target_company(state)
    fields: dict = {}
    if company:
        fields["company"] = company
        actions.append({"id": "apply", "label": f"{company}에 바로 지원하기"})
    if follow:
        actions.append(follow)
    fields["actions"] = actions
    return fields


def _file_steps(state: dict) -> tuple[str, ...]:
    return _FILE_STEPS if _target_posting(state) else _FILE_STEPS_OPEN


def _todo(steps: tuple[str, ...]) -> dict:
    return {
        "type": "todo",
        "items": [
            {"id": str(index + 1), "text": text, "state": "done"}
            for index, text in enumerate(steps)
        ],
    }


def _file_result(saved: dict, state: dict) -> dict:
    page = saved["pageLine"]
    document_id = saved.get("documentId") or ""
    event = {
        "type": "result",
        "source": "external",
        "taskLine": _FILE_TASK,
        "checklist": list(_file_steps(state)),
        "fileName": saved["fileName"],
        "pageLine": page,
        "cardMeta": page,
        "documentId": document_id,
    }
    follow = None
    if saved.get("stored"):
        event["savedLine"] = _SAVED_LINE
    if saved.get("stored") and document_id:
        follow = {
            "id": "convert",
            "label": "프로필로 전환",
            "method": "POST",
            "path": f"/api/v1/documents/{document_id}/profile",
        }
    return {**event, **_apply_fields(state, follow)}


def _profile_title(name: str, headline: str) -> str:
    parts = [part for part in (name, headline) if part]
    return " · ".join(parts) if parts else "Push 프로필"


def _profile_result(document_id: str, name: str, headline: str, state: dict) -> dict:
    follow = {"id": "view", "label": "프로필 보기"} if document_id else None
    return {
        "type": "result",
        "source": "profile",
        "taskLine": _PROFILE_TASK,
        "checklist": list(_PROFILE_STEPS),
        "name": name,
        "headline": headline,
        "title": _profile_title(name, headline),
        "subtitle": _PROFILE_SUB,
        "documentId": document_id,
        **_apply_fields(state, follow),
    }


def _done(state: dict, source: str) -> dict:
    drafts = state.get("drafts") if isinstance(state.get("drafts"), dict) else {}
    analysis = state.get("analysis") if isinstance(state.get("analysis"), dict) else {}
    changes = drafts.get("changes")
    bullets = changes if isinstance(changes, list) and changes else analysis.get("improvements")
    if not isinstance(bullets, list):
        bullets = []
    return done_summary(source, state.get("fit_from"), state.get("fit_to"), bullets)


def _cancelled(answer: dict) -> bool:
    if answer.get("option_id") == "cancel":
        return True
    text = str(answer.get("text") or "").strip()
    return text.startswith(("그만", "취소", "중단", "닫기"))


def _feedback_text(state: dict) -> str:
    analysis = state.get("analysis") if isinstance(state.get("analysis"), dict) else {}
    for key in ("message", "summary", "feedback"):
        value = analysis.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return "피드백을 정리했어요."


_THINK_PHASES = {"analyze", "strategy", "craft", "review", "blueprints"}
_TEMPLATE_MAKE = {
    "CLASSIC": "클래식으로 만들기",
    "MODERN": "모던으로 만들기",
    "COMPACT": "컴팩트로 만들기",
    "ATS": "ATS로 만들기",
}
_READ_FAILED_WARN = (
    "나머지 내용으로 진행할 수 있지만, 자격 요건이 빠지면 적합도가 정확하지 않을 수 있어요."
)
_READ_FAILED_PASTE = "공고 내용을 붙여 넣어 주세요."
_READ_FAILED_PICK = "공고를 골라 주세요. @로 북마크 공고를 부를 수 있어요."
_PASTED_POSTING = "붙여넣은 공고"


def _choice_id(state: dict, phase: str, *, cycle: int | None = None) -> str:
    seed = f"push:resume-gate:{state.get('conversation_id')}:{state.get('job_id')}:{phase}"
    epoch = int(state.get("gate_epoch") or 0)
    if epoch:
        seed = f"{seed}:e{epoch}"
    if cycle is not None:
        seed = f"{seed}:{cycle}"
    return str(uuid5(NAMESPACE_URL, seed))


def _review_sections() -> list[dict]:
    return [
        {
            "id": "template",
            "kind": "thumbnails",
            "options": [
                {"id": "CLASSIC", "label": "클래식", "badge": "추천"},
                {"id": "MODERN", "label": "모던"},
                {"id": "COMPACT", "label": "컴팩트"},
                {"id": "ATS", "label": "ATS"},
            ],
            "selected": ["CLASSIC"],
        },
    ]


async def _soft(run, fallback):
    """A subagent that fails leaves its part out; the flow goes on."""
    try:
        return await run
    except Exception:
        logging.getLogger(__name__).warning("subagent failed", exc_info=True)
        return fallback


def _answered_ask(current: dict, answer: dict) -> dict:
    """The answer goes back to the explore loop as steering, and analyze runs again from its notes."""
    labels = {item["id"]: item["label"] for item in _gate_options(current, "ask")}
    picked = labels.get(str(answer.get("option_id") or "")) or str(answer.get("text") or "").strip()
    inputs = dict(current.get("inputs") or {})
    if picked:
        question = str(_ask_of(current).get("question") or "")
        inputs["steer"] = [*(inputs.get("steer") or []), f"{question} → {picked}" if question else picked]
    analysis = dict(current.get("analysis") or {})
    analysis.pop("ask", None)
    return {"inputs": inputs, "analysis": analysis, "status": "active", "phase": "analyze", "goto": "end"}


def _choice(
    state: dict,
    phase: str,
    *,
    auto: bool,
    cycle: int | None = None,
    detail: str | None = None,
) -> dict:
    gate = _GATES[phase]
    options = _gate_options(state, phase)
    if phase != "analyze":
        options.append(
            {
                "id": "cancel",
                "label": "닫기",
            }
        )
    event = {
        "type": "choice",
        "id": _choice_id(state, phase, cycle=cycle),
        "kind": "RESUME_GATE",
        "title": gate["title"],
        "gate": phase,
        "recommended": gate["recommended"] or (options[0]["id"] if options else ""),
        "options": options,
    }
    if phase == "ask":
        event["title"] = str(_ask_of(state).get("question") or gate["title"])
    if phase == "strategy" and _strategy_ask(state):
        detail = detail or ask_title(_strategy_ask(state))
    if phase == "output_targets":
        event["sections"] = intake_panel(state.get("inputs") or {}, state.get("analysis"))
        event["submit"] = {"label": "이 말투로 쓰기"}
    elif phase == "projects":
        event["submit"] = {"label": "구현하기"}
    elif phase == "review":
        event["sections"] = _review_sections()
        event["submit"] = {"label": "만들기", "optionLabels": dict(_TEMPLATE_MAKE)}
    if phase == "present" and resume_source(state) == "external":
        event["title"] = _FILE_GATE
        if state.get("profile_document_id"):
            event["documentId"] = state["profile_document_id"]
    elif phase == "present":
        if not auto:
            event["note"] = "PDF는 Push 프로필에서 내보낼 수 있어요."
        if state.get("profile_document_id"):
            event["documentId"] = state["profile_document_id"]
    detail = detail or gate.get("detail")
    if detail:
        event["detail"] = detail
    if gate.get("multiple"):
        event["multiple"] = True
    if auto:
        event["auto"] = True
        event["recommended"] = _AUTO_PICK.get(phase, event["recommended"])
    return event


def _emit_auto(event: dict) -> None:
    """A gate the server answered itself draws no surface: the Bot says what it picked instead."""
    emit(event)
    line = auto_pick_line(event)
    if line:
        emit({"token": f"\n\n{line}\n\n"})


async def _ask(db: Any, state: Mapping[str, Any], event: dict[str, Any]) -> None:
    if await _save_choice(db, state, event):
        waiting(event["id"], "answer")
        emit(event)


async def _save_choice(db: Any, state: Mapping[str, Any], event: dict[str, Any]) -> bool:
    if db is None:
        return True
    approval_id = UUID(str(event["id"]))
    row = await db.q().fetchrow("SELECT id FROM approvals WHERE id = $1", approval_id)
    if row is not None:
        return False
    await insert_chat_approval(db, state.get("user_id"), state.get("conversation_id"), event, None)
    return True


def _artifact_body(name: str, output: dict) -> str:
    if name.endswith(".md"):
        text = output.get("markdown") or output.get("text")
        if isinstance(text, str) and text.strip():
            return text
    return json.dumps(output, ensure_ascii=False, indent=2)


def _context(db, state: dict) -> ToolContext:
    return ToolContext(
        user_id=str(state.get("user_id") or ""),
        company_id=None,
        conversation_id=str(state.get("conversation_id") or ""),
        job_id=job_of(state),
        tool_call_id="",
        db=db,
        core=bound_core.get(),
        inputs=dict(state.get("inputs") or {}),
    )


def _targets(state: dict) -> list[str]:
    picked = [str(item) for item in (state.get("output_targets") or []) if str(item) in _TARGET_IDS]
    return picked or ["resume"]


def target_body(state: dict, output: dict, target: str, body: str) -> str:
    """markdown holds the first target; documents holds every other one."""
    if target == _targets(state)[0]:
        return body
    documents = output.get("documents")
    text = documents.get(target) if isinstance(documents, dict) else None
    return text if isinstance(text, str) and text.strip() else body


def _draft_bodies(output: dict) -> list[str]:
    """Every document body an output carries: markdown and each of documents."""
    documents = output.get("documents") if isinstance(output.get("documents"), dict) else {}
    bodies = (output.get("markdown"), *documents.values())
    return [body for body in bodies if isinstance(body, str) and body.strip()]


def _bodies(phase: str, state: dict, output: dict) -> list[tuple[str, str]]:
    if phase == "craft":
        version = int(state.get("draft_version") or 1)
        body = _artifact_body(f"03_draft_resume_v{version}.md", output)
        return [
            (f"03_draft_{target}_v{version}.md", target_body(state, output, target, body))
            for target in _targets(state)
        ]
    if phase == "publish":
        body = _artifact_body("05_final_resume.md", output)
        drafts = state.get("drafts") if isinstance(state.get("drafts"), dict) else {}
        return [
            (f"05_final_{target}.md",
             target_body(state, output, target, target_body(state, drafts, target, body)))
            for target in _targets(state)
        ]
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


def _has_submit(answer: dict) -> bool:
    if str(answer.get("option_id") or "") == "submit":
        return True
    return "submit" in _option_ids(answer)


def _answer_ids(answer: dict) -> list[str]:
    ids = _option_ids(answer)
    option_id = answer.get("option_id")
    if option_id:
        text = str(option_id)
        if text and text not in ids:
            return [text, *ids]
    return ids


def _section_answer(sections: list, answer: dict) -> dict[str, list[str]]:
    """Bucket picks with the card the server built. Do not trust a client section label."""
    submitted = _has_submit(answer)
    picked = [item for item in _answer_ids(answer) if item != "submit"]
    out: dict[str, list[str]] = {}
    for section in sections:
        if not isinstance(section, dict) or section.get("kind") == "rows":
            continue
        kind = section.get("kind")
        offered = [
            opt["id"]
            for opt in (section.get("options") or [])
            if isinstance(opt, dict) and opt.get("id")
        ]
        offered_set = set(offered)
        if section.get("multiple"):
            chosen = [item for item in picked if item in offered_set]
        else:
            chosen = [item for item in offered if item in picked]
            if kind != "toggle":
                chosen = chosen[:1]
        if submitted:
            if kind == "toggle":
                chosen = [item for item in offered if item in picked]
            elif not chosen:
                chosen = [item for item in (section.get("selected") or []) if item in offered_set]
        elif kind == "toggle" and not chosen:
            chosen = [item for item in (section.get("selected") or []) if item in offered_set]
        out[str(section.get("id") or "")] = chosen
    return out


def _apply_answer(state: dict, phase: str, answer: dict) -> dict:
    update: dict = {}
    option_id = answer.get("option_id")
    if phase == "mode_select" and option_id in {"resume_based", "experience_blueprint"}:
        update["work_mode"] = option_id
    if phase == "review":
        buckets = _section_answer(_review_sections(), answer)
        template_ids = buckets.get("template") or []
        if template_ids:
            update["template"] = template_ids[0]
        elif option_id in _TEMPLATES:
            update["template"] = option_id
        update["profile_photo"] = True
    if phase == "output_targets":
        buckets = _section_answer(
            intake_panel(state.get("inputs") or {}, state.get("analysis")),
            answer,
        )
        picked = list(buckets.get("targets") or [])
        if not picked:
            picked = [item for item in _option_ids(answer) if item in _TARGET_IDS]
            if not picked and option_id in _TARGET_IDS:
                picked = [str(option_id)]
        if picked:
            update["output_targets"] = picked
        tone_ids = buckets.get("tone") or []
        if tone_ids:
            update["tone"] = str(tone_ids[0])
        if "materials" in buckets:
            offered = [
                option["id"]
                for section in intake_panel(state.get("inputs") or {}, state.get("analysis"))
                if section["id"] == "materials"
                for option in section["options"]
            ]
            update["inputs"] = without_materials(
                state.get("inputs") or {}, [m for m in offered if m not in buckets["materials"]]
            )
    if phase == "tone" and option_id and option_id != "submit":
        update["tone"] = str(option_id)
    if phase == "projects" and option_id:
        update["chosen_project"] = str(option_id)
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
    github = [*github_links(inputs.get("github")), *github_links(extra.get("github"))]
    if github:
        merged["github"] = list(dict.fromkeys(github))
    links = [*(inputs.get("links") or []), *(extra.get("links") or [])]
    if links:
        merged["links"] = list(dict.fromkeys(links))
    for key in ("documentId", "postingId"):
        if extra.get(key):
            merged[key] = str(extra[key])
    if isinstance(extra.get("posting"), dict):
        merged["posting"] = extra["posting"]
    # A new posting or page re-freezes the fit terms on the next analyze.
    if any(extra.get(key) for key in ("pages", "posting", "postingId")):
        merged.pop("fit_posting", None)
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
# The explore loop reads attachments itself and leaves scoring to classify_scenario.
_EXPLORE_TOOLS = [tool for name, tool in _READ_TOOLS.items() if name not in {"parse_attachment", "compute_fit"}]
_LEDGER_PHASES = frozenset({"strategy", "craft", "review", "publish"})


async def _read_tool(call: dict, ctx: ToolContext) -> dict:
    tool = _READ_TOOLS.get(call["name"])
    if tool is None:
        return {"error": "UNKNOWN_TOOL"}
    try:
        args = tool.args_model.model_validate(call.get("args") or {})
    except ValidationError:
        return {"error": "INVALID_ARGS"}
    result, _ok, retried = await call_retrying(tool, args, replace(ctx, tool_call_id=call["id"]))
    line = {
        "type": "tool",
        "name": tool.name,
        "state": "err" if "error" in result else "ok",
        "summary": tool.summarize(args),
        "tier": tool.tier.value,
    }
    if retried:
        line["warning"] = RETRY_WARNING
    emit(line)
    return result


# A stored 서류 has no tool that reads it, so its text rides in the state the phase prompt gets.
_RESUME_TEXT_LIMIT = 20_000


async def _phase_context(phase: str, state: dict, ctx: ToolContext) -> dict:
    context = {
        key: state.get(key)
        for key in (
            "phase",
            "work_mode",
            "scenario",
            "inputs",
            "analysis",
            "strategy",
            "drafts",
            "review",
            "template",
            "output_targets",
            "fit_from",
            "approach",
            "bottleneck_level",
            "prevention_categories",
            "verify_feedback",
            "review_objections",
        )
    }
    resume_text = await load_document_markdown(ctx.db, state)
    if resume_text:
        cut = len(resume_text) > _RESUME_TEXT_LIMIT
        context["resume_text"] = resume_text[:_RESUME_TEXT_LIMIT] + ("\n…(이하 생략)" if cut else "")
    if phase in _LEDGER_PHASES:
        context["evidence_ledger"] = ledger_text(await load_notes(ctx))
    return context


async def _output(model, phase: str, state: dict, ctx: ToolContext) -> dict:
    if model is None:
        return {"summary": phase}
    context = await _phase_context(phase, state, ctx)
    prompt = phase_instructions(phase, state)
    messages = [
        SystemMessage(
            content=prompt
            + "\n\n결과는 JSON 객체 하나로만 답하고, 사용자에게 보여줄 한두 문장은 message 키에 넣는다."
            + "\n\n" + DATA_RULE
        ),
        HumanMessage(
            content=as_data(json.dumps(context, ensure_ascii=False), "resume_state", None)),
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
            messages.append(
                ToolMessage(
                    content=as_data(json.dumps(result, ensure_ascii=False), str(call.get("name"))),
                    tool_call_id=call["id"])
            )


def _reply(phase: str, output: dict) -> str:
    for key in ("message", "summary", "text"):
        value = output.get(key)
        if isinstance(value, str) and value.strip() and value != phase:
            return value.strip()
    return _PHASE_DONE[phase]


_IMPROVEMENTS_NOTE = (
    "공고 분석은 jobs 객체 하나에 {company, title, required: [필수 요건], preferred: [우대 사항], "
    "keywords: [핵심어]}로 넣는다. GitHub 분석은 github 객체에 넣는다. "
    "inputs.pages에 공고 본문이 있으면 그 본문으로 jobs를 채우고 read_error를 넣지 않는다. "
    "공고에 맞추려면 고칠 점을 짧은 문장 3개로 improvements 배열에 넣는다. "
    "같은 내용을 feedback 배열({tag: 키워드|도메인|성과|기술|경력, problem, fix})로도 넣는다. "
    "페이지를 읽지 못하면 jobs.read_error에 이유를 '로그인이 필요한 영역'처럼 짧은 명사구로 넣는다. "
    "회사 정보는 company 객체 {name, services, stack, news, culture, sources: [출처 URL]}에 넣는다. "
    "출처 없는 회사 정보는 넣지 않는다. "
    "회사 사이트나 기술 블로그 주소가 공고 본문, inputs.links, 회사 조사 결과에 있으면 "
    "open_page로 한두 개 열어 확인한다. "
    "GitHub은 explore_github로 공고와 맞는 저장소만 예산 안에서 고른 뒤, 저장소마다 read_github를 path 없이 "
    "불러 파일 목록을 보고 package.json 같은 설정 파일과 핵심 소스 파일 2~3개를 읽는다. "
    "읽은 파일에서 확인한 기술과 구현만 github.evidence 배열({repo, path, finding})에 넣고 근거로 쓴다."
)
_STRATEGY_NOTE = (
    "섹션별 전략을 sections 배열에 넣는다. 각 항목은 "
    "{section, action(keep|modify|expand|add|condense|remove), reason, suggested_keywords}다."
)
# Three generic stances; a plan runs the first `budget.reviewers` of them. They object, the main model decides.
_REVIEWERS = (
    Reviewer(
        "review_reader", "서류를 거르는 사람 눈으로 봐요",
        "너는 이 공고로 지원 서류를 거르는 사람이다. 시간이 없어 서류 하나를 몇 초만 본다.\n"
        "이 전략대로 쓴 서류에서 읽기를 멈추게 만들 항목을 찾는다: 공고와 이어지지 않는 강조, "
        "앞에 와야 할 내용이 뒤에 묻힌 배치, 흐릿한 표현.\n"
        "brief.subject.steer는 사용자가 직접 한 말이다. 사용자가 강조해 달라고 한 것에는 반대하지 않는다.",
    ),
    Reviewer(
        "review_interviewer", "면접관 눈으로 봐요",
        "너는 서류의 주장을 하나하나 파고들 면접관이다.\n"
        "이 전략이 강조하려는 내용 가운데 brief.subject.ledger의 확인된 근거(E1 같은 id)가 받쳐 주지 않는 "
        "항목을 찾는다.\n"
        "brief.subject.steer는 사용자가 직접 한 말이다. 사용자가 강조해 달라고 한 것에는 반대하지 않는다.",
    ),
    Reviewer(
        "review_editor", "편집자 눈으로 봐요",
        "너는 이 서류를 3분의 1 줄여야 하는 편집자다.\n"
        "자리 값을 가장 못 하는 섹션과 다른 섹션과 겹치는 내용을 찾는다.\n"
        "brief.subject.steer는 사용자가 직접 한 말이다. 사용자가 강조해 달라고 한 것에는 반대하지 않는다.",
    ),
)
_ASK_VERDICT = {"remove": "cut", "condense": "lighten"}


def _strategy_items(output: dict) -> list[dict]:
    """Strategy sections with ids, so a reviewer's objection points at one."""
    sections = output.get("sections") if isinstance(output, dict) else None
    return [{"id": f"s{index}", **item} for index, item in enumerate(sections or [], 1) if isinstance(item, dict)]


def _strategy_usable(output: dict) -> bool:
    return output.get("valid") is not False and bool(_strategy_items(output))


def _user_words(state: dict, notes) -> list[str]:
    """What the user said in this flow: steering messages and gate answers typed in."""
    inputs = state.get("inputs") if isinstance(state.get("inputs"), dict) else {}
    said = [*(inputs.get("steer") or []), inputs.get("gate_text") or "", *(notes.get("steer") or [])]
    return list(dict.fromkeys(str(item) for item in said if str(item).strip()))


def strategy_asks(output: dict, said: list[str]) -> list[dict]:
    """Sections the plan removes or condenses that the user named in their own words: the only ask."""
    heard = [squash(text).casefold() for text in said]
    items = []
    for item in _strategy_items(output):
        label = squash(str(item.get("section") or "")).casefold()
        verdict = _ASK_VERDICT.get(str(item.get("action") or "").strip().lower())
        if verdict and label and any(label in text for text in heard):
            items.append({"source": "user", "verdict": verdict, "what": str(item["section"]).strip(),
                          "why": str(item.get("reason") or "").strip()})
    return needs_ask(items)


def _strategy_ask(state: dict) -> list[dict]:
    strategy = state.get("strategy") if isinstance(state.get("strategy"), dict) else {}
    items = strategy.get("ask_items")
    return [item for item in items if isinstance(item, dict)] if isinstance(items, list) else []


def _restored(current: dict) -> dict:
    """'다시 넣기' steers strategy to keep what it dropped, and strategy runs again without a second ask."""
    inputs = dict(current.get("inputs") or {})
    said = [f"다시 넣기: {item['what']}" for item in _strategy_ask(current)]
    inputs["steer"] = list(dict.fromkeys([*(inputs.get("steer") or []), *said]))
    strategy = {**(current.get("strategy") or {}), "ask_items": []}
    return {"inputs": inputs, "strategy": strategy, "status": "active", "phase": "strategy", "goto": "end",
            "gate_epoch": int(current.get("gate_epoch") or 0) + 1}


_TARGET_LABELS = {"resume": "이력서", "portfolio": "포트폴리오", "cover_letter": "자기소개서"}
_LATE_LABELS = {"posting": "공고 읽기", "resume": "서류 읽기", "company": "회사 조사"}


def _stage_label(name: str) -> str:
    kind, _, what = name.partition(":")
    if kind == "github" and what:
        return f"GitHub 읽기 ({what})"
    if kind == "attachment":
        return "첨부 파일 읽기"
    return _LATE_LABELS.get(name, name)


def present_message(view: dict, notes, *, extras: bool, saved: str = "") -> str:
    """The fixed closing message: made, decided for the user, left to check, one next step.
    `saved` says where the document was saved (a file name, the Push profile); "" when it failed."""
    made: list[str] = []
    drafted = bool(draft_text(view.get("drafts")))
    if drafted:
        labels = [_TARGET_LABELS[target] for target in _targets(view)]
        made = [f"{labels[0]} · {saved}" if saved else labels[0], *labels[1:]]
    drafts = view.get("drafts") if isinstance(view.get("drafts"), dict) else {}
    analysis = view.get("analysis") if isinstance(view.get("analysis"), dict) else {}
    left = verify_items([item for item in drafts.get("verify_left") or [] if isinstance(item, dict)])
    if drafted and not saved:
        left.append("저장하지 못했어요. 다시 시도해 주세요.")
    left += late_lines([_stage_label(str(item)) for item in analysis.get("stage_late") or []], {})
    failed = dict.fromkeys(_stage_label(str(item)) for item in analysis.get("stage_failed") or [])
    left += [f"{label}: 끝내지 못해 빼고 진행했어요" for label in failed]
    nxt = ""
    if extras:
        missing = [label for target, label in _TARGET_LABELS.items() if target not in _targets(view)]
        if made and missing:
            nxt = f"같은 근거로 {', '.join(missing)}도 만들 수 있어요. 원하면 말해 주세요."
    return render(Final(made=made, decided=list(notes.get("assumptions") or []), left=left, next=nxt))


_FIT_NOTE = (
    "적합도 점수는 fit_from 값을 소수 첫째 자리까지 그대로 쓰고 새로 추정하지 않는다. "
    "fit_from이 없으면 점수를 말하지 않는다."
)
_BODY_NOTE = (
    "evidence_ledger의 근거를 쓴 문장은 그 id(E3 같은)를 used_evidence 배열에 모두 넣는다. "
    "근거 없는 수치는 쓰지 않는다. "
    "verify_feedback이 있으면 그 문제를 모두 고친다. "
    "서류 본문 전체를 마크다운으로 markdown 키에 넣는다. message에는 본문을 넣지 않고 한두 문장만 쓴다. "
    "바꾼 점은 changes 배열에 짧은 문장으로 넣는다."
)
_REVIEW_NOTE = (
    "바로 고친 것을 auto_fixes 배열({line, before, after})에, 추천 수정을 "
    "recommendations 배열({label, desc, priority: P1|P2}, 최대 6개)에 넣는다. "
    "추천 수정은 묻지 않고 모두 반영한다. "
    "디자인을 추천할 때는 화면에 있는 클래식, 모던, 컴팩트, ATS 중에서만 고른다."
)
_BLUEPRINTS_NOTE = (
    "기획서 요약을 projects 배열에 넣는다. 각 항목은 {id, title, category, stack}이다. "
    "id는 p1, p2처럼 짧게, category는 안정성처럼 한 단어, stack은 기술 이름 배열이다. "
    "기획서 본문은 message에 쓰지 않는다."
)
_VALIDATE_BP_NOTE = (
    "projects 배열에 기획서마다 {id, verdict}를 넣는다. verdict는 pass, conditional, fail 중 하나다. "
    "다른 기준은 통과하지만 한 가지가 약하면 conditional로 둔다."
)
_BOTTLENECK_STEPS = (
    "이번에는 content-strategy Step 1–3만 수행한다"
    "(기술 스택 매칭, 적합도 산정, 프로젝트 경험 재평가). "
    "Step 4 이후 섹션 수정 전략과 자기소개서 전략은 쓰지 않는다."
)


def phase_instructions(phase: str, state: dict) -> str:
    text = phase_prompt_for_harness(phase)
    if phase == "strategy":
        if (state.get("strategy") or {}).get("focus") == "bottleneck":
            text = f"{text}\n{_BOTTLENECK_STEPS}"
        text = f"{text}\n{_STRATEGY_NOTE}"
    if phase in {"publish", "present"} and resume_source(state) == "external":
        text = f"{text}\n{_EXTERNAL_NOTE}"
    if phase == "publish":
        review = state.get("review") if isinstance(state.get("review"), dict) else {}
        apply = review.get("apply")
        if isinstance(apply, list) and apply:
            names = ", ".join(str(item) for item in apply if str(item).strip())
            extra = "review.apply의 수정만 반영한다."
            if names:
                extra = f"{extra} {names}"
            text = f"{text}\n{extra}"
    if phase == "analyze":
        text = f"{text}\n{_IMPROVEMENTS_NOTE}"
    if phase == "blueprints":
        text = f"{text}\n{_BLUEPRINTS_NOTE}"
    if phase == "review":
        text = f"{text}\n{_REVIEW_NOTE}"
    if phase in {"strategy", "craft", "review", "publish", "present"}:
        text = f"{text}\n{_FIT_NOTE}"
    if phase in {"craft", "publish"}:
        text = f"{text}\n{_BODY_NOTE}"
        targets = _targets(state)
        if targets != ["resume"]:
            text = f"{text}\n{_targets_note(targets)}"
    return text


_TARGET_FORMS = {
    "resume": "이력서",
    "portfolio": "포트폴리오. 프로젝트마다 문제, 접근, 결과, 기술 선택 이유를 풀어 쓴다",
    "cover_letter": "자기소개서. 지원 동기와 경험을 문단 글로 쓰고 이력서 항목을 나열하지 않는다",
}


def _targets_note(targets: list[str]) -> str:
    rest = targets[1:]
    note = f"markdown에는 {_TARGET_FORMS[targets[0]]} 본문만 넣는다."
    if rest:
        forms = ", ".join(f"{target}: {_TARGET_FORMS[target]}" for target in rest)
        note += (
            f" 나머지 산출물은 documents 객체에 키마다 마크다운 본문 전체를 따로 넣는다({forms})."
            " 산출물마다 형식과 문장이 달라야 하고, 같은 본문을 복사하지 않는다."
            " drafts.documents가 있으면 그것을 고친다."
        )
    return note


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
    "g4a": "g4a",
    "g1": "g1",
    "g_read_failed": "g_read_failed",
}


# A server-answered gate that differs from the recommended pick: a feedback-only request is never
# turned into a rewrite the user did not ask for.
_AUTO_PICK = {"feedback": "keep"}


def _auto_answer(gate_id: str, state: dict | None = None) -> dict:
    state = state or {}
    if gate_id in _AUTO_PICK:
        return {"option_id": _AUTO_PICK[gate_id]}
    if gate_id == "output_targets":
        ids = ["submit"]
        for section in intake_panel(state.get("inputs") or {}, state.get("analysis")):
            if section.get("kind") == "rows":
                continue
            ids.extend(section.get("selected") or [])
        return {"option_id": "submit", "option_ids": ids}
    if gate_id == "review":
        return {"option_id": "submit", "option_ids": ["submit", "CLASSIC"]}
    recommended = _GATES[gate_id]["recommended"] or (_gate_options(state, gate_id) or [{"id": ""}])[0]["id"]
    if _GATES[gate_id].get("multiple"):
        return {"option_id": recommended, "option_ids": [recommended]}
    return {"option_id": recommended}


def _advance(merged: dict, gate_id: str, update: dict) -> dict:
    if gate_id == "output_targets":
        goto = "g_intake" if merged.get("tone") else "g_tone"
        return {**update, "status": "active", "phase": "intake", "goto": goto}
    if gate_id in _INTAKE_NEXT:
        return {**update, "status": "active", "phase": "intake", "goto": _INTAKE_NEXT[gate_id]}
    if gate_id == "approach":
        nxt = "g_level" if merged.get("approach") == "bottleneck" else "g_prevention"
        return {**update, "status": "active", "phase": "approach", "goto": nxt}
    if gate_id in {"level", "prevention"}:
        return {**update, "status": "active", "phase": "approach", "goto": "p2x_validate"}
    if gate_id == "validate_cap":
        capped_at_approach = merged.get("phase") == "approach"
        return {
            **update,
            "validation_failures": 0,
            "status": "active",
            "phase": "approach" if capped_at_approach else "blueprints",
            "goto": "p2x_validate" if capped_at_approach else "end",
        }
    if gate_id == "projects":
        return {**update, "status": "done", "phase": "blueprints", "goto": "end"}
    if gate_id == "analyze" and _scenario_letter(merged) == "E":
        return {
            **update,
            "drafts": drafts_from_chosen(merged.get("drafts"), merged.get("inputs")),
            "status": "active",
            "phase": "craft",
            "goto": "end",
        }
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


async def _emit_papers(db, state: dict, stored: dict) -> None:
    version = int(state.get("draft_version") or 1)
    drafts = stored.get("drafts") if isinstance(stored.get("drafts"), dict) else {}
    markdown = draft_text(drafts)
    if not isinstance(markdown, str) or not markdown.strip():
        return
    name, headline = await profile_card_names(db, state)
    fallback = " · ".join(part for part in (name, headline) if part)
    for target in _targets(state):
        event = paper_event(target, version, target_body(state, drafts, target, markdown), fallback)
        if event is not None:
            emit(event)


def _quality_pending(state: dict) -> bool:
    review = state.get("review") if isinstance(state.get("review"), dict) else {}
    if "apply" in review:
        return False
    recs = review.get("recommendations")
    return isinstance(recs, list) and any(
        isinstance(item, dict) and str(item.get("label") or "").strip() for item in recs
    )


def build_resume_graph(checkpointer, *, model=None, db=None):
    def current_of(state: ResumeGraphState) -> dict:
        return ResumeState.model_validate(state).model_dump()

    def work_node(phase: str):
        async def node(state: ResumeGraphState) -> dict:
            current = {**current_of(state), "phase": phase}
            stamped: dict = {}
            if phase in {"publish", "present"}:
                stamped = await resolve_uploaded_source(db, current)
                if stamped:
                    current = {**current, **stamped}
            if phase == "analyze":
                emit(todo_event("analyze", analyze_steps(current.get("inputs") or {})[0], 0))
            chat = turn_model.get() or model
            started = time.monotonic()
            if phase == "analyze" and chat is not None:
                output = await explore(chat, current)
            elif phase == "present":
                # The closing message is built by code (present_message); no model call for it.
                output = {"message": _PHASE_DONE["present"]}
            else:
                output = await _output(chat, phase, current, _context(db, current))
            findings: list[dict] = []
            if phase in {"craft", "publish"} and chat is not None:
                output, findings = await verified_craft(chat, current, output, phase)
            if phase == "strategy" and chat is not None:
                output = await reviewed_strategy(chat, current, output)
            if chat is not None and phase in _THINK_PHASES:
                emit(think_event(phase, time.monotonic() - started))
            if phase == "analyze":
                output = normalize_analysis(current.get("inputs") or {}, output)
            stored = await _store_output(db, current, phase, output)
            if phase == "publish" and _draft_bodies(output):
                # The final body replaces the draft's findings: the closing message lists its own.
                stored["drafts"] = {**(current.get("drafts") or {}), "verify_left": findings}
            if phase == "strategy" and output.get("valid") is not False:
                plan = strategy_plan(output)
                if plan is not None:
                    emit(strategy_line(plan))
                    emit(plan)
            if phase == "craft":
                await _emit_papers(db, current, stored)
                doc_id = await save_profile_document({**current, **stored})
                if doc_id:
                    stored["profile_document_id"] = doc_id
            saved_to = ""
            if phase == "present":
                view = {**current, **stored}
                drafted = bool(draft_text(view.get("drafts")))
                known = str(view.get("profile_document_id") or "")
                if resume_source(view) == "external" and drafted:
                    working(SAVE_DOCUMENT)
                    display_name, _headline = await profile_card_names(db, view)
                    saved = await save_edited_file(db, view, edited_pdf_name(view, display_name))
                    if saved.get("documentId"):
                        stored["profile_document_id"] = saved["documentId"]
                    stored["source_saved"] = bool(saved.get("stored"))
                    saved_to = str(saved.get("fileName") or "") if saved.get("stored") else ""
                    emit(_todo(_file_steps(view)))
                    emit({**_file_result(saved, view), **_done(view, "external")})
                elif resume_source(view) != "external" and (drafted or known):
                    doc_id = known
                    if drafted:
                        working(SAVE_DOCUMENT)
                        emit({"token": "Push 프로필에 저장하는 중…"})
                        doc_id = await save_profile_document(view) or known
                    if doc_id:
                        stored["profile_document_id"] = doc_id
                        saved_to = "Push 프로필에 저장"
                    name, headline = await profile_card_names(db, view)
                    emit(_todo(_PROFILE_STEPS))
                    card = _profile_result(doc_id, name, headline, view)
                    emit({**card, **_done(view, "profile")})
            reply = _reply(phase, output)
            if phase == "craft":
                changes = (stored.get("drafts") or {}).get("changes")
                reply = craft_text(
                    int(current.get("draft_version") or 1),
                    [str(item) for item in changes] if isinstance(changes, list) else [],
                    str(stored.get("profile_document_id") or current.get("profile_document_id") or ""),
                ) or reply
                left = verify_text(findings)
                if left:
                    reply = f"{reply}\n\n{left}"
            if phase == "blueprints":
                reply = blueprints_text(output) or reply
            if phase == "present":
                view = {**current, **stored}
                notes = await load_notes(_context(db, view))
                extras = budget_for(await user_plan(view)).extras
                reply = present_message(view, notes, extras=extras, saved=saved_to) or reply
            emit({"token": reply})
            stored = {**stored, "reply": reply, "reply_job": running_job(), "retry": False}
            if stamped.get("inputs"):
                stored["inputs"] = stamped["inputs"]
            retries = int((current.get("strategy") or {}).get("retries") or 0)
            if phase == "strategy" and output.get("valid") is False and retries < 2:
                stored["strategy"] = {**stored["strategy"], "retries": retries + 1}
                return {**stored, "phase": "strategy", "status": "active", "retry": True}
            return stored

        return node

    async def user_plan(state: dict) -> str:
        from app.infrastructure.posting_fit_cache import read_plan

        return await read_plan(None if db is None else db.q(), _fit_user(state)) or ""

    async def explore(chat, current: dict) -> dict:
        ctx = _context(db, current)
        terms = _job_terms(current.get("analysis") or {}) if isinstance(current.get("analysis"), dict) else []
        if not terms:
            terms = posting_terms(" ".join(str(text) for text in ((current.get("inputs") or {}).get("pages") or {}).values()))

        async def agent(repo: str, focus: str) -> dict:
            target = await _repo_target(ctx, repo)
            if isinstance(target, dict):
                return target
            owner, name = target
            # Only an account link names the user: a repo link's owner may be an organisation.
            targets = await _github_targets(ctx)
            logins = list(dict.fromkeys(item for item, linked in targets if linked is None))
            found = await github_agent(light_model(chat) or chat, owner, name, logins=logins, emit=emit,
                                       focus=focus or ", ".join(list(terms)[:15]))
            if "error" not in found:
                await save_artifact(ctx, f"01_github_{owner}_{name}.json",
                                    json.dumps(found, ensure_ascii=False))
            return found

        pages = {str(url): str(text) for url, text in ((current.get("inputs") or {}).get("pages") or {}).items()}

        async def search(company: str, focus: str) -> str:
            from app.harness.personal.tools import bound_services

            svc = bound_services.get()
            gate = getattr(svc, "ai", None) if svc is not None else None
            if gate is None or not hasattr(gate, "company_research"):
                return ""
            try:
                user_id = UUID(ctx.user_id)
            except ValueError:
                user_id = None
            posting = "\n\n".join(pages.values())
            return await gate.company_research(company, context=f"{posting}\n\n조사 초점: {focus}",
                                               user_id=user_id, job_id=ctx.usage_job_id or None)

        async def stage(documents: list[dict], only: list[str]) -> dict:
            light = light_model(chat)
            if light is None:
                return {}

            async def save(name: str, body: dict) -> None:
                await save_artifact(ctx, name, json.dumps(body, ensure_ascii=False))

            return await stage_one(light, pages=pages, documents=documents, search=search, emit=emit, save=save,
                                   only=only)

        turn = getattr(chat, "turn", None)
        turn = turn if isinstance(turn, dict) else {}

        def main_tokens() -> int:
            return int(((turn.get("tiers") or {}).get("main") or {}).get("in") or 0)

        spent = main_tokens()
        return await run_explore(
            chat, current, ctx,
            budget=budget_for(await user_plan(current)),
            # Only what this explore loop reads counts against its input-token budget: its subagents
            # run on other tiers.
            used_tokens=lambda: main_tokens() - spent,
            system=phase_instructions("analyze", current),
            context=await _phase_context("analyze", current, ctx),
            tools=_EXPLORE_TOOLS,
            agent=agent,
            read_attachment=attachment_reader(ctx),
            stage=stage,
        )

    def attachment_reader(ctx: ToolContext):
        async def read(attachment_id: str) -> dict:
            spec = _READ_TOOLS["parse_attachment"]
            args = spec.args_model.model_validate({"attachment_id": attachment_id})
            return await spec.run(ctx, args)

        return read

    async def user_sources(current: dict, ctx: ToolContext, notes) -> str:
        """Everything the user gave this flow: the document, every attachment, every page, what
        they typed. A true fact from any of them must not read as made up."""
        inputs = current.get("inputs") if isinstance(current.get("inputs"), dict) else {}
        early = await prefetch(current, read=attachment_reader(ctx))
        parts = [
            await resume_text(current),
            *(item["text"] for item in early["attachments"]),
            *(str(text) for text in (inputs.get("pages") or {}).values()),
            *_user_words(current, notes),
        ]
        return "\n\n".join(part for part in parts if part.strip())

    async def verified_craft(chat, current: dict, output: dict,
                             phase: str = "craft") -> tuple[dict, list[dict]]:
        """Every document body a phase writes (craft, each boost, publish) passes the same checks;
        one redo, then what is left goes to `verify_left` for the closing message."""
        ctx = _context(db, current)
        notes = await load_notes(ctx)

        async def check(result: dict) -> list[dict]:
            bodies = _draft_bodies(result)
            if not bodies:
                return []
            used = [str(item) for item in result.get("used_evidence") or []
                    if isinstance(item, str)]
            found = verify_draft("\n\n".join(bodies), used, notes, resume_text=source_text)
            light = light_model(chat)
            if light is None:
                return found
            sources = f"{source_text}\n\n{ledger_text(notes)}"
            checked = await asyncio.gather(
                *(fact_check_agent(light, body, sources, emit) for body in bodies),
                return_exceptions=True)
            failed = [item for item in checked if isinstance(item, BaseException)]
            if failed:
                logging.getLogger(__name__).warning("fact check failed: %r", failed[0])
                # Not checked is not "nothing found": the user is told; no redo for it.
                found.append(finding("P1", "fact_unchecked", "사실 대조를 끝내지 못했어요"))
            return found + [{"level": "P0", "rule": "fact_mismatch", "detail": item["sentence"]}
                            for items in checked if isinstance(items, list) for item in items]

        async def redo(findings: list[dict]) -> dict:
            return await _output(chat, phase, {**current, "verify_feedback": findings}, ctx)

        source_text = await user_sources(current, ctx, notes)
        output, findings = await fix_once(
            output, check, redo, lambda result: bool(str(result.get("markdown") or "").strip()))
        return {**output, "verify_left": findings}, findings

    async def reviewed_strategy(chat, current: dict, output: dict) -> dict:
        """Reviewers object, the main model redoes the strategy once, then the ask policy runs."""
        ctx = _context(db, current)
        notes = await load_notes(ctx)
        said = _user_words(current, notes)
        count = budget_for(await user_plan(current)).reviewers if _strategy_usable(output) else 0
        if count:
            analysis = current.get("analysis") if isinstance(current.get("analysis"), dict) else {}
            subject = {"items": _strategy_items(output), "posting": analysis.get("jobs") or {},
                       "ledger": ledger_text(notes), "steer": said}
            reviewed = await _soft(run_reviewers(mid_model(chat), list(_REVIEWERS[:count]), subject, emit), {})
            objections = reviewed.get("objections") or []
            if objections:
                redo = await _output(chat, "strategy", {**current, "review_objections": objections}, ctx)
                # An invalid redo leaves the first strategy in place.
                if _strategy_usable(redo):
                    output = redo
        if output.get("valid") is False:
            return output
        items = strategy_asks(output, said)
        if items and ask_once(notes):
            notes["ask"] = {"question": ask_title(items), "options": [option["label"] for option in ask_options()]}
            await save_notes(ctx, notes)
        else:
            items = []
        return {**output, "ask_items": items}

    async def decided(current: dict, event: dict) -> None:
        """A decision the server made for the user goes to the assumption log the closing message reads."""
        line = auto_pick_line(event)
        if not line:
            return
        ctx = _context(db, current)
        notes = await load_notes(ctx)
        cut = _strategy_ask(current) if event.get("gate") == "strategy" else []
        if cut:
            # Kept the plan: the named items it cut or lightened are the decision made for them.
            what = ", ".join(item["what"] for item in cut)
            assume(notes, f"말씀하신 항목을 줄이거나 뺐어요: {what}")
        else:
            assume(notes, f"{event['title']} → {line.split(': ', 1)[-1]}")
        await save_notes(ctx, notes)

    async def accepted(current: dict, gate_id: str, answer: dict) -> dict:
        update = _apply_answer(current, gate_id, answer)
        merged = {**current, **update}
        if gate_id == "intake":
            artifacts = dict(merged.get("artifacts") or {})
            body = json.dumps(
                {
                    "work_mode": merged.get("work_mode"),
                    "output_targets": _targets(merged),
                    "tone": merged.get("tone"),
                },
                ensure_ascii=False,
                indent=2,
            )
            artifacts["01_scenario.json"] = await save_artifact(
                _context(db, merged), "01_scenario.json", body
            )
            update["artifacts"] = artifacts
            merged = {**merged, "artifacts": artifacts}
        if gate_id == "review":
            artifacts = dict(merged.get("artifacts") or {})
            scenario = {
                "work_mode": merged.get("work_mode"),
                "output_targets": _targets(merged),
                "tone": merged.get("tone"),
                "approach": merged.get("approach"),
                "bottleneck_level": merged.get("bottleneck_level"),
                "prevention_categories": list(merged.get("prevention_categories") or []),
                "template": merged.get("template"),
                "profile_photo": bool(merged.get("profile_photo", True)),
            }
            artifacts["01_scenario.json"] = await save_artifact(
                _context(db, merged),
                "01_scenario.json",
                json.dumps(scenario, ensure_ascii=False, indent=2),
            )
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
                _context(db, merged),
                "01_scenario.json",
                json.dumps(scenario, ensure_ascii=False, indent=2),
            )
            update["artifacts"] = artifacts
            merged = {**merged, "artifacts": artifacts}
        return _advance(merged, gate_id, update)

    def gate_node(gate_id: str):
        async def node(state: ResumeGraphState) -> dict:
            current = current_of(state)
            if gate_id == "analyze" and _scenario_letter(current) == "E":
                return await accepted(current, gate_id, {"option_id": "continue"})
            if not _must_stop(current, gate_id):
                if gate_id not in _INTAKE_NEXT and (gate_id in _NEVER_ASKED or len(_gate_options(current, gate_id)) > 1):
                    event = _choice(current, gate_id, auto=True)
                    _emit_auto(event)
                    if gate_id in _DECISION_GATES:
                        await decided(current, event)
                answer = _auto_answer(gate_id, current)
                if gate_id == "feedback" and answer.get("option_id") == "keep":
                    return {"status": "done", "phase": "feedback", "goto": "end"}
                return await accepted(current, gate_id, answer)
            asks = int(current.get("intake_asks") or 0)
            event = _choice(
                current,
                gate_id,
                auto=False,
                cycle=asks if gate_id == "intake" and asks else None,
            )
            await _ask(db, current, event)
            answer = (
                interrupt(
                    {
                        "approval_id": event["id"],
                        "awaiting": "choice",
                        "kind": "RESUME_GATE",
                        "gate": gate_id,
                    }
                )
                or {}
            )
            if _cancelled(answer):
                return {"status": "cancelled", "phase": current["phase"], "goto": "end"}
            if gate_id == "ask":
                return _answered_ask(current, answer)
            if gate_id == "strategy" and answer.get("option_id") == "restore" and _strategy_ask(current):
                return _restored(current)
            if gate_id == "validate_cap" and answer.get("option_id") == "change":
                return {
                    "validation_failures": 0,
                    "status": "active",
                    "phase": "approach",
                    "goto": "end",
                }
            if gate_id == "feedback" and answer.get("option_id") == "keep":
                return {"status": "done", "phase": "feedback", "goto": "end"}
            if gate_id == "analyze" and answer.get("option_id") == "score":
                return {"status": "done", "phase": "analyze", "goto": "end"}
            if gate_id == "analyze" and answer.get("option_id") == "feedback":
                return {"status": "active", "phase": "feedback", "goto": "end"}
            if gate_id == "intake" and answer.get("option_id") == "change":
                stayed = _apply_answer(current, gate_id, answer)
                return {
                    **stayed,
                    "phase": "intake",
                    "status": "active",
                    "goto": "end",
                    "intake_asks": int(current.get("intake_asks") or 0) + 1,
                }
            if answer.get("text") and not answer.get("option_id") and not _option_ids(answer):
                stayed = _apply_answer(current, gate_id, answer)
                text = str(answer["text"])
                stayed["phase"] = "strategy" if text.startswith("피드백만") else current["phase"]
                stayed["status"] = "active"
                stayed["goto"] = "end"
                if stayed["phase"] == current["phase"]:
                    stayed["gate_epoch"] = int(current.get("gate_epoch") or 0) + 1
                return stayed
            if not answer.get("option_id") and not _option_ids(answer):
                answer = {**answer, **_auto_answer(gate_id, current)}
            return await accepted(current, gate_id, answer)

        return node

    async def score_text(state: dict, text: str) -> dict:
        from app.framework.fit_judge import judge_fit
        from app.harness.personal.tools import current_ai_gate
        from app.infrastructure.posting_fit_cache import read_plan

        user_id = _fit_user(state)
        query = None if db is None else db.q()
        plan = await read_plan(query, user_id)
        posting = _fit_posting(state)
        # Preferred items weigh half a required one only when they are passed as preferred.
        requirements = list(posting["required"]) or list(posting["preferred"])
        preferred = list(posting["preferred"]) if posting["required"] else []
        description = _posting(state)[1]
        return await judge_fit(
            requirements,
            posting["keywords"] or [*requirements, *preferred],
            description,
            text,
            plan,
            gate=current_ai_gate(),
            job_id=job_of(state) or None,
            user_id=user_id,
            preferred=preferred,
        )

    async def score_draft(state: dict) -> dict:
        return await score_text(state, draft_text(state.get("drafts")))

    async def resume_text(state: dict) -> str:
        analysis = state.get("analysis") if isinstance(state.get("analysis"), dict) else {}
        inputs = state.get("inputs") if isinstance(state.get("inputs"), dict) else {}
        text = chosen_document_text(inputs) or await load_document_markdown(db, state)
        if not text and not inputs.get("documentId") and _fit_user(state) is not None:
            text = await _fit_document(_context(db, state), FitArgs())
        return text or json.dumps(analysis.get("resume") or {}, ensure_ascii=False)

    async def analyze_fit(state: dict) -> float | None:
        from app.harness.personal.tools import current_ai_gate

        if current_ai_gate() is None:
            return None
        working(SCORE_FIT)
        text = await resume_text(state)
        try:
            view = await score_text(state, text)
        except Exception:
            logging.getLogger(__name__).warning("analyze fit failed", exc_info=True)
            emit(fit_failed_line())
            notice("적합도를 계산하지 못했어요")
            return None
        score = float(view["fitScore"])
        analysis = state.get("analysis") if isinstance(state.get("analysis"), dict) else {}
        emit(fit_line(score))
        emit(fit_card(view, _job_terms(analysis), text, analysis.get("improvements") or []))
        return score

    async def report_analysis(state: dict) -> float | None:
        analysis = state.get("analysis") if isinstance(state.get("analysis"), dict) else {}
        inputs = state.get("inputs") if isinstance(state.get("inputs"), dict) else {}
        company = analysis.get("company") if isinstance(analysis.get("company"), dict) else {}
        steps, added = analyze_steps(inputs, analysis, company=bool(company))
        lines = {
            "resume": lambda: resume_line(inputs, analysis),
            "github": lambda: github_line(analysis),
            "company": lambda: company_line([str(url) for url in company.get("sources") or []]),
            "posting": lambda: posting_line(analysis),
        }
        failed = posting_unreadable(inputs, analysis)
        fit_from = None
        for index, (key, _text) in enumerate(steps):
            if key == "fit":
                if not failed:
                    fit_from = await analyze_fit(state)
            elif key == "posting" and failed:
                line = posting_line(analysis, failed=True)
                emit(line)
                notice(line["resultLine"])
            else:
                emit(lines[key]())
            emit(todo_event("analyze", steps, index + 1, added))
        return fit_from

    async def boost(state: ResumeGraphState) -> dict:
        drafts = dict(state.get("drafts") or {})
        if not draft_text(drafts):
            body = chosen_document_text(state.get("inputs")) or await load_document_markdown(
                db, state
            )
            if body:
                drafts = {"markdown": body}
        view_state = {**state, "drafts": drafts}
        scores = [float(item) for item in (view_state.get("scores") or [])]
        parts = view_state.get("boost_parts") or {}
        if not scores:
            base = await score_draft(view_state)
            scores.append(float(base["fitScore"]))
            parts = base.get("parts") or {}
        version = int(view_state.get("draft_version") or 1) + 1
        current = {**view_state, "phase": "craft", "draft_version": version}
        ctx = _context(db, view_state)
        chat = turn_model.get() or model
        started = time.monotonic()
        output = await _output(chat, "craft", current, ctx)
        if chat is not None:
            output, _left = await verified_craft(chat, current, output)
            emit(think_event("craft", time.monotonic() - started))
        stored = await _store_output(db, current, "craft", output)
        await _emit_papers(db, current, stored)
        view = await score_draft({**view_state, **stored})
        scores.append(float(view["fitScore"]))
        terms, _description = _posting(view_state)
        line = boost_line(
            len(scores) - 1,
            scores[-2],
            scores[-1],
            parts,
            view.get("parts"),
            added=added_keywords(terms, draft_text(drafts), draft_text(stored.get("drafts"))),
            company=_target_company(view_state),
        )
        emit(line)
        rounds = boost_rounds(view_state.get("boost_rounds"), job_of(view_state), line)
        emit(boost_fit(scores[0], scores[-1], rounds["items"]))
        return {
            **stored,
            "scores": scores,
            "boost_parts": view.get("parts") or {},
            "boost_rounds": rounds,
            "draft_version": version,
        }

    async def _finish_boost(state: ResumeGraphState, outcome: dict, stopped: str) -> dict:
        artifacts = dict(state.get("artifacts") or {})
        artifacts["05_boost_history.json"] = await save_named(
            state,
            "05_boost_history.json",
            {"history": outcome["history"]},
        )
        fit = {}
        if outcome["history"]:
            fit["fit_to"] = outcome["score"]
            if state.get("fit_from") is None:
                fit["fit_from"] = outcome["history"][0]["before"]
        return {
            **fit,
            "phase": "review",
            "scores": [],
            "boost_parts": {},
            "boost_acked": 0,
            "boost_stopped": stopped,
            "artifacts": artifacts,
            "status": "active",
            "goto": "end",
        }

    async def boost_gate(state: ResumeGraphState) -> dict:
        outcome = boost_cycle(
            {
                "scores": state.get("scores") or [],
                "acked": int(state.get("boost_acked") or 0),
                "defer": True,
            }
        )
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
        auto = not _must_stop(state, "boost")
        capped = auto and (state.get("access_mode") or "AUTO") == "AUTO"
        budget = budget_for(await user_plan(state))
        if capped and pending["cycle"] >= max(1, budget.boost_cycles):
            emit({"token": f"{detail} — 이번에는 여기까지 올렸어요."})
            return await _finish_boost(state, outcome, "budget")
        if auto:
            _emit_auto(_choice(state, "boost", auto=True, cycle=pending["cycle"], detail=detail))
            answer: dict = {"option_id": "continue"}
        else:
            event = _choice(state, "boost", auto=False, cycle=pending["cycle"], detail=detail)
            await _ask(db, state, event)
            answer = (
                interrupt(
                    {
                        "approval_id": event["id"],
                        "awaiting": "choice",
                        "kind": "RESUME_GATE",
                        "gate": "boost",
                        "cycle": pending["cycle"],
                        "before": pending["before"],
                        "after": pending["after"],
                        "gain": pending["gain"],
                    }
                )
                or {}
            )
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

    async def save_named(state: dict, name: str, payload: dict | list) -> str:
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
        jobs = analysis.get("jobs") if isinstance(analysis.get("jobs"), (dict, list)) else {}
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
            _context(db, state), "02_fit_score.json", fit_body
        )
        update = {"scenario": str(scenario), "artifacts": artifacts}
        inputs = dict(state.get("inputs") or {})
        frozen = _fit_posting({**state, "inputs": inputs})
        if not isinstance(inputs.get("fit_posting"), dict) and any(frozen.values()):
            inputs["fit_posting"] = frozen
            update["inputs"] = inputs
        fit_from = await report_analysis({**state, "inputs": inputs})
        if fit_from is not None:
            update["fit_from"] = fit_from
        return update

    async def feedback_node(state: ResumeGraphState) -> dict:
        current = current_of(state)
        plan = feedback_plan(current.get("analysis") or {})
        if plan is not None:
            emit(feedback_line(len(plan["rows"])))
            emit(plan)
            reply = "이 공고 기준으로 고칠 점이에요."
        else:
            reply = _feedback_text(current)
        emit({"token": reply})
        return {"reply": reply, "reply_job": running_job(), "phase": "feedback"}

    async def quality_gate(state: ResumeGraphState) -> dict:
        current = current_of(state)
        review = current.get("review") if isinstance(current.get("review"), dict) else {}
        fixes = [item for item in (review.get("auto_fixes") or []) if isinstance(item, dict)]
        recs = [item for item in (review.get("recommendations") or []) if isinstance(item, dict)][
            :6
        ]
        emit(quality_line(fixes, recs))
        diff = quality_diff(fixes)
        if diff is not None:
            emit(diff)
        if not recs:
            return {"status": "active", "phase": "review", "goto": "g4a"}
        labels = [str(item.get("label") or "").strip() for item in recs]
        labels = [label for label in labels if label]
        line = apply_recommendations_line(labels)
        if line is not None:
            emit(line)
            emit({"token": quality_text(labels)})
        return {
            "review": {**review, "apply": labels},
            "status": "active",
            "phase": "review",
            "goto": "g4a",
        }

    def _read_failed_event(current: dict) -> dict:
        gate = _GATES["read_failed"]
        return {
            "type": "choice",
            "id": _choice_id(current, "read_failed"),
            "kind": "RESUME_GATE",
            "title": gate["title"],
            "gate": "read_failed",
            "recommended": gate["recommended"],
            "options": [dict(item) for item in gate["options"]],
        }

    async def read_failed_gate(state: ResumeGraphState) -> dict:
        current = current_of(state)
        intent = (current.get("inputs") or {}).get("read_intent")
        if intent not in {"paste", "pick"}:
            emit({"token": _READ_FAILED_WARN})
        event = _read_failed_event(current)
        await _ask(db, current, event)
        answer = (
            interrupt(
                {
                    "approval_id": event["id"],
                    "awaiting": "choice",
                    "kind": "RESUME_GATE",
                    "gate": "read_failed",
                }
            )
            or {}
        )
        if _cancelled(answer):
            return {"status": "cancelled", "phase": "analyze", "goto": "end"}
        option = str(answer.get("option_id") or "")
        text = str(answer.get("text") or "").strip()
        if option == "proceed":
            return {"status": "active", "phase": "analyze", "goto": "g1"}
        if option in {"paste", "pick"}:
            inputs = dict(current.get("inputs") or {})
            inputs["read_intent"] = option
            emit({"token": _READ_FAILED_PASTE if option == "paste" else _READ_FAILED_PICK})
            return {
                "inputs": inputs,
                "gate_epoch": int(current.get("gate_epoch") or 0) + 1,
                "status": "active",
                "phase": "analyze",
                "goto": "g_read_failed",
            }
        if text and not option and not _option_ids(answer):
            inputs = merge_inputs(current.get("inputs") or {}, answer)
            pages = dict(inputs.get("pages") or {})
            if inputs.get("read_intent") == "pick":
                posting_id = _posting_id_in(text)
                if posting_id:
                    inputs["postingId"] = posting_id
                else:
                    pages[_PASTED_POSTING] = text
            else:
                pages[_PASTED_POSTING] = text
            inputs["pages"] = pages
            inputs.pop("read_intent", None)
            return {
                "inputs": inputs,
                "gate_epoch": int(current.get("gate_epoch") or 0) + 1,
                "status": "active",
                "phase": "analyze",
                "goto": "end",
            }
        return {"status": "active", "phase": "analyze", "goto": "g1"}

    async def design_node(state: ResumeGraphState) -> dict:
        reply = "검증을 마쳤어요. 디자인을 골라 주세요."
        emit({"token": reply})
        return {"reply": reply, "reply_job": running_job(), "phase": "review"}

    async def approach_node(state: ResumeGraphState) -> dict:
        reply = "접근 방식을 골라 주세요."
        emit({"token": reply})
        return {
            "reply": reply,
            "reply_job": running_job(),
            "phase": "approach",
            "retry": False,
        }

    async def validate_node(state: ResumeGraphState) -> dict:
        current = current_of(state)
        chat = turn_model.get() or model
        if chat is None:
            output = {"valid": True}
        else:
            messages = [
                SystemMessage(
                    content=(
                        "선택한 접근 방식이 공고와 맞는지 JSON으로 판단한다. "
                        "맞지 않으면 valid를 false로 둔다."
                    )
                ),
                HumanMessage(
                    content=json.dumps(
                        {
                            "phase": "validate",
                            "approach": current.get("approach"),
                            "bottleneck_level": current.get("bottleneck_level"),
                            "prevention_categories": current.get("prevention_categories") or [],
                            "analysis": current.get("analysis") or {},
                        },
                        ensure_ascii=False,
                    )
                ),
            ]
            output = _parsed(await chat.ainvoke(messages))
        if _invalid(output):
            return _failed_check(state, "approach", "방향 검증을 통과하지 못했어요.")
        return {
            "phase": "blueprints",
            "status": "active",
            "retry": False,
            "validation_failures": 0,
        }

    async def validate_bp_node(state: ResumeGraphState) -> dict:
        current = current_of(state)
        chat = turn_model.get() or model
        if chat is None:
            output = {"valid": True}
        else:
            messages = [
                SystemMessage(
                    content=phase_prompt_for_harness("validate_bp")
                    + ("\n\n탈락이면 valid를 false로 둔다. 결과는 JSON 객체 하나로만 답한다.")
                    + f"\n{_VALIDATE_BP_NOTE}"
                ),
                HumanMessage(
                    content=json.dumps(
                        {
                            "phase": "validate_bp",
                            "approach": current.get("approach"),
                            "bottleneck_level": current.get("bottleneck_level"),
                            "prevention_categories": current.get("prevention_categories") or [],
                            "blueprints": current.get("blueprints") or {},
                            "analysis": current.get("analysis") or {},
                        },
                        ensure_ascii=False,
                    )
                ),
            ]
            output = _parsed(await chat.ainvoke(messages))
        artifacts = dict(state.get("artifacts") or {})
        artifacts["04_validation_report.json"] = await save_named(
            state, "04_validation_report.json", output
        )
        blueprints = dict(current.get("blueprints") or {})
        kept, plan = blueprints_plan(blueprints.get("projects"), output)
        # Every plan the check dropped counts as a failed check.
        if _invalid(output) or (titled_projects(blueprints.get("projects")) and not kept):
            failed = _failed_check(state, "blueprints", "설계안 검증을 통과하지 못했어요.")
            return {**failed, "artifacts": artifacts}
        if plan is not None:
            emit(plan)
            blueprints["projects"] = kept
        return {
            "artifacts": artifacts,
            "blueprints": blueprints,
            "phase": "blueprints",
            "status": "active",
            "retry": False,
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
        if phase == "craft" and _scenario_letter(state) == "E":
            return "p3c_boost"
        if phase == "intake" and int(state.get("intake_asks") or 0) > 0:
            return "g_intake"
        if phase == "review" and _scenario_letter(state) == "C":
            return "p4b_design"
        if phase == "review" and _quality_pending(state):
            return "g_quality"
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

    def after_classify(state: ResumeGraphState) -> str:
        analysis = state.get("analysis") if isinstance(state.get("analysis"), dict) else {}
        inputs = state.get("inputs") if isinstance(state.get("inputs"), dict) else {}
        if posting_unreadable(inputs, analysis):
            return "g_read_failed"
        if len(_gate_options(dict(state), "ask")) >= 2:
            return "g_ask"
        return "g1"

    def after_strategy(state: ResumeGraphState) -> str:
        return "end" if state.get("retry") else "g2"

    graph = StateGraph(ResumeGraphState)

    def add(name: str, node: Any) -> None:
        graph.add_node(name, with_status(name, node))

    add("p0_mode", work_node("mode_select"))
    add("g0", gate_node("mode_select"))
    add("p0i_intake", work_node("intake"))
    add("g_output_targets", gate_node("output_targets"))
    add("g_tone", gate_node("tone"))
    add("g_intake", gate_node("intake"))
    add("p1_analyze", work_node("analyze"))
    add("parse_resume", parse_resume)
    add("explore_github", explore_github)
    add("analyze_job", analyze_job)
    add("classify_scenario", classify_scenario)
    add("g1", gate_node("analyze"))
    add("p2b_feedback", feedback_node)
    add("g_feedback", gate_node("feedback"))
    add("p4b_design", design_node)
    add("p2_strategy", work_node("strategy"))
    add("g2", gate_node("strategy"))
    add("p3_craft", work_node("craft"))
    add("g3", gate_node("craft"))
    add("p3c_boost", boost)
    add("p3c_cycle", boost_gate)
    add("p4a_review", work_node("review"))
    add("g_quality", quality_gate)
    add("g4a", gate_node("review"))
    add("g_read_failed", read_failed_gate)
    add("g_ask", gate_node("ask"))
    add("p5_publish", work_node("publish"))
    add("p6_present", work_node("present"))
    add("g6", gate_node("present"))
    add("p2x_approach", approach_node)
    add("g_approach", gate_node("approach"))
    add("g_level", gate_node("level"))
    add("g_prevention", gate_node("prevention"))
    add("p2x_validate", validate_node)
    add("p2x_blueprints", work_node("blueprints"))
    add("p2x_validate_bp", validate_bp_node)
    add("g_validate_cap", gate_node("validate_cap"))
    add("g2x", gate_node("projects"))
    graph.add_conditional_edges(
        START,
        route_phase,
        {
            name: name
            for name in (
                "p0_mode",
                "p0i_intake",
                "g_intake",
                "p1_analyze",
                "p2_strategy",
                "p2b_feedback",
                "p3_craft",
                "p4a_review",
                "g_quality",
                "p4b_design",
                "p5_publish",
                "p6_present",
                "p3c_boost",
                "p2x_approach",
                "p2x_validate",
                "p2x_blueprints",
            )
        },
    )
    graph.add_edge("p0_mode", "g0")
    graph.add_edge("p0i_intake", "g_output_targets")
    graph.add_conditional_edges(
        "p1_analyze", fan_out, ["parse_resume", "explore_github", "analyze_job"]
    )
    graph.add_edge("parse_resume", "classify_scenario")
    graph.add_edge("explore_github", "classify_scenario")
    graph.add_edge("analyze_job", "classify_scenario")
    graph.add_conditional_edges(
        "classify_scenario", after_classify, {"g1": "g1", "g_read_failed": "g_read_failed", "g_ask": "g_ask"}
    )
    graph.add_edge("p2b_feedback", "g_feedback")
    graph.add_edge("p4b_design", "g4a")
    graph.add_edge("p2x_approach", "g_approach")
    graph.add_edge("p2x_blueprints", "p2x_validate_bp")
    graph.add_conditional_edges(
        "p2x_validate",
        after_validate,
        {
            "end": END,
            "p2x_blueprints": "p2x_blueprints",
            "g_validate_cap": "g_validate_cap",
        },
    )
    graph.add_conditional_edges(
        "p2x_validate_bp",
        after_validate_bp,
        {
            "end": END,
            "g2x": "g2x",
            "g_validate_cap": "g_validate_cap",
        },
    )
    graph.add_conditional_edges("p2_strategy", after_strategy, {"g2": "g2", "end": END})
    graph.add_edge("p3_craft", "g3")
    graph.add_edge("p4a_review", "g_quality")
    graph.add_edge("p5_publish", "p6_present")
    graph.add_edge("p6_present", "g6")
    graph.add_edge("p3c_boost", "p3c_cycle")
    graph.add_conditional_edges("p3c_cycle", route_goto, {"end": END, "p3c_boost": "p3c_boost"})
    for name in (
        "g0",
        "g_output_targets",
        "g_tone",
        "g_intake",
        "g1",
        "g_feedback",
        "g2",
        "g3",
        "g_quality",
        "g4a",
        "g6",
        "g_read_failed",
        "g_ask",
        "g_approach",
        "g_level",
        "g_prevention",
        "g_validate_cap",
        "g2x",
    ):
        graph.add_conditional_edges(name, route_goto, _EXITS)
    return graph.compile(checkpointer=checkpointer)
