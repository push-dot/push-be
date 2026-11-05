from __future__ import annotations

import json

from langgraph.checkpoint.memory import MemorySaver
from langgraph.types import Command

from app.harness.approvals import card_options
from app.harness.personal.resume.graph import (
    _apply_answer,
    _choice,
    _section_answer,
    build_resume_graph,
    phase_instructions,
)
from app.harness.personal.resume.progress import intake_panel
from tests.test_harness_resume import _Approvals, _base, _config, _PhaseModel, _run
from tests.test_resume_flow_decisions import _choice as _first_choice
from tests.test_resume_flow_decisions import _events


def test_card_options_union_includes_sections_and_submit():
    event = _choice(
        {
            "conversation_id": "c",
            "job_id": "j",
            "inputs": {"fileName": "a.pdf", "documentId": "doc-1"},
        },
        "output_targets",
        auto=False,
    )
    ids = [item["id"] for item in card_options(event)]
    top = {item["id"] for item in event["options"]}
    section_ids = {
        option["id"]
        for section in event["sections"]
        if section["kind"] != "rows"
        for option in section["options"]
    }
    assert set(ids) == top | section_ids | {"submit"}
    assert "m_file" not in ids
    assert "cancel" in ids
    assert all(item["id"] != "submit" for item in event["options"])
    assert all(item.get("id") for item in card_options(event))


def test_single_section_keeps_first_pick():
    sections = intake_panel({})
    picked = _section_answer(
        sections,
        {
            "option_id": "submit",
            "option_ids": ["submit", "concise", "professional"],
        },
    )
    assert picked["tone"] == ["professional"]


def test_review_toggle_off_when_submit_without_photo():
    update = _apply_answer(
        {},
        "review",
        {
            "option_id": "submit",
            "option_ids": ["submit", "MODERN"],
        },
    )
    assert update["template"] == "MODERN"
    assert update["profile_photo"] is False


def test_review_old_answer_defaults_photo_on():
    update = _apply_answer({}, "review", {"option_id": "MODERN"})
    assert update["template"] == "MODERN"
    assert update["profile_photo"] is True


async def _reach(gate: str):
    graph = build_resume_graph(MemorySaver(), model=_PhaseModel(), db=_Approvals())
    config = _config()
    payload = _base()
    for _ in range(8):
        events = await _events(graph, payload, config)
        snap = await graph.aget_state(config)
        choice = next((event for event in events if event.get("type") == "choice"), None)
        if choice is not None and snap.next and choice["gate"] == gate:
            return graph, config
        if choice is not None and snap.next:
            payload = Command(resume={"option_id": choice["recommended"]})
            continue
        payload = {}
    raise AssertionError(gate)


async def test_output_targets_answer_with_tone_skips_tone_gate():
    graph, config = await _reach("output_targets")
    events = await _events(
        graph,
        Command(
            resume={
                "option_id": "submit",
                "option_ids": ["submit", "resume", "portfolio", "concise"],
            }
        ),
        config,
    )
    assert _first_choice(events)["gate"] == "intake"
    snap = await graph.aget_state(config)
    assert snap.values["output_targets"] == ["resume", "portfolio"]
    assert snap.values["tone"] == "concise"


async def test_output_targets_old_answer_still_asks_tone():
    graph, config = await _reach("output_targets")
    events = await _events(graph, Command(resume={"option_ids": ["resume"]}), config)
    assert _first_choice(events)["gate"] == "tone"
    snap = await graph.aget_state(config)
    assert snap.values["output_targets"] == ["resume"]
    assert not snap.values.get("tone")


async def test_auto_mode_uses_section_defaults(monkeypatch):
    async def fake(*_args, **_kwargs):
        return {"fitScore": 5.0, "parts": {}, "topGap": "도메인", "plan": "FREE"}

    monkeypatch.setattr("app.framework.fit_judge.judge_fit", fake)
    graph = build_resume_graph(MemorySaver(), model=_PhaseModel(), db=_Approvals())
    config = _config()
    await _run(
        graph,
        _base(
            access_mode="BYPASS",
            inputs={"attachments": ["resume.pdf"], "fileName": "a.pdf"},
        ),
        config,
    )
    await _run(graph, Command(resume={"option_id": "resume_based"}), config)
    snap = await graph.aget_state(config)
    for _ in range(8):
        if snap.values.get("template") == "CLASSIC" and snap.values.get("profile_photo") is True:
            break
        await _run(graph, {}, config)
        snap = await graph.aget_state(config)
    assert snap.values["output_targets"] == ["resume"]
    assert snap.values["tone"] == "preserve"
    assert snap.values["template"] == "CLASSIC"
    assert snap.values["profile_photo"] is True


async def test_review_answer_stores_profile_photo_on_the_scenario():
    db = _Approvals()
    graph = build_resume_graph(MemorySaver(), model=_PhaseModel(), db=db)
    config = _config()
    await _run(graph, _base(phase="review"), config)
    await _run(
        graph,
        Command(
            resume={
                "option_id": "submit",
                "option_ids": ["submit", "MODERN"],
            }
        ),
        config,
    )
    snap = await graph.aget_state(config)
    assert snap.values["template"] == "MODERN"
    assert snap.values["profile_photo"] is False
    saved = json.loads(db.files["01_scenario.json"])
    assert saved["template"] == "MODERN"
    assert saved["profile_photo"] is False


def test_publish_prompt_includes_apply_list():
    text = phase_instructions("publish", {"review": {"apply": ["성과 숫자", "키워드"]}})
    assert "review.apply의 수정만 반영한다." in text
    assert "성과 숫자" in text
    assert "review.apply의 수정만 반영한다." not in phase_instructions(
        "publish", {"review": {"apply": []}}
    )
    assert "review.apply의 수정만 반영한다." not in phase_instructions("publish", {})
