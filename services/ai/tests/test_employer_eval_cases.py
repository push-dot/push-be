from __future__ import annotations

import json
from pathlib import Path

from app.domain.fair_hiring import banned_in_interview, banned_in_posting
from app.harness.employer.schemas import PostingDraft

CASES = json.loads(
    (Path(__file__).resolve().parents[1] / "eval" / "employer" / "cases.json").read_text(
        encoding="utf-8"
    )
)


def test_posting_cases_match_the_deterministic_guard():
    for case in CASES["postings"]:
        found = banned_in_posting(PostingDraft.model_validate(case["draft"]).text())
        assert set(case["banned"]) <= set(found), case["id"]
        if not case["banned"]:
            assert found == [], case["id"]


def test_interview_traps_are_all_caught():
    for question in CASES["interview_traps"]:
        assert banned_in_interview(question), question


def test_documents_cover_each_claim_signal_and_a_solid_control():
    kinds = [d["kind"] for d in CASES["documents"]]
    # One solid control made the false-CHECK rate 0 or 1; four make it a rate.
    assert kinds.count("CHECK") >= 4 and kinds.count("SUPPORTED") >= 4


def test_eval_thresholds_match_the_design():
    from eval.employer.run_employer_eval import passed

    ok = {
        "posting_banned_left": 0,
        "interview_forbidden_left": 0,
        "verdicts": 0,
        "planted_recall": 0.8,
        "solid_false_check": 0.2,
    }
    assert passed(ok)
    assert not passed({**ok, "planted_recall": 0.75})
    assert not passed({**ok, "verdicts": 1})
