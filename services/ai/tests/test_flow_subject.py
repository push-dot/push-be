"""A bot's one endless thread: a quick start about another posting starts clean (subject.py)."""

from __future__ import annotations

import json

import pytest

from app.harness import runtime as runtime_module
from app.harness.personal.resume.subject import saved_for_turn, subject_of, turn_subject
from app.harness.runtime import HarnessRuntime
from tests.harness_fakes import CONV, USER, Rows, ScriptedLC, managed_ai, run, service

A_URL = "https://jobs.a-corp.example/backend"
B_URL = "https://jobs.b-corp.example/frontend"
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


class SeeingLC(ScriptedLC):
    seen: list = []

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
    monkeypatch, conversation: dict, intent: str, text: str
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
            "context": {},
            "intent": intent,
            "job_id": "99999999-9999-4999-8999-999999999999",
        },
    )
    saved = rows.conversation["resume_state"]
    return _first_flow_context(), json.loads(saved) if isinstance(saved, str) else saved


def _after_a(**bot) -> dict:
    return {"company_id": None, "resume_state": dict(FINISHED_ABOUT_A), **bot}


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


async def test_a_company_bot_quick_start_with_nothing_attached_works_on_the_bots_posting(
    monkeypatch,
):
    about_c = {**FINISHED_ABOUT_A, "inputs": {"postingId": ATTACHED_POSTING, "attachments": []}}
    bot = {
        "company_id": None,
        "resume_state": about_c,
        "bot_kind": "company",
        "bot_name": "모아페이",
        "bot_company": "모아페이",
        "bot_posting_id": BOT_POSTING,
        "bot_posting_title": "Backend",
    }

    sent, _saved = await _quick_start(
        monkeypatch, bot, "gaps", "이 회사 공고에서 부족한 점을 찾아 줘"
    )

    assert sent["inputs"]["postingId"] == BOT_POSTING
    assert (sent["analysis"], sent["drafts"]) == ({}, {})


@pytest.mark.parametrize(
    ("payload", "bot", "subject"),
    [
        (
            {"context": {"postingId": ATTACHED_POSTING, "urls": [B_URL]}, "text": A_URL},
            {"postingId": BOT_POSTING},
            {"postingId": ATTACHED_POSTING},
        ),
        (
            {"context": {"urls": ["https://github.com/seojun", B_URL]}, "text": A_URL},
            None,
            {"url": B_URL},
        ),
        (
            {"context": {}, "text": f"{A_URL}/ 이 공고로"},
            {"postingId": BOT_POSTING},
            {"url": A_URL},
        ),
        ({"context": {}, "text": "https://github.com/seojun 로 점수 올려 줘"}, None, None),
        (
            {"context": {}, "text": "점수 올려 줘"},
            {"postingId": BOT_POSTING},
            {"postingId": BOT_POSTING},
        ),
        ({"context": {}, "text": "점수 올려 줘"}, {"postingId": None}, None),
    ],
)
def test_what_a_turn_names(payload, bot, subject):
    assert turn_subject(payload, bot) == subject


def test_a_state_that_names_no_posting_continues_only_with_a_turn_that_names_none():
    unnamed = {"inputs": {"attachments": ["doc-1"]}, "drafts": {"markdown": "초안"}}

    assert subject_of(unnamed) is None
    assert saved_for_turn(unnamed, None) == unnamed
    assert saved_for_turn(unnamed, {"url": B_URL}) == {}
    assert (
        saved_for_turn(FINISHED_ABOUT_A, turn_subject({"text": A_URL + "/#apply"}, None))
        == FINISHED_ABOUT_A
    )
