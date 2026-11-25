"""Ask only when the plan drops or lightens something the user asked for: once, at most three items, in a
fixed shape through the existing choice card. Everything else is assumed and logged."""
from __future__ import annotations

from typing import TypedDict

_MAX = 3
_HEAD = "이렇게 정했어요. 괜찮으면 '그대로', 다시 넣을 게 있으면 알려 주세요."


class AskItem(TypedDict):
    what: str
    why: str


def needs_ask(items: list[dict]) -> list[AskItem]:
    """items: {"source": "user"|"harness"|..., "verdict": "keep"|"lighten"|"cut", "what", "why"}."""
    picked = [item for item in items
              if isinstance(item, dict) and item.get("source") == "user" and item.get("verdict") in ("cut", "lighten")]
    return [{"what": str(item.get("what") or ""), "why": str(item.get("why") or "")} for item in picked[:_MAX]]


def ask_once(notes) -> bool:
    """False when this flow already asked."""
    return notes.get("ask") is None


def ask_title(items: list[AskItem]) -> str:
    lines = [f"{index}. {item['what']} — {item['why']}" for index, item in enumerate(items[:_MAX], 1)]
    return "\n".join([_HEAD, *lines])


def ask_options() -> list[dict]:
    return [{"id": "keep_plan", "label": "그대로"}, {"id": "restore", "label": "다시 넣기"}]
