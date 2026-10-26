from __future__ import annotations
import base64
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Final
from uuid import UUID

DEFAULT_LIMIT: Final = 50
MAX_LIMIT: Final = 100


@dataclass(frozen=True, slots=True)
class Cursor:
    created_at: datetime
    id: UUID

    def encode(self) -> str:
        ts = self.created_at.astimezone(timezone.utc)
        frac = f".{ts.microsecond:06d}" if ts.microsecond else ""
        raw = ts.strftime("%Y-%m-%dT%H:%M:%S") + frac + "Z|" + str(self.id)
        return base64.urlsafe_b64encode(raw.encode()).rstrip(b"=").decode()


def decode_cursor(s: str) -> Cursor:
    try:
        raw = base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))
        created_at, id_ = raw.decode().split("|", 1)
        return Cursor(created_at=datetime.fromisoformat(created_at), id=UUID(id_))
    except ValueError:
        raise ValueError("bad cursor") from None


@dataclass(slots=True)
class PageRequest:
    limit: int = 0
    cursor: Cursor | None = None

    def effective_limit(self) -> int:
        if self.limit <= 0:
            return DEFAULT_LIMIT
        return min(self.limit, MAX_LIMIT)


@dataclass(slots=True)
class Page[T]:
    items: list[T] = field(default_factory=list)
    next_cursor: str | None = None
    has_more: bool = False


def new_page[T](items: list[T], limit: int, cursor_of: Callable[[T], Cursor]) -> Page[T]:
    """`items` holds up to limit+1 rows; the extra row only signals another page."""
    if len(items) <= limit:
        return Page(items=items or [])
    kept = items[:limit]
    return Page(items=kept, next_cursor=cursor_of(kept[-1]).encode(), has_more=True)
