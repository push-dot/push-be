from __future__ import annotations

import json

import pytest
from langchain_core.messages import AIMessage

from app.domain.employer_chat import known_intent
from app.domain.errors import DomainError
from app.harness.model import StubModel
from app.harness.runtime import HarnessRuntime
from tests.harness_fakes import CONV, Rows, ScriptedLC, run, service

_BOTTLENECK_LINE = (
    "이번에는 content-strategy Step 1–3만 수행한다"
    "(기술 스택 매칭, 적합도 산정, 프로젝트 경험 재평가). "
    "Step 4 이후 섹션 수정 전략과 자기소개서 전략은 쓰지 않는다."
)


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


def _bag(*drop: str) -> dict:
    state = {
        "status": "done",
        "inputs": {"job": "backend"},
        "analysis": {"role": "backend"},
        "drafts": {"resume": "기존 초안"},
        "artifacts": {"note": "kept"},
        "output_targets": ["resume"],
        "tone": "technical",
    }
    for key in drop:
        state.pop(key, None)
    return state


def _assert_kept(saved: dict, source: dict) -> None:
    if source.get("inputs"):
        assert saved["inputs"]["job"] == "backend"
    if source.get("analysis"):
        assert saved["analysis"]["role"] == "backend"
    if source.get("drafts"):
        assert saved["drafts"]["resume"] == "기존 초안"
    if source.get("artifacts"):
        assert saved["artifacts"]["note"] == "kept"
    if source.get("output_targets"):
        assert saved["output_targets"] == ["resume"]
    if source.get("tone"):
        assert saved["tone"] == "technical"


async def _open(intent: str, resume_state=None):
    rows = Rows({"company_id": None, "resume_state": resume_state})
    runtime = HarnessRuntime(service(rows))
    items = await run(runtime, _payload("시작해 주세요", intent))
    return runtime, rows, items


async def _accept(runtime, intent: str, choice: dict, option_id: str):
    payload = _payload("", intent)
    payload["resume"] = {"approvalId": choice["id"], "optionId": option_id}
    return await run(runtime, payload)


async def test_match_posting_enters_scenario_a():
    _runtime, rows, items = await _open("match_posting")
    choice = _choice(items)
    saved = _saved(rows)
    assert choice["gate"] == "output_targets"
    assert saved["status"] == "active"
    assert saved["phase"] == "intake"
    assert saved["scenario"] == "A"
    assert saved["work_mode"] == "resume_based"


async def test_fit_without_inputs_enters_intake():
    source = _bag("inputs")
    _runtime, rows, items = await _open("fit", source)
    saved = _saved(rows)
    assert _choice(items)["gate"] == "output_targets"
    assert saved["phase"] == "intake"
    assert saved["scenario"] == "E"
    assert saved["work_mode"] == "resume_based"
    _assert_kept(saved, source)


async def test_fit_with_inputs_enters_analyze():
    source = _bag()
    _runtime, rows, items = await _open("fit", source)
    saved = _saved(rows)
    assert _choice(items)["gate"] == "analyze"
    assert saved["phase"] == "analyze"
    assert saved["scenario"] == "E"
    assert saved["work_mode"] == "resume_based"
    _assert_kept(saved, source)


async def test_fit_with_inputs_accepts_analyze_into_present():
    runtime, rows, items = await _open("fit", _bag())
    choice = _choice(items)
    assert choice["gate"] == "analyze"
    items = await _accept(runtime, "fit", choice, "continue")
    saved = _saved(rows)
    assert _choice(items)["gate"] == "present"
    assert saved["phase"] == "present"
    assert saved["scenario"] == "E"


async def test_gaps_without_analysis_enters_intake():
    source = _bag("analysis")
    _runtime, rows, items = await _open("gaps", source)
    saved = _saved(rows)
    assert _choice(items)["gate"] == "output_targets"
    assert saved["phase"] == "intake"
    assert saved["scenario"] == "A"
    assert saved["strategy"]["focus"] == "bottleneck"
    assert saved["strategy"]["steps"] == [1, 2, 3]
    _assert_kept(saved, source)


async def test_gaps_with_analysis_enters_strategy():
    source = _bag()
    _runtime, rows, items = await _open("gaps", source)
    saved = _saved(rows)
    assert _choice(items)["gate"] == "strategy"
    assert saved["phase"] == "strategy"
    assert saved["strategy"]["focus"] == "bottleneck"
    assert saved["strategy"]["steps"] == [1, 2, 3]
    _assert_kept(saved, source)


async def test_gaps_bottleneck_stops_after_strategy(monkeypatch):
    seen: list[str] = []
    calls = {"n": 0}

    async def ainvoke(self, messages, **kwargs):
        calls["n"] += 1
        for message in messages:
            content = getattr(message, "content", "")
            if isinstance(content, str):
                seen.append(content)
        if calls["n"] == 1:
            return AIMessage(content='{"valid": false}')
        return AIMessage(content='{"summary": "전략"}')

    monkeypatch.setattr(StubModel, "ainvoke", ainvoke)
    runtime, rows, items = await _open("gaps", _bag())
    saved = _saved(rows)
    assert _choice(items)["gate"] == "strategy"
    assert saved["strategy"]["focus"] == "bottleneck"
    assert saved["strategy"]["steps"] == [1, 2, 3]
    assert calls["n"] >= 2
    assert any(_BOTTLENECK_LINE in text for text in seen)
    await _accept(runtime, "gaps", _choice(items), "continue")
    assert _saved(rows)["status"] == "done"


async def test_experience_without_analysis_enters_intake():
    source = _bag("analysis")
    _runtime, rows, items = await _open("experience", source)
    saved = _saved(rows)
    assert _choice(items)["gate"] == "output_targets"
    assert saved["phase"] == "intake"
    assert saved["work_mode"] == "experience_blueprint"
    _assert_kept(saved, source)


async def test_experience_with_analysis_enters_approach():
    source = _bag()
    _runtime, rows, items = await _open("experience", source)
    saved = _saved(rows)
    assert _choice(items)["gate"] == "approach"
    assert saved["phase"] == "approach"
    assert saved["work_mode"] == "experience_blueprint"
    _assert_kept(saved, source)


async def test_boost_without_a_draft_enters_intake(monkeypatch):
    calls: list = []

    def boost_cycle(state):
        calls.append(state)
        return {}

    monkeypatch.setattr("app.harness.personal.resume.graph.boost_cycle", boost_cycle)
    source = _bag("drafts")
    _runtime, rows, items = await _open("boost", source)
    saved = _saved(rows)
    assert calls == []
    assert _choice(items)["gate"] == "output_targets"
    assert saved["phase"] == "intake"
    assert saved["work_mode"] == "resume_based"
    assert saved.get("goto") != "p3c_boost"
    _assert_kept(saved, source)


def _flat_fit(monkeypatch):
    seen = []

    async def fake(*_args, **_kwargs):
        seen.append(1)
        return {"fitScore": 5.0, "parts": {}, "topGap": "도메인", "plan": "FREE"}

    monkeypatch.setattr("app.framework.fit_judge.judge_fit", fake)
    return seen


async def test_boost_with_a_draft_enters_p3c_boost(monkeypatch):
    _flat_fit(monkeypatch)
    source = _bag()
    _runtime, rows, items = await _open("boost", source)
    saved = _saved(rows)
    assert _choice(items)["gate"] == "boost"
    assert saved["drafts"]["resume"] == "기존 초안"
    _assert_kept(saved, source)


async def test_boost_quick_start_with_markdown_enters_p3c_boost(monkeypatch):
    _flat_fit(monkeypatch)
    source = _bag()
    source["drafts"] = {"markdown": "마크다운 초안"}
    _runtime, rows, items = await _open("boost", source)
    saved = _saved(rows)
    assert _choice(items)["gate"] == "boost"
    assert saved["drafts"]["markdown"] == "마크다운 초안"
    assert saved["phase"] != "intake"


async def test_boost_with_a_draft_does_not_reenter(monkeypatch):
    seen = _flat_fit(monkeypatch)
    runtime, _rows, items = await _open("boost", _bag())
    assert _choice(items)["gate"] == "boost"
    assert len(seen) == 2
    payload = _payload("다음", "boost")
    payload["job_id"] = "99999999-9999-4999-8999-999999999998"
    again = await run(runtime, payload)
    assert _choice(again)["gate"] == "review"
    assert len(seen) == 3


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
