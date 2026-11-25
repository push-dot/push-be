"""The fixed final message: what was made, what was decided for the user, what is left to check, and one
next step. Empty sections are dropped. It adds no URLs of its own."""
from __future__ import annotations

from dataclasses import dataclass, field

_MADE, _DECIDED, _LEFT, _NEXT = "만든 것", "대신 정한 것", "확인이 필요한 점", "다음"
_CAP = 3


@dataclass
class Final:
    made: list[str] = field(default_factory=list)       # at most 3
    decided: list[str] = field(default_factory=list)    # assumptions the user should know, newest 3
    left: list[str] = field(default_factory=list)       # findings that survived the retry, and late stages
    next: str = ""                                      # one line; "" omits it


def _block(head: str, items: list[str]) -> str:
    # The "• " list progress.marked_text draws; kept here so the framework does not import resume.
    return "\n".join([head, *(f"• {item}" for item in items)])


def render(final: Final) -> str:
    sections = [(_MADE, final.made[:_CAP]), (_DECIDED, final.decided[-_CAP:]), (_LEFT, final.left),
                (_NEXT, [final.next] if final.next.strip() else [])]
    return "\n\n".join(_block(head, [item for item in items if item.strip()])
                       for head, items in sections if any(item.strip() for item in items))


def late_lines(late: list[str], labels: dict[str, str]) -> list[str]:
    return [f"{labels.get(name, name)}: 시간 안에 끝나지 않아 빼고 진행했어요" for name in late]
