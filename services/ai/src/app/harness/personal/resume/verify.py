"""Deterministic checks a draft must pass before review: nothing in it is made up. What to stress
(a project, GitHub, the company) is the user's call and never checked here. Pure: no I/O. Built on
`app.harness.kstyle.verify`."""
from __future__ import annotations

from app.harness.kstyle.ledger import Notes
from app.harness.kstyle.verify import finding, unknown_ids, unsupported_numbers


def verify_draft(markdown: str, used: list[str], notes: Notes, *, resume_text: str) -> list[dict]:
    """[{level, rule, detail}]. `detail` is data (ids, tokens); progress.verify_text words it."""
    findings: list[dict] = []
    unknown = unknown_ids(used, notes)
    if unknown:
        findings.append(finding("P0", "unknown_evidence", ", ".join(unknown)))
    quotes = [str(item.get("quote") or "") for item in notes.get("evidence") or [] if item.get("verified")]
    missing = unsupported_numbers(markdown, resume_text, *quotes)
    if missing:
        findings.append(finding("P0", "unsupported_number", ", ".join(missing)))
    return findings
