"""Personal chat end to end on the scripted loop: a plain answer, a two-source question through read_sources,
and a document edit that invents a number, is rejected, then is fixed."""
from __future__ import annotations

import json
from pathlib import Path

from scripts.kstyle_loop import play

CASES = Path(__file__).parent / "loop" / "cases" / "personal"


def _case(name: str) -> dict:
    return {**json.loads((CASES / name / "case.json").read_text(encoding="utf-8")), "name": name}


def _tools(rows: list[dict], name: str) -> list[dict]:
    return [event for row in rows for event in row["events"]
            if event.get("type") == "tool" and event.get("name") == name and event.get("state") != "run"]


def test_a_question_that_needs_no_reading_is_one_main_call_and_no_stop():
    rows, status, log = play(_case("logistics-junior"))
    assert status == "done" and len(rows) == 1 and rows[0]["stop"] is None
    assert log == [("", "main")]
    assert rows[0]["summary"]["tiers"] == {"main": {"calls": 1, "in": 10, "out": 5}}
    assert not [event for event in rows[0]["events"] if event.get("type") == "tool"]


def test_two_sources_are_one_read_sources_call_with_verified_findings():
    rows, status, log = play(_case("game-senior"))
    assert status == "done" and len(rows) == 1
    (done,) = _tools(rows, "read_sources")
    findings = done["result"]["findings"]
    assert {item["source"] for item in findings} == {
        "https://blog.example.com/render-a", "https://notes.example.org/render-b"}
    assert all(item["id"] and item["quote"] for item in findings)
    assert done["result"]["unread"] == [] and done["result"]["late"] == []
    # One light reader per source; the main model calls the tool once and answers once.
    tiers = rows[0]["summary"]["tiers"]
    assert tiers["light"]["calls"] == 2 and tiers["main"]["calls"] == 2
    assert [tier for role, tier in log if role.startswith("너는 자료 하나만")] == ["light", "light"]


_DOCUMENT = "5d000000-0000-4000-8000-000000000005"


def _edit(after: str, call_id: str) -> dict:
    return {"tool_calls": [{"name": "edit_document", "id": call_id, "args": {
        "document_id": _DOCUMENT, "before": "배포 시간을 줄였어요", "after": after}}]}


def test_an_edit_with_an_invented_number_is_rejected_then_the_fix_reaches_the_card():
    case = {
        "surface": "personal", "name": "edit", "max_turns": 1, "access_mode": "ALWAYS_ASK",
        "text": "배포 경험 문장을 더 자연스럽게 다듬어 줘",
        "script": {"": [_edit("배포 시간을 40% 줄였어요", "call-edit-1"),
                        _edit("배포 시간을 눈에 띄게 줄였어요", "call-edit-2")]},
    }
    rows, _status, _log = play(case)
    (rejected,) = _tools(rows, "edit_document")
    assert rejected["result"] == {"error": "UNSUPPORTED_NUMBER", "detail": ["40%"]}
    assert rows[0]["stop"]["kind"] == "DOCUMENT_EDIT", "the fixed edit waits on the usual diff card"
