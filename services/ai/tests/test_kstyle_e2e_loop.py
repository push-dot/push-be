"""The evaluation loop itself: the scripted persona, stats.json, the cases, and every case run to its end
on its own script. Free: no provider, no network."""
from __future__ import annotations

import json
import re
from pathlib import Path
from urllib.parse import urlparse

import pytest

from scripts.kstyle_loop import KEEP, persona, run_case
from scripts.kstyle_stats import RATES, build, left_lines

CASES = Path(__file__).parent / "loop" / "cases"
ALL = sorted(path.parent for path in CASES.glob("*/*/case.json"))
FIELDS = {"turns", "stops", "model_calls", "cost_estimate", "wall_seconds", "late", "left"}
SURFACES = {"personal", "resume", "interview", "employer"}


def _case(path: Path) -> dict:
    return json.loads((path / "case.json").read_text(encoding="utf-8"))


def _card(recommended=None, ids=("a", "b")) -> dict:
    card = {"type": "choice", "id": "g1", "options": [{"id": item, "label": item} for item in ids]}
    if recommended is not None:
        card["recommended"] = recommended
    return card


def test_persona_picks_the_recommended_option():
    assert persona(_card("b")) == {"text": "", "resume": {"approvalId": "g1", "optionId": "b"}}


def test_persona_falls_back_to_the_first_option():
    assert persona(_card())["resume"]["optionId"] == "a"
    assert persona(_card(""))["resume"]["optionId"] == "a"
    assert persona(_card("gone"))["resume"]["optionId"] == "a", "a recommended id not on the card is ignored"


def test_persona_keeps_the_plan_when_nothing_is_offered():
    assert persona(_card(ids=())) == {"text": KEEP}
    assert persona(None) == {"text": KEEP}
    assert KEEP == "그대로"


def _turn(tiers=None, stages=(), stop=None, seconds=1.0, reply=""):
    return {"summary": {"tiers": tiers or {}, "stages": list(stages)}, "stop": stop, "seconds": seconds,
            "reply": reply}


def test_stats_have_exactly_the_planned_fields_and_sum_by_tier():
    reply = "만든 것\n• 초안\n\n확인이 필요한 점\n• 연봉이 비어 있어요\n• 근무지가 없어요\n\n다음\n• 게시"
    stats = build([
        _turn({"main": {"calls": 1, "in": 1_000_000, "out": 0}}, [{"stage": "one", "seconds": 2.0, "late": ["a"]}],
              stop={"id": "x", "gate": "pf_role", "kind": "EMPLOYER_GATE"}, seconds=3.0),
        _turn({"main": {"calls": 2, "in": 0, "out": 1_000_000}, "light": {"calls": 3, "in": 1_000_000, "out": 0},
               "mid": {"calls": 2, "in": 10, "out": 5}},
              [{"stage": "one", "seconds": 1.5, "late": ["a", "b"]}], seconds=4.5, reply=reply),
    ])
    assert set(stats) == FIELDS
    assert stats["turns"] == 2
    assert stats["stops"] == {"count": 1, "gates": ["pf_role"]}
    assert stats["model_calls"]["main"] == {"calls": 3, "input_tokens": 1_000_000, "output_tokens": 1_000_000}
    assert stats["model_calls"]["light"]["calls"] == 3
    main_in, main_out = RATES["main"]
    assert stats["cost_estimate"]["by_tier"]["main"] == pytest.approx(main_in + main_out)
    assert stats["cost_estimate"]["by_tier"]["light"] == pytest.approx(RATES["light"][0])
    assert stats["cost_estimate"]["usd"] == pytest.approx(sum(stats["cost_estimate"]["by_tier"].values()))
    assert stats["wall_seconds"] == {"total": 7.5, "stages": {"one": 3.5}}
    assert stats["late"] == ["a", "b"]
    assert stats["left"] == ["연봉이 비어 있어요", "근무지가 없어요"]


def test_a_tier_with_no_rate_is_named_not_priced():
    stats = build([_turn({"other": {"calls": 1, "in": 5, "out": 5}})])
    assert stats["cost_estimate"]["unpriced_tiers"] == ["other"] and stats["cost_estimate"]["usd"] == 0


def test_left_lines_stop_at_the_next_heading():
    assert left_lines("확인이 필요한 점\n• 하나\n\n다음\n• 둘") == ["하나"]
    assert left_lines("그냥 답이에요") == []


def test_every_surface_has_two_cases_from_different_domains_and_levels():
    by_surface: dict[str, list[dict]] = {}
    for path in ALL:
        case = _case(path)
        assert case["surface"] == path.parent.name
        by_surface.setdefault(case["surface"], []).append(case)
    assert set(by_surface) == SURFACES
    for surface, cases in by_surface.items():
        assert len(cases) >= 2, surface
        assert len({case["domain"] for case in cases}) == len(cases), surface
        assert len({case["seniority"] for case in cases}) == len(cases), surface


_URL = re.compile(r"https?://[^\s\"']+")


@pytest.mark.parametrize("path", ALL, ids=lambda p: f"{p.parent.name}/{p.name}")
def test_cases_are_synthetic(path):
    text = (path / "case.json").read_text(encoding="utf-8")
    for url in _URL.findall(text):
        host = urlparse(url).hostname or ""
        assert host.endswith((".example.com", ".example.org")), url
    assert "github.com" not in text.lower()


@pytest.mark.parametrize("path", ALL, ids=lambda p: f"{p.parent.name}/{p.name}")
def test_every_case_runs_to_its_end_on_its_script(path, tmp_path):
    result = run_case(path, tmp_path)
    stats = json.loads((tmp_path / "stats.json").read_text(encoding="utf-8"))
    rows = [json.loads(line) for line in (tmp_path / "transcript.jsonl").read_text(encoding="utf-8").splitlines()]
    assert result["status"] == "done"
    assert set(stats) == FIELDS
    assert stats["turns"] == len(rows) == stats["stops"]["count"] + 1
    assert stats["model_calls"].get("main", {}).get("calls", 0) >= 1
    # The persona never adds instructions: every answer is an offered option or "그대로".
    for row in rows[:-1]:
        assert row["stop"]["id"] and (row["answer"].get("resume") or row["answer"] == {"text": KEEP})
    assert rows[-1]["reply"].strip()


def test_a_scripted_run_is_deterministic(tmp_path):
    path = CASES / "resume" / "hotel-newgrad"
    run_case(path, tmp_path / "one")
    run_case(path, tmp_path / "two")
    one, two = (json.loads((tmp_path / name / "stats.json").read_text(encoding="utf-8")) for name in ("one", "two"))
    for key in FIELDS - {"wall_seconds"}:
        assert one[key] == two[key], key
