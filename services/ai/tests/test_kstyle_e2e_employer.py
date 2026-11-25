"""Employer posting draft end to end on the scripted loop: the gates in order, reviewers on a paid plan, and
the final reply."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.domain.services.conversation import _live_event
from scripts.kstyle_loop import play

CASES = Path(__file__).parent / "loop" / "cases" / "employer"
NAMES = ["logistics-saas-junior", "medical-firmware-senior"]


def _run(name: str):
    case = {**json.loads((CASES / name / "case.json").read_text(encoding="utf-8")), "name": name}
    return play(case)


@pytest.mark.parametrize("name", NAMES)
def test_posting_stops_at_role_then_confirm_then_saves_the_draft(name):
    rows, status, _log = _run(name)
    assert status == "done"
    assert [row["stop"]["gate"] for row in rows if row["stop"]] == ["pf_role", "pf_confirm_1"]
    assert {row["stop"]["kind"] for row in rows if row["stop"]} == {"EMPLOYER_GATE"}
    assert [row["answer"]["resume"]["optionId"] for row in rows if row["stop"]][1] == "save"
    assert "```posting-draft" in rows[-1]["reply"]


@pytest.mark.parametrize("name", NAMES)
def test_reviewers_run_on_the_mid_tier_on_pro(name):
    rows, _status, _log = _run(name)
    tiers = [row["summary"].get("tiers") or {} for row in rows]
    assert sum(item.get("mid", {}).get("calls", 0) for item in tiers) == 2


@pytest.mark.parametrize("name", NAMES)
def test_the_saved_reply_has_the_final_shape(name):
    rows, _status, _log = _run(name)
    reply = rows[-1]["reply"]
    assert reply.startswith("만든 것\n• ")
    heads = [line for line in reply.split("```")[0].splitlines() if line and not line.startswith("• ")]
    assert heads == sorted(heads, key=["만든 것", "대신 정한 것", "확인이 필요한 점", "다음"].index)


def test_the_flow_streams_its_cards_and_events():
    rows, _status, _log = _run(NAMES[0])
    kinds = {event.get("type") for row in rows for event in row["events"]}
    assert {"choice", "tool"} <= kinds
    # Every typed event is one the worker stores, so the client sees it live and on reload.
    stored = [_live_event(e, "job-1") for row in rows for e in row["events"] if e.get("type")]
    assert None not in stored
    research = [e for row in rows for e in row["events"] if e.get("name") == "research_company"]
    assert research and research[-1]["state"] == "ok"
    # The draft is in view before the confirm gate asks about it.
    confirm = next(row for row in rows if (row["stop"] or {}).get("gate") == "pf_confirm_1")
    assert "```posting-draft" in confirm["reply"]
    # A gate's card goes out on the turn that opens it, never again on the turn that answers it.
    cards = [[event["id"] for event in row["events"] if event.get("type") == "choice"]
             for row in rows]
    assert cards[:2] == [[rows[0]["stop"]["id"]], [rows[1]["stop"]["id"]]] and cards[2:] == [[]]
