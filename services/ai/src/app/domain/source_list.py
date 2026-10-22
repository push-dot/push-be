from __future__ import annotations

from datetime import datetime, timezone
from uuid import UUID

from app.domain.pagination import Cursor

_AI_MIME = "application/json"


def merge_library(uploads: list[dict], documents: list[dict], kind: str | None,
                  cursor: Cursor | None, limit: int) -> tuple[list[dict], bool]:
    items: list[dict] = []
    if kind in (None, "UPLOAD"):
        items.extend(_upload(row) for row in uploads)
    if kind in (None, "AI"):
        items.extend(_document(row) for row in documents)
    items.sort(key=_rank, reverse=True)
    if cursor is not None:
        point = _rank({"createdAt": cursor.created_at, "id": cursor.id})
        items = [item for item in items if _rank(item) < point]
    has_more = len(items) > limit
    return items[:limit], has_more


def _upload(row: dict) -> dict:
    return {"id": row["id"], "fileName": row["file_name"],
            "mimeType": row["mime_type"], "size": row["size"],
            "pageCount": row.get("page_count"), "createdAt": row["created_at"],
            "origin": row.get("origin") or "UPLOAD"}


def _document(row: dict) -> dict:
    return {"id": row["id"], "fileName": row["title"], "mimeType": _AI_MIME,
            "size": 0, "pageCount": None, "createdAt": row["created_at"],
            "origin": "AI"}


def _rank(item: dict) -> tuple[datetime, UUID]:
    created = item["createdAt"]
    if created.tzinfo is None:
        created = created.replace(tzinfo=timezone.utc)
    else:
        created = created.astimezone(timezone.utc)
    ident = item["id"]
    if not isinstance(ident, UUID):
        ident = UUID(str(ident))
    return created, ident
