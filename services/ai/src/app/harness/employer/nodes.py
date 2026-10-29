"""Employer harness node logic (super-recruit), independent of graph wiring.

Each node takes ``generate(schema, system, user)``, which returns a validated
``schema`` instance (production: a LangChain chat model with structured output).
Deterministic guards run around every model step so fair-hiring, quoting and
no-verdict rules never depend on the prompt alone.
"""

from __future__ import annotations

import difflib
import re
from collections.abc import Awaitable, Callable
from datetime import datetime, timedelta
from typing import TypeVar

from pydantic import BaseModel

from app.domain.employer_baseline import baseline_lines
from app.domain.fair_hiring import banned_in_interview, banned_in_posting, verdicts_in
from app.harness.employer.recruit_prompts import node_prompt
from app.harness.employer.schemas import (
    CompanyProfile,
    Flag,
    InterviewKit,
    PostingDraft,
    PostingReview,
    ReviewReport,
    RoleSpec,
)

M = TypeVar("M", bound=BaseModel)
Generate = Callable[[type[M], str, str], Awaitable[M]]

PROFILE_TTL = timedelta(days=30)
MAX_FLAGS = 5
MAX_QUESTIONS = 8
COPY_THRESHOLD = 0.8
_SENTENCE = re.compile(r"[\n]+|(?<=[.!?。])\s+")
_PEER_COMPARE = ("같은 연차", "기준선", "평균보다", "다른 서류")


def profile_is_fresh(refreshed_at: datetime | None, now: datetime) -> bool:
    return refreshed_at is not None and now - refreshed_at < PROFILE_TTL


async def research_company(generate: Generate, company: str, search_text: str) -> CompanyProfile:
    user = f"[회사] {company}\n\n[검색 결과]\n{search_text[:12000]}"
    profile = await generate(CompanyProfile, node_prompt("pf_research"), user)
    profile.facts = [f for f in profile.facts if f.source_url.strip()]
    return profile


async def draft_posting(
    generate: Generate,
    profile: CompanyProfile,
    role: RoleSpec,
    *,
    reference: str | None = None,
    previous: PostingDraft | None = None,
    request: str | None = None,
) -> PostingDraft:
    parts = [f"[회사 프로필]\n{profile.model_dump_json()}", f"[역할]\n{role.model_dump_json()}"]
    if reference:
        parts.append(f"[참고 공고 구조 · 문장은 쓰지 않는다]\n{reference}")
    if previous is not None:
        parts.append(f"[이전 초안]\n{previous.model_dump_json()}")
    if request:
        parts.append(f"[담당자 요청]\n{request}")
    return await generate(PostingDraft, node_prompt("pf_draft"), "\n\n".join(parts))


def _sentences(text: str) -> list[str]:
    return [s.strip() for s in _SENTENCE.split(text or "") if len(s.strip()) >= 12]


def copied_sentences(
    draft_text: str, reference_text: str | None, threshold: float = COPY_THRESHOLD
) -> list[str]:
    """Draft sentences that are near-copies of a reference posting sentence."""
    if not reference_text:
        return []
    refs = _sentences(reference_text)
    hits = []
    for line in _sentences(draft_text):
        if any(difflib.SequenceMatcher(None, line, ref).ratio() >= threshold for ref in refs):
            hits.append(line)
    return hits


def _strip_lines(draft: PostingDraft, bad: list[str]) -> PostingDraft:
    def keep(items: list[str]) -> list[str]:
        return [i for i in items if not any(term in i for term in bad)]

    return draft.model_copy(
        update={
            "description": keep(draft.description),
            "requirements": keep(draft.requirements),
            "preferred": keep(draft.preferred),
        }
    )


async def review_posting(
    generate: Generate, draft: PostingDraft, *, reference_text: str | None = None, rounds: int = 2
) -> PostingReview:
    current = draft
    notes: list[str] = []
    changed = False
    for _ in range(rounds):
        banned = banned_in_posting(current.text())
        copied = copied_sentences(current.text(), reference_text)
        user = (
            f"[초안]\n{current.model_dump_json()}\n\n[차별 표현 검사에 걸린 말]\n{banned}\n\n"
            f"[참고 공고와 너무 비슷한 문장]\n{copied}"
        )
        review = await generate(PostingReview, node_prompt("pf_review"), user)
        notes += review.notes
        changed = changed or review.changed or bool(banned or copied)
        current = review.draft
        if not banned_in_posting(current.text()) and not copied_sentences(
            current.text(), reference_text
        ):
            break
    leftover = banned_in_posting(current.text())
    if leftover:
        current = _strip_lines(current, leftover)
        notes.append("차별로 읽힐 수 있는 표현이 있는 줄을 뺐어요.")
        changed = True
    return PostingReview(
        changed=changed, notes=notes, draft=current, ask_salary=current.salary_range in (None, "")
    )


def _clean_flag(flag: Flag, documents_text: str, baseline_used: bool) -> Flag | None:
    if verdicts_in(flag.title + " " + flag.reason):
        return None
    if not baseline_used and any(word in flag.reason for word in _PEER_COMPARE):
        return None
    quote = flag.quote if flag.quote and flag.quote in documents_text else None
    return flag.model_copy(update={"quote": quote})


async def verify_claims(
    generate: Generate, documents_text: str, posting_text: str, matches_json: str, baseline: dict
) -> list[Flag]:
    lines = baseline_lines(baseline)
    user = "\n\n".join(
        filter(
            None,
            [
                f"[공고]\n{posting_text[:6000]}",
                f"[제출 서류]\n{documents_text[:20000]}",
                f"[요건 매칭]\n{matches_json}",
                "\n".join(lines),
            ],
        )
    )
    report = await generate(ReviewReport, node_prompt("rv_verify"), user)
    used = bool(baseline.get("used"))
    cleaned = [f for f in (_clean_flag(x, documents_text, used) for x in report.flags) if f]
    order = {"CHECK": 0, "SUPPORTED": 1, "UNKNOWN": 2}
    return sorted(cleaned, key=lambda f: order[f.level])[:MAX_FLAGS]


def report_summary(flags: list[Flag]) -> str:
    checks = sum(1 for f in flags if f.level == "CHECK")
    if checks == 0:
        return "서류 전체에서 따로 확인할 부분을 찾지 못했어요."
    return f"다만 아래 {checks}곳은 면접에서 직접 확인해 보는 게 좋아요."


async def design_interview(
    generate: Generate, flags: list[Flag], posting_text: str, documents_text: str, rounds: int = 2
) -> InterviewKit:
    checks = [f for f in flags if f.level == "CHECK"]
    user = "\n\n".join(
        [
            f"[확인 필요 항목]\n{[f.model_dump() for f in checks]}",
            f"[공고]\n{posting_text[:6000]}",
            f"[제출 서류]\n{documents_text[:12000]}",
        ]
    )
    kit = InterviewKit(questions=[])
    for _ in range(rounds):
        kit = await generate(InterviewKit, node_prompt("iv_design"), user)
        bad = [q.text for q in kit.questions if banned_in_interview(q.text)]
        if not bad:
            break
        user += f"\n\n[다시 쓸 질문 · 금지 질문]\n{bad}"
    kept = [q for q in kit.questions if not banned_in_interview(q.text)]
    return InterviewKit(questions=kept[:MAX_QUESTIONS])
