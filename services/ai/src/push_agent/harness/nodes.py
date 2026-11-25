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

from push_agent.domain.employer_baseline import baseline_lines
from push_agent.domain.fair_hiring import banned_in_interview, banned_in_posting, verdicts_in
from push_agent.harness.recruit_prompts import node_prompt
from push_agent.harness.schemas import (
    CompanyProfile,
    Flag,
    InterviewKit,
    Match,
    PostingDraft,
    PostingReview,
    ReviewReport,
    RoleSpec,
)
from app.harness.kstyle.subagent import Corpus
from app.harness.kstyle.verify import unsupported_numbers
from app.ingest.web_page import find_urls

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
    # A fact counts only when its URL is one the search really returned, never one the model built.
    seen = {url.rstrip("/") for url in find_urls(search_text)}
    profile.facts = [f for f in profile.facts if f.source_url.strip().rstrip("/") in seen]
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


def _strip_lines(draft: PostingDraft, bad: Callable[[str], bool]) -> tuple[PostingDraft, list[str]]:
    lists = {key: getattr(draft, key) for key in ("description", "requirements", "preferred")}
    removed = [item for items in lists.values() for item in items if bad(item)]
    update = {key: [item for item in items if not bad(item)] for key, items in lists.items()}
    return draft.model_copy(update=update), removed


def _numbers(draft: PostingDraft, sources: tuple[str, ...] | None) -> list[str]:
    return [] if sources is None else unsupported_numbers(draft.text(), *sources)


async def review_posting(
    generate: Generate,
    draft: PostingDraft,
    *,
    reference_text: str | None = None,
    rounds: int = 2,
    objections: list[dict] | None = None,
    number_sources: tuple[str, ...] | None = None,
    requests: list[str] | None = None,
) -> PostingReview:
    """``number_sources``: what the draft may take numbers from (profile, role, the 담당자's words).
    A number found in none of them is sent back once with the other findings, then its line is cut.
    ``requests``: what the 담당자 asked for in rewrites, which the review must keep."""
    current = draft
    notes: list[str] = []
    changed = False
    for _ in range(rounds):
        banned = banned_in_posting(current.text())
        copied = copied_sentences(current.text(), reference_text)
        numbers = _numbers(current, number_sources)
        user = (
            f"[초안]\n{current.model_dump_json()}\n\n[차별 표현 검사에 걸린 말]\n{banned}\n\n"
            f"[참고 공고와 너무 비슷한 문장]\n{copied}"
        )
        if number_sources is not None:
            user += f"\n\n[근거 없는 숫자 · 빼거나 근거 있는 값으로]\n{numbers}"
        if requests:
            asked = "\n".join(f"- {r}" for r in requests)
            user += f"\n\n[담당자가 다시 쓸 때 요청한 것 · 지킨다]\n{asked}"
        if objections:
            user += "\n\n[검토자 반대 의견 · 맞는 것만 반영]\n" + "\n".join(
                f"- {o['line']}: {o['objection']}" for o in objections
            )
            objections = None  # once: the second round only re-checks
        review = await generate(PostingReview, node_prompt("pf_review"), user)
        notes += review.notes
        changed = changed or review.changed or bool(banned or copied or numbers)
        current = review.draft
        if (
            not banned_in_posting(current.text())
            and not copied_sentences(current.text(), reference_text)
            and not _numbers(current, number_sources)
        ):
            break
    removed: list[str] = []
    leftover = banned_in_posting(current.text())
    if leftover:
        current, cut = _strip_lines(current, lambda line: any(term in line for term in leftover))
        removed += cut
        notes.append("차별로 읽힐 수 있는 표현이 있는 줄을 뺐어요.")
        changed = True
    if _numbers(current, number_sources):
        def unsupported(line: str) -> bool:
            return bool(unsupported_numbers(line, *number_sources))

        current, cut = _strip_lines(current, unsupported)
        # The check reads the whole draft, so the cut reaches work_style too; a title is reported.
        if unsupported(current.work_style):
            cut.append(current.work_style)
            current = current.model_copy(update={"work_style": ""})
        if cut:
            removed += cut
            notes.append("근거를 찾지 못한 숫자가 있는 줄을 뺐어요.")
            changed = True
        left = unsupported_numbers(current.title, *number_sources)
        if left:
            notes.append(f"제목에 근거 없는 숫자가 남아 있어요: {', '.join(left)}")
    return PostingReview(
        changed=changed,
        notes=notes,
        draft=current,
        ask_salary=current.salary_range in (None, ""),
        removed=removed,
    )


def _clean_flag(flag: Flag, documents: Corpus, baseline_used: bool) -> Flag | None:
    if verdicts_in(flag.title + " " + flag.reason):
        return None
    if not baseline_used and any(word in flag.reason for word in _PEER_COMPARE):
        return None
    quote = flag.quote if flag.quote and documents.anywhere(flag.quote) else None
    return flag.model_copy(update={"quote": quote})


def check_matches(matches: list[Match], documents_text: str) -> tuple[list[Match], list[str]]:
    """A match's evidence must be quoted from the documents. A MET whose evidence is not found there
    drops to PARTIAL; evidence that is not found is never shown. Returns the matches and the
    requirements that were lowered."""
    corpus = Corpus({"documents": documents_text})
    out, lowered = [], []
    for match in matches:
        if match.evidence and corpus.anywhere(match.evidence):
            out.append(match)
            continue
        if match.status == "MET":
            lowered.append(match.requirement)
            match = match.model_copy(update={"status": "PARTIAL"})
        out.append(match.model_copy(update={"evidence": None}))
    return out, lowered


async def verify_claims(
    generate: Generate,
    documents_text: str,
    posting_text: str,
    matches_json: str,
    baseline: dict,
    *,
    ledger: str = "",
) -> list[Flag]:
    lines = baseline_lines(baseline)
    user = "\n\n".join(
        filter(
            None,
            [
                f"[공고]\n{posting_text[:6000]}",
                f"[제출 서류]\n{documents_text[:20000]}",
                f"[요건 매칭]\n{matches_json}",
                f"[서류에서 확인된 주장]\n{ledger}" if ledger else "",
                "\n".join(lines),
            ],
        )
    )
    report = await generate(ReviewReport, node_prompt("rv_verify"), user)
    used = bool(baseline.get("used"))
    corpus = Corpus({"documents": documents_text})
    cleaned = [f for f in (_clean_flag(x, corpus, used) for x in report.flags) if f]
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
