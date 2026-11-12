from __future__ import annotations

from contextvars import ContextVar
from uuid import UUID

_KINDS = frozenset({"file", "document", "posting", "link"})
_CAP = 5
_LINK_SQL = (
    "SELECT id FROM user_links "
    "WHERE user_id = $1 AND url = $2 AND deleted_at IS NULL "
    "LIMIT 1"
)
_STAMP_SQL = (
    "UPDATE documents SET created_by_bot_id = "
    "(SELECT bot_id FROM conversations WHERE id = $2) "
    "WHERE id = $1 AND created_by_bot_id IS NULL"
)

current_sources: ContextVar[TurnSources | None] = ContextVar("current_sources", default=None)


class TurnSources:
    def __init__(self) -> None:
        self._items: list[dict] = []
        self._seen: set[tuple[str, str]] = set()

    def add(self, kind, id_, title) -> None:
        if kind not in _KINDS:
            return
        ident = str(id_ or "").strip()
        label = str(title or "").strip()
        if not ident or not label:
            return
        key = (kind, ident)
        if key in self._seen or len(self._items) >= _CAP:
            return
        self._seen.add(key)
        self._items.append({"kind": kind, "id": ident, "title": label})

    def list(self) -> list[dict]:
        return [dict(item) for item in self._items]


def note(kind, id_, title) -> None:
    bucket = current_sources.get()
    if bucket is None:
        return
    bucket.add(kind, id_, title)


def listed() -> list[dict]:
    bucket = current_sources.get()
    if bucket is None:
        return []
    return bucket.list()


def _field(args, key):
    if isinstance(args, dict):
        return args.get(key)
    return getattr(args, key, None)


def _text(value) -> str:
    return value.strip() if isinstance(value, str) else ""


def _uuid(value):
    try:
        return UUID(str(value))
    except (TypeError, ValueError, AttributeError):
        return None


async def _link_id(db, user_id, url: str):
    if db is None or not url:
        return None
    from app.harness.material_access import current_access

    access = current_access.get()
    if access is not None and not access.may_search():
        return None
    uid = _uuid(user_id)
    if uid is None:
        return None
    try:
        row = await db.q().fetchrow(_LINK_SQL, uid, url)
    except Exception:
        return None
    if not row:
        return None
    try:
        found = row["id"]
    except (KeyError, TypeError, IndexError):
        return None
    return str(found) if found else None


async def note_tool(name, args, result, *, user_id, db) -> None:
    try:
        await _note_tool(name, args, result, user_id=user_id, db=db)
    except Exception:
        return


async def _note_tool(name, args, result, *, user_id, db) -> None:
    if not isinstance(result, dict) or result.get("error"):
        return
    if name == "get_posting":
        company = _text(result.get("company"))
        posting_id = _field(args, "posting_id") or result.get("id")
        if company and posting_id:
            note("posting", posting_id, f"{company} 채용 공고")
        return
    if name == "get_document":
        title = _text(result.get("title"))
        document_id = _field(args, "document_id") or result.get("id")
        if title and document_id:
            note("document", document_id, title)
        return
    if name != "read_page":
        return
    final = _text(result.get("url"))
    if not final:
        return
    found = await _link_id(db, user_id, final)
    asked = _text(_field(args, "url"))
    if found is None and asked and asked != final:
        found = await _link_id(db, user_id, asked)
    if found:
        note("link", found, final)


async def stamp_created_by(db, document_id, conversation_id) -> None:
    if db is None:
        return
    doc_id = document_id if isinstance(document_id, UUID) else _uuid(document_id)
    if doc_id is None:
        return
    try:
        await db.q().execute(_STAMP_SQL, doc_id, _uuid(conversation_id))
    except Exception:
        return
