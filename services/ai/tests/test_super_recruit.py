from __future__ import annotations

import re

import pytest

from app.domain import fair_hiring
from app.harness.employer import recruit_prompts as rp

SKILLS = {
    "company-researcher",
    "reference-reader",
    "role-designer",
    "posting-writer",
    "posting-reviewer",
    "document-reader",
    "requirement-matcher",
    "claim-verifier",
    "review-reporter",
    "interview-designer",
    "talent-sourcer",
    "offer-writer",
}
REFS = {
    "fair-hiring",
    "posting-writing",
    "claim-verification",
    "interview-questions",
    "offer-writing",
    "writing-voice",
}


def test_every_skill_and_reference_file_exists():
    assert {p.stem for p in (rp.RECRUIT_ROOT / "skills").glob("*.md")} == SKILLS
    assert {p.stem for p in (rp.RECRUIT_ROOT / "references").glob("*.md")} == REFS
    assert set(rp.NODE_SKILLS.values()) == SKILLS


def test_every_node_has_refs_and_prompts_build():
    assert set(rp.NODE_SKILLS) == set(rp.NODE_REFS)
    for node in rp.NODE_SKILLS:
        prompt = rp.node_prompt(node)
        assert "판단은 담당자가 한다" in prompt
        assert f"[현재 단계] {node}" in prompt


def test_competency_signals_is_shared_with_super_resume():
    prompt = rp.node_prompt("rv_verify")
    shared = (rp.RESUME_ROOT / "references" / "competency-signals.md").read_text(encoding="utf-8")
    assert shared in prompt
    assert not (rp.RECRUIT_ROOT / "references" / "competency-signals.md").exists()


@pytest.mark.parametrize("node", ["pf_draft", "pf_review", "iv_design", "sc_offer"])
def test_fair_hiring_reaches_every_writing_node(node):
    assert "공정 채용 기준" in rp.node_prompt(node)


def test_research_does_not_load_fair_hiring_or_claims():
    prompt = rp.node_prompt("pf_research")
    assert "공정 채용 기준" not in prompt
    assert "서류 주장 확인 기준" not in prompt


def _doc_list(header: str) -> set[str]:
    text = (rp.RECRUIT_ROOT / "references" / "fair-hiring.md").read_text(encoding="utf-8")
    section = text[text.index("## 5.") :]
    line = next(row for row in section.splitlines() if row.startswith(header))
    return {w.strip("` ") or w for w in re.findall(r"`([^`]+)`", line)}


def test_code_lists_match_fair_hiring_doc():
    doc_posting = set()
    for header in ("나이 표현", "성별 표현", "가족 표현", "외모·신체", "출신"):
        doc_posting |= _doc_list(header)
    code_posting = {w.strip() for w in fair_hiring.POSTING_BANNED}
    assert code_posting == {w.strip() for w in doc_posting}
    assert set(fair_hiring.INTERVIEW_BANNED) == _doc_list("면접 금지어")


def test_banned_terms_found_in_posting_and_interview():
    assert fair_hiring.banned_in_posting("만 35세 이하 남성 우대") == ["세 이하", "남성"]
    assert fair_hiring.banned_in_posting("Kotlin 서버 개발 4년 이상") == []
    assert "결혼하셨" in fair_hiring.banned_in_interview("혹시 결혼하셨나요?")


def test_verdicts_ignore_the_fixed_disclaimer():
    assert fair_hiring.verdicts_in(fair_hiring.DECISION_DISCLAIMER) == []
    assert fair_hiring.verdicts_in("이 지원자는 합격시키세요") == ["합격"]
    assert fair_hiring.verdicts_in("면접에서 직접 확인해 보는 게 좋아요.") == []
