from __future__ import annotations

from app.harness.personal.resume.verify import verify_draft
from app.harness.personal.resume.workspace import empty_notes


def _ev(id_, kind="repo", quote="", verified=True):
    return {"id": id_, "kind": kind, "source": "acme-labs/shop-api:README.md", "quote": quote,
            "claim": "c", "verified": verified}


def _notes(*items):
    notes = empty_notes()
    notes["evidence"] = list(items)
    return notes


def _rules(markdown="# 김푸시", used=(), notes=None, resume_text=""):
    found = verify_draft(markdown, list(used), notes or empty_notes(), resume_text=resume_text)
    return {item["rule"]: item for item in found}


def test_unknown_evidence_flags_ids_outside_the_verified_ledger():
    notes = _notes(_ev("E1"), _ev("E2", verified=False))
    found = _rules(used=["E1", "E2", "E9"], notes=notes)["unknown_evidence"]
    assert found == {"level": "P0", "rule": "unknown_evidence", "detail": "E2, E9"}
    assert "unknown_evidence" not in _rules(used=["E1"], notes=notes)


def test_what_to_stress_is_never_forced():
    # Uncited repo or company evidence and a missing project name are the user's choice, not a failure.
    notes = _notes(_ev("E1"), _ev("E2"), _ev("E3"), _ev("C1", kind="company"))
    assert _rules(markdown="# 다른 일", used=[], notes=notes) == {}


def test_unsupported_number_passes_numbers_from_the_resume_or_a_ledger_quote():
    notes = _notes(_ev("E1", quote="p99 지연을 120  ms 로 줄였다"), _ev("E2", quote="40%", verified=False))
    markdown = "- 응답을 30 % 줄였어요\n- 지연 120ms\n- 오류 40% 감소\n- 처리량 1.5배"
    found = _rules(markdown=markdown, used=["E1"], notes=notes, resume_text="응답 시간 30%  단축")
    assert found["unsupported_number"]["detail"] == "40%, 1.5배"
    assert found["unsupported_number"]["level"] == "P0"
    assert "unsupported_number" not in _rules(markdown="- 처리량 1.5배", resume_text="1.5 배")


def test_unsupported_number_does_not_borrow_a_longer_number():
    assert _rules(markdown="30%", resume_text="130%")["unsupported_number"]["detail"] == "30%"


def test_unsupported_number_ignores_years_and_dates():
    markdown = "- 2023 초 입사\n- 2024.03 초에 출시\n- 2024-03-15 배포\n- 3/15 오픈\n- 2021년"
    assert _rules(markdown=markdown) == {}
