"""A bot's one endless thread: a quick start about another posting starts clean (subject.py)."""

from __future__ import annotations

import json
from typing import ClassVar

import pytest

from app.harness import runtime as runtime_module
from app.harness.personal.resume.subject import saved_for_turn, turn_links, turn_posting
from app.harness.runtime import HarnessRuntime
from tests.harness_fakes import CONV, USER, Rows, ScriptedLC, managed_ai, run, service

A_URL = "https://jobs.a-corp.example/backend"
B_URL = "https://jobs.b-corp.example/frontend"
PORTFOLIO = "https://seojun.notion.site/portfolio"
GITHUB = "https://github.com/seojun"
BOT_POSTING = "11111111-1111-4111-8111-111111111111"
ATTACHED_POSTING = "22222222-2222-4222-8222-222222222222"
FINISHED_ABOUT_A = {
    "status": "done",
    "phase": "present",
    "work_mode": "resume_based",
    "tone": "담백하게",
    "inputs": {"pages": {A_URL: "A사 백엔드 공고: Python, Kafka 필수"}, "attachments": []},
    "analysis": {
        "jobs": {"company": "A사", "requirements": ["Python"], "keywords": ["Kafka"]},
        "fit": 71,
    },
    "drafts": {"markdown": "A사 백엔드 지원용 이력서 초안"},
}
WITH_PORTFOLIO = {
    **FINISHED_ABOUT_A,
    "inputs": {
        "pages": {PORTFOLIO: "서준의 포트폴리오", A_URL: "A사 백엔드 공고: Python, Kafka 필수"},
        "attachments": [],
    },
}


class SeeingLC(ScriptedLC):
    seen: ClassVar[list] = []

    async def ainvoke(self, messages, **kwargs):
        SeeingLC.seen.append(list(messages))
        return await super().ainvoke(messages, **kwargs)


def _first_flow_context() -> dict:
    """The JSON state the first document-flow model call of the turn was given."""
    for call in SeeingLC.seen:
        for message in call:
            try:
                body = json.loads(message.content)
            except (TypeError, ValueError):
                continue
            if isinstance(body, dict) and "phase" in body and "inputs" in body:
                return body
    return {}


async def _quick_start(
    monkeypatch, conversation: dict, intent: str, text: str, context: dict | None = None
) -> tuple[dict, dict]:
    """The first flow context the model got, and the flow state saved after the turn."""

    async def fetch(url):
        return "B사 프론트엔드 공고: React, TypeScript 필수"

    async def fit(*_args, **_kwargs):
        return {"fitScore": 50.0, "parts": {}, "topGap": "도메인", "plan": "FREE"}

    monkeypatch.setattr(runtime_module, "fetch_page_text", fetch)
    monkeypatch.setattr("app.framework.fit_judge.judge_fit", fit)
    SeeingLC.seen = []
    ScriptedLC.replies = [
        {"content": json.dumps({"message": "작업했어요"}, ensure_ascii=False)}
    ] * 4
    rows = Rows(conversation)
    runtime = HarnessRuntime(service(rows), model_cls=SeeingLC)
    await run(
        runtime,
        {
            "text": text,
            "user_id": USER,
            "conversation_id": CONV,
            "access_mode": "AUTO",
            "ai": managed_ai(),
            "context": context or {},
            "intent": intent,
            "job_id": "99999999-9999-4999-8999-999999999999",
        },
    )
    saved = rows.conversation["resume_state"]
    return _first_flow_context(), json.loads(saved) if isinstance(saved, str) else saved


def _after_a(**columns) -> dict:
    return {"company_id": None, "resume_state": dict(FINISHED_ABOUT_A), **columns}


async def test_gaps_for_posting_b_after_a_flow_about_a_is_planned_from_b(monkeypatch):
    sent, _saved = await _quick_start(
        monkeypatch, _after_a(), "gaps", f"이 공고에서 부족한 점을 찾아 줘 {B_URL}"
    )

    assert sent["phase"] in ("intake", "analyze")
    assert list(sent["inputs"]["pages"]) == [B_URL]
    assert sent["analysis"] == {}


async def test_fit_for_posting_b_reads_only_b_and_carries_no_draft_of_a(monkeypatch):
    sent, saved = await _quick_start(
        monkeypatch, _after_a(), "fit", f"이 공고 적합도 봐 줘 {B_URL}"
    )

    assert list(sent["inputs"]["pages"]) == [B_URL]
    assert sent["drafts"] == {}
    assert saved["tone"] == "담백하게", "the user's tone is a preference, not a fact about A"


async def test_boost_with_nothing_attached_goes_on_with_the_draft_of_a(monkeypatch):
    sent, _saved = await _quick_start(monkeypatch, _after_a(), "boost", "점수 올려 줘")

    assert sent["drafts"]["markdown"] == "A사 백엔드 지원용 이력서 초안"
    assert list(sent["inputs"]["pages"]) == [A_URL]


def _company_bot(saved: dict) -> dict:
    return {
        "company_id": None,
        "resume_state": saved,
        "bot_kind": "company",
        "bot_name": "모아페이",
        "bot_company": "모아페이",
        "bot_posting_id": BOT_POSTING,
        "bot_posting_title": "Backend",
    }


async def test_a_company_bot_quick_start_with_nothing_attached_works_on_the_bots_posting(
    monkeypatch,
):
    about_c = {**FINISHED_ABOUT_A, "inputs": {"postingId": ATTACHED_POSTING, "attachments": []}}

    sent, _saved = await _quick_start(
        monkeypatch, _company_bot(about_c), "gaps", "이 회사 공고에서 부족한 점을 찾아 줘"
    )

    assert sent["inputs"]["postingId"] == BOT_POSTING
    assert (sent["analysis"], sent["drafts"]) == ({}, {})


async def test_a_company_bot_quick_start_with_a_portfolio_link_works_on_the_bots_posting(
    monkeypatch,
):
    sent, saved = await _quick_start(
        monkeypatch, _company_bot(None), "gaps", f"내 포트폴리오로 부족한 점 찾아 줘 {PORTFOLIO}"
    )

    assert sent["inputs"]["postingId"] == BOT_POSTING
    assert list(sent["inputs"]["pages"]) == [PORTFOLIO]
    assert saved["inputs"]["postingId"] == BOT_POSTING


async def test_a_company_bots_flow_goes_on_when_a_portfolio_link_is_added(monkeypatch):
    about_bot = {**FINISHED_ABOUT_A, "inputs": {"postingId": BOT_POSTING, "attachments": []}}

    sent, _saved = await _quick_start(
        monkeypatch, _company_bot(about_bot), "gaps", f"이것도 보고 부족한 점 찾아 줘 {PORTFOLIO}"
    )

    assert sent["analysis"]["fit"] == 71
    assert list(sent["inputs"]["pages"]) == [PORTFOLIO]


async def test_a_portfolio_link_does_not_carry_a_flow_about_a_into_posting_b(monkeypatch):
    sent, saved = await _quick_start(
        monkeypatch,
        _after_a(resume_state=dict(WITH_PORTFOLIO)),
        "gaps",
        f"부족한 점 찾아 줘 {B_URL}",
        {"urls": [PORTFOLIO]},
    )

    assert (sent["analysis"], sent["drafts"]) == ({}, {})
    assert list(sent["inputs"]["pages"]) == [B_URL, PORTFOLIO]
    assert "A사" not in json.dumps(saved, ensure_ascii=False)


async def test_posting_b_after_two_read_links_reads_b_and_drops_the_flow_about_a(monkeypatch):
    read_all = {
        **FINISHED_ABOUT_A,
        "inputs": {"pages": {**WITH_PORTFOLIO["inputs"]["pages"], GITHUB: "서준의 GitHub"}},
    }

    sent, saved = await _quick_start(
        monkeypatch,
        _after_a(resume_state=read_all),
        "gaps",
        f"부족한 점 찾아 줘 {B_URL}",
        {"urls": [PORTFOLIO, GITHUB]},
    )

    assert list(sent["inputs"]["pages"]) == [B_URL, PORTFOLIO], "the pasted posting is read"
    assert (sent["analysis"], sent["drafts"]) == ({}, {})
    assert "A사" not in json.dumps(saved, ensure_ascii=False)


async def test_a_link_the_flow_already_read_goes_on_with_the_flow(monkeypatch):
    sent, _saved = await _quick_start(
        monkeypatch,
        _after_a(resume_state=dict(WITH_PORTFOLIO)),
        "boost",
        "점수 올려 줘",
        {"urls": [PORTFOLIO]},
    )

    assert sent["drafts"]["markdown"] == "A사 백엔드 지원용 이력서 초안"


def test_a_turn_brings_every_link_once_pasted_ones_first():
    payload = {"context": {"urls": [GITHUB, PORTFOLIO]}, "text": f"{A_URL} {PORTFOLIO} {B_URL}"}

    assert turn_links(payload) == [A_URL, PORTFOLIO, B_URL, GITHUB]


async def test_a_turn_reads_at_most_two_pages_pasted_ones_first(monkeypatch):
    sent, _saved = await _quick_start(
        monkeypatch,
        _after_a(),
        "gaps",
        f"부족한 점 찾아 줘 {A_URL} {B_URL}",
        {"urls": [PORTFOLIO]},
    )

    assert list(sent["inputs"]["pages"]) == [A_URL, B_URL]


@pytest.mark.parametrize(
    ("payload", "bot", "posting"),
    [
        (
            {"context": {"postingId": ATTACHED_POSTING}},
            {"postingId": BOT_POSTING},
            ATTACHED_POSTING,
        ),
        ({"context": {"urls": [B_URL]}}, {"postingId": BOT_POSTING}, BOT_POSTING),
        ({"context": {"urls": [B_URL]}}, None, None),
        ({"text": "점수 올려 줘"}, {"postingId": None}, None),
    ],
)
def test_the_posting_a_turn_works_on(payload, bot, posting):
    assert turn_posting(payload, bot) == posting


ABOUT_ATTACHED = {"tone": "담백하게", "inputs": {"postingId": ATTACHED_POSTING}, "fit": 71}


@pytest.mark.parametrize(
    ("saved", "posting", "links", "kept"),
    [
        (FINISHED_ABOUT_A, None, [], FINISHED_ABOUT_A),
        (FINISHED_ABOUT_A, None, [A_URL + "/#apply"], FINISHED_ABOUT_A),
        (FINISHED_ABOUT_A, None, [GITHUB], FINISHED_ABOUT_A),
        (FINISHED_ABOUT_A, None, [B_URL], {"tone": "담백하게"}),
        (FINISHED_ABOUT_A, ATTACHED_POSTING, [], {"tone": "담백하게"}),
        (WITH_PORTFOLIO, None, [PORTFOLIO], WITH_PORTFOLIO),
        (WITH_PORTFOLIO, None, [PORTFOLIO, B_URL], {"tone": "담백하게"}),
        (ABOUT_ATTACHED, ATTACHED_POSTING, [PORTFOLIO], ABOUT_ATTACHED),
        ({"inputs": {"attachments": ["doc-1"]}}, None, [B_URL], {}),
    ],
)
def test_what_a_quick_start_keeps_of_the_saved_flow(saved, posting, links, kept):
    assert saved_for_turn(saved, posting, links) == kept
