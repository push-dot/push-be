"""Node prompts for the employer harness: super-recruit skill + that node's references."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

_RES = Path(__file__).resolve().parents[2] / "resources"
RECRUIT_ROOT = _RES / "super-recruit"
RESUME_ROOT = _RES / "super-resume"

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
    parts.append(
        f"[현재 단계] {node}. 이 단계의 출력만 만든다. 화면에 보이는 문구는 해요체로 쓴다."
    )
    return "\n\n---\n\n".join(parts)
