"""Node prompts for the employer harness: super-recruit skill + that node's references."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

import app

RECRUIT_ROOT = Path(__file__).resolve().parents[1] / "resources" / "super-recruit"
RESUME_ROOT = Path(app.__file__).resolve().parent / "resources" / "super-resume"

# competency-signals is shared with super-resume: the bar job seekers write to is the bar
# recruiters read with.
_SHARED_REFS = {"competency-signals": RESUME_ROOT / "references" / "competency-signals.md"}

NODE_SKILLS: dict[str, str] = {
    "pf_research": "company-researcher",
    "pf_reference": "reference-reader",
    "pf_role": "role-designer",
    "pf_role_detail": "role-designer",
    "pf_draft": "posting-writer",
    "pf_review": "posting-reviewer",
    "rv_read": "document-reader",
    "rv_match": "requirement-matcher",
    "rv_verify": "claim-verifier",
    "rv_report": "review-reporter",
    "iv_design": "interview-designer",
    "iv_screen": "interview-designer",
    "sc_search": "talent-sourcer",
    "sc_shortlist": "talent-sourcer",
    "sc_offer": "offer-writer",
}

NODE_REFS: dict[str, tuple[str, ...]] = {
    "pf_research": ("writing-voice",),
    "pf_reference": ("posting-writing",),
    "pf_role": ("posting-writing", "competency-signals"),
    "pf_role_detail": ("posting-writing", "competency-signals"),
    "pf_draft": ("posting-writing", "fair-hiring", "writing-voice"),
    "pf_review": ("posting-writing", "fair-hiring"),
    "rv_read": (),
    "rv_match": ("competency-signals",),
    "rv_verify": ("claim-verification", "competency-signals"),
    "rv_report": ("claim-verification", "writing-voice"),
    "iv_design": ("interview-questions", "fair-hiring", "competency-signals"),
    "iv_screen": ("interview-questions", "fair-hiring", "competency-signals"),
    "sc_search": ("competency-signals", "fair-hiring"),
    "sc_shortlist": ("competency-signals", "fair-hiring"),
    "sc_offer": ("offer-writing", "fair-hiring", "writing-voice"),
}


# Code checks these after the model answers (nodes.check_matches, the kit's flag tie), so each rule
# here only saves a retry; it is never the only guard.
_NODE_RULES: dict[str, str] = {
    "rv_match": "evidence에는 제출 서류의 문장을 고치지 않고 그대로 옮긴다. 옮길 문장이 없으면 MET로 쓰지 않는다.",
    "iv_design": "from_flag에는 [확인 필요 항목]의 title을 그대로 쓴다. 항목에 묶이지 않는 질문은 만들지 않는다.",
    "sc_shortlist": "reasons에는 그 사람 공개 프로필에 실제로 적힌 말을 짧게 옮긴다. 프로필에 없는 이유는 쓰지 않는다.",
    "sc_offer": "숫자(연차·인원·규모·금액)는 [공고]와 [사람]에 있는 것만 쓴다.",
}

# Subagents. The first line of each system is its role marker.
CLAIM_READER = """서류 주장 읽기 하위 에이전트.
brief.documents(지원자가 낸 서류)에서 면접에서 사실인지 확인할 수 있는 주장(경력 기간·역할·규모·성과·기술)만 고른다.
판단하거나 평가하지 않는다. JSON 하나로 답한다:
{"claims": [{"quote": 서류 문장을 고치지 않고 그대로, "claim": 그 문장이 주장하는 것 한 줄}]}. 최대 12개."""

# Reviewers return objections only and never rewrite. Stances are generic: who reads the posting,
# and what they push back on. They carry no company, role or wording of their own.
POSTING_REVIEWERS = (
    (
        "review_candidate",
        "지원할 사람 입장에서 초안을 봐요",
        "자격을 갖춘 지원자 입장의 검토자.\n"
        "너는 이 자리에 맞는 경력을 가진 사람이고, 지원할지 정하려고 이 공고를 읽는다. "
        "무슨 일을 하게 되는지, 무엇이 꼭 필요한지 읽고도 알 수 없거나 빠진 항목에만 반대한다.",
    ),
    (
        "review_peer",
        "채용 담당자 동료 입장에서 요건을 봐요",
        "채용 관리자의 동료 입장의 검토자.\n"
        "너는 이 팀에서 같은 일을 해 본 동료다. 실제로 일하는 데 꼭 필요하지 않은데 필수로 적힌 요건, "
        "우대로 내리거나 빼야 할 요건에만 반대한다.",
    ),
)


def _ref_path(name: str) -> Path:
    return _SHARED_REFS.get(name) or RECRUIT_ROOT / "references" / (name + ".md")


def _principles() -> str:
    text = (RECRUIT_ROOT / "orchestrator.md").read_text(encoding="utf-8")
    start = text.index("## 모든 흐름에 걸리는 원칙")
    end = text.index("## GATE 질문")
    return text[start:end].strip()


@lru_cache(maxsize=32)
def node_prompt(node: str) -> str:
    skill = NODE_SKILLS[node]
    parts = [_principles(), (RECRUIT_ROOT / "skills" / (skill + ".md")).read_text(encoding="utf-8")]
    parts += [_ref_path(name).read_text(encoding="utf-8") for name in NODE_REFS[node]]
    if node in _NODE_RULES:
        parts.append(_NODE_RULES[node])
    parts.append(
        f"[현재 단계] {node}. 이 단계의 출력만 만든다. 화면에 보이는 문구는 해요체로 쓴다."
    )
    return "\n\n---\n\n".join(parts)
