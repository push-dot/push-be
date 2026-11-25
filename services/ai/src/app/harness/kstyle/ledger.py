"""The evidence ledger every output cites, and the assumption log. Pure: storage is `kstyle.workspace`
for conversations and the checkpointed flow dict for employer flows."""
from __future__ import annotations

from typing import TypedDict

_QUOTE_LIMIT = 300
_CLAIM_LIMIT = 500
_QUOTE_FLOOR = 4


class Evidence(TypedDict):
    id: str
    kind: str
    source: str
    quote: str
    claim: str
    verified: bool


class Notes(TypedDict):
    evidence: list[Evidence]
    assumptions: list[str]
    read: list[str]
    steer: list[str]
    ask: dict | None


def empty_notes() -> Notes:
    return {"evidence": [], "assumptions": [], "read": [], "steer": [], "ask": None}


def squash(text: str) -> str:
    return " ".join(str(text).split())


def quoted_in(quote: str, text: str) -> bool:
    """The one rule for "this quote is in what was read": at least 4 characters, spacing ignored.
    Shorter quotes (a particle, a period) are in almost any text and prove nothing."""
    needle = squash(quote)
    return len(needle) >= _QUOTE_FLOOR and needle in squash(text or "")


def add_evidence(notes: Notes, kind: str, source: str, quote: str, claim: str, *, text: str) -> Evidence:
    quote = quote.strip()[:_QUOTE_LIMIT]
    taken = [int(item["id"][1:]) for item in notes["evidence"] if item["id"][1:].isdigit()]
    item: Evidence = {
        "id": f"E{max(taken, default=0) + 1}", "kind": kind, "source": source,
        "quote": quote, "claim": claim.strip()[:_CLAIM_LIMIT],
        # Code, not the model, decides whether the quote really is in what was read.
        "verified": quoted_in(quote, text),
    }
    notes["evidence"].append(item)
    return item


def assume(notes: Notes, text: str) -> None:
    text = text.strip()
    if text and text not in notes["assumptions"]:
        notes["assumptions"].append(text)


def ledger_text(notes: Notes, limit: int = 6000) -> str:
    items = sorted(notes["evidence"], key=lambda item: not item["verified"])
    lines: list[str] = []
    used = 0
    for item in items:
        mark = "확인" if item["verified"] else "미확인"
        line = f'{item["id"]} [{item["kind"]}·{mark}] {item["source"]}: {item["claim"]} — "{item["quote"]}"'
        if used + len(line) + 1 > limit:
            continue
        lines.append(line)
        used += len(line) + 1
    return "\n".join(lines)


def verified(notes: Notes) -> dict[str, Evidence]:
    return {item["id"]: item for item in notes.get("evidence") or [] if item.get("verified")}
