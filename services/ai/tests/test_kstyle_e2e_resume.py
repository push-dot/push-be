"""The resume flow end to end on the scripted loop, in AUTO: it stops only at the contract's gates, stage one
reads on the light tier, and the present reply has the final shape."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from scripts.kstyle_loop import play

CASES = Path(__file__).parent / "loop" / "cases" / "resume"
# packages/contracts/spec/conversations.ts: in AUTO the flow stops at these decision gates and at the gates
# blocked on the person.
CONTRACT = {"output_targets", "strategy", "review", "mode_select", "validate_cap", "read_failed", "ask"}


def _run(name: str):
    case = {**json.loads((CASES / name / "case.json").read_text(encoding="utf-8")), "name": name}
    return play(case)


def test_with_a_posting_page_auto_stops_only_at_contract_gates():
    rows, status, _log = _run("manufacturing-lead")
    gates = [row["stop"]["gate"] for row in rows if row["stop"]]
    assert status == "done"
    assert set(gates) <= CONTRACT and "read_failed" not in gates
    assert gates[0] == "mode_select" and "strategy" in gates and "review" in gates


def test_without_material_auto_also_stops_at_intake():
    # _must_stop: intake with no attachment, page or document is blocked on the person. The contract's
    # list does not name it.
    rows, status, _log = _run("hotel-newgrad")
    gates = [row["stop"]["gate"] for row in rows if row["stop"]]
    assert status == "done"
    assert set(gates) <= CONTRACT | {"intake"} and "intake" in gates


def test_stage_one_reads_on_the_light_tier():
    rows, _status, _log = _run("manufacturing-lead")
    assert any((row["summary"].get("tiers") or {}).get("light", {}).get("calls") for row in rows)
    assert any(event.get("name") == "posting_agent" for row in rows for event in row["events"])


def test_free_runs_no_reviewers():
    rows, _status, _log = _run("hotel-newgrad")
    assert not any((row["summary"].get("tiers") or {}).get("mid") for row in rows)


def test_strategy_reviewers_run_on_the_mid_tier_on_pro():
    rows, _status, _log = _run("manufacturing-lead")
    strategy = next(row for row in rows if row["stop"] and row["stop"]["gate"] == "strategy")
    assert strategy["summary"]["tiers"].get("mid", {}).get("calls", 0) >= 2


@pytest.mark.parametrize("name", ["hotel-newgrad", "manufacturing-lead"])
def test_the_present_reply_has_the_final_shape(name):
    rows, _status, _log = _run(name)
    reply = rows[-1]["reply"]
    made = reply.rfind("만든 것\n• ")
    assert made >= 0
    tail = reply[made:]
    order = [head for head in ("만든 것", "대신 정한 것", "확인이 필요한 점", "다음") if f"{head}\n• " in tail]
    assert order[0] == "만든 것" and [tail.index(f"{head}\n• ") for head in order] == sorted(
        tail.index(f"{head}\n• ") for head in order)
