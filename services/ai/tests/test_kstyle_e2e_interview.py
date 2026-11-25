"""Interview prep end to end on the scripted loop: the chat agent calls prepare_interview and the result keeps
its shape; with the k-style path every evidence id is the interview's own and an ungrounded STAR field stays
in needsInput."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from scripts.kstyle_loop import play

CASES = Path(__file__).parent / "loop" / "cases" / "interview"
KEYS = {"questions", "starAnswers", "research"}


def _run(name: str):
    case = {**json.loads((CASES / name / "case.json").read_text(encoding="utf-8")), "name": name}
    rows, status, log = play(case)
    (done,) = [event for row in rows for event in row["events"]
               if event.get("name") == "prepare_interview" and event.get("state") == "ok"]
    return case, rows, status, log, done["result"]["result"]["value"]


@pytest.mark.parametrize("name", ["data-junior", "safety-senior"])
def test_prepare_keeps_its_result_shape(name):
    case, rows, status, _log, value = _run(name)
    assert status == "done" and rows[-1]["stop"] is None
    assert set(value) == KEYS
    assert [item["requirement"] for item in value["questions"]] == case["interview"]["requirements"]
    assert [item["evidenceIds"] for item in value["starAnswers"]] == [[row["id"]] for row in case["interview"]["evidence"]]


def test_questions_are_korean_and_cite_only_the_interviews_evidence():
    case, _rows, _status, _log, value = _run("data-junior")
    own = {row["id"] for row in case["interview"]["evidence"]}
    assert not any(item["question"].startswith("Describe your experience") for item in value["questions"])
    assert all(set(item["evidenceIds"]) <= own for item in value["questions"])
    assert value["questions"][0]["evidenceIds"] == [case["interview"]["evidence"][0]["id"]]
    assert value["questions"][1]["evidenceIds"] == [], "E9 is not in the ledger"


def test_an_invented_number_stays_out_and_its_field_needs_input():
    _case, _rows, _status, _log, value = _run("data-junior")
    first = value["starAnswers"][0]
    assert first["action"] == "주간 주문 지표를 SQL로 정의했다."
    assert first["result"] == "" and "result" in first["needsInput"]
    assert "30%" not in json.dumps(value, ensure_ascii=False)


def test_readers_run_on_the_light_tier_and_the_writer_on_main():
    _case, rows, _status, log, _value = _run("data-junior")
    assert {tier for role, tier in log if role in ("evidence_reader", "company_reader")} == {"light"}
    assert {tier for role, tier in log if role == "interview_writer"} == {"main"}
    assert rows[0]["summary"]["tiers"]["light"]["calls"] >= 2
