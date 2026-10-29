from __future__ import annotations

import json

import pytest

from app.domain.employer_chat import known_intent
from app.domain.errors import DomainError
from app.harness.runtime import HarnessRuntime
from tests.harness_fakes import CONV, Rows, ScriptedLC, run, service


def _payload(text: str, intent: str) -> dict:
    return {
        "text": text,
        "user_id": "88888888-8888-4888-8888-888888888888",
        "conversation_id": str(CONV),
        "job_id": "99999999-9999-4999-8999-999999999999",
        "access_mode": "AUTO",
        "ai": None,
        "context": {},
        "intent": intent,
    }


def _saved(rows: Rows) -> dict:
    saved = rows.conversation["resume_state"]
    if isinstance(saved, str):
        saved = json.loads(saved)
    return saved


def _choice(items: list) -> dict:
    return next(
        chunk for mode, chunk in items
        if mode == "custom" and isinstance(chunk, dict) and chunk.get("type") == "choice")


async def _enter(intent: str, resume_state=None) -> tuple[dict, dict]:
    rows = Rows({"company_id": None, "resume_state": resume_state})
    items = await run(HarnessRuntime(service(rows)), _payload("시작해 주세요", intent))
    return _choice(items), _saved(rows)


async def test_match_posting_enters_scenario_a():
    choice, saved = await _enter("match_posting")
    assert choice["gate"] == "output_targets"
    assert saved["status"] == "active"
    assert saved["phase"] == "intake"
    assert saved["scenario"] == "A"
    assert saved["work_mode"] == "resume_based"


async def test_fit_enters_p6_present():
    choice, saved = await _enter("fit")
    assert choice["gate"] == "present"
    assert saved["phase"] == "present"
    assert saved["scenario"] == "E"
    assert saved["work_mode"] == "resume_based"


async def test_gaps_enters_p2_strategy():
    choice, saved = await _enter("gaps")
    assert choice["gate"] == "strategy"
    assert saved["phase"] == "strategy"
    assert saved["strategy"]["focus"] == "bottleneck"
    assert saved["strategy"]["steps"] == [1, 2, 3]


async def test_experience_enters_p2x_approach():
    choice, saved = await _enter("experience")
    assert choice["gate"] == "approach"
    assert saved["phase"] == "approach"
    assert saved["work_mode"] == "experience_blueprint"


async def test_boost_enters_p3c_boost_with_the_existing_draft(monkeypatch):
    seen = {}

    def boost_cycle(state):
        seen["resume"] = (state.get("drafts") or {}).get("resume")
        return {}

    monkeypatch.setattr("app.harness.personal.resume.graph.boost_cycle", boost_cycle)
    rows = Rows({
        "company_id": None,
        "resume_state": {
            "status": "done",
            "phase": "present",
            "drafts": {"resume": "기존 초안"},
        },
    })
    await run(HarnessRuntime(service(rows)), _payload("시작해 주세요", "boost"))
    saved = _saved(rows)
    assert seen.get("resume") == "기존 초안"
    assert saved["status"] == "active"
    assert saved["drafts"]["resume"] == "기존 초안"


def test_worker_accepts_personal_quick_start_intents():
    for intent in ("match_posting", "fit", "gaps", "experience", "boost"):
        assert known_intent(intent) == intent
    with pytest.raises(DomainError):
        known_intent("nope")


async def test_employer_conversation_does_not_enter_the_resume_flow():
    ScriptedLC.replies = [{"content": "공고 초안"}]
    ScriptedLC.bound = []
    rows = Rows({
        "company_id": "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        "resume_state": None,
    })
    items = await run(
        HarnessRuntime(service(rows), model_cls=ScriptedLC),
        {**_payload("공고", "fit"), "ai": {
            "provider": "OPENAI", "model": "managed", "effort": "LOW",
        }},
    )
    assert rows.conversation["resume_state"] is None
    assert not any(
        mode == "custom" and isinstance(chunk, dict) and chunk.get("type") == "choice"
        for mode, chunk in items)
