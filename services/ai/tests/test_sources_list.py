from __future__ import annotations

from datetime import datetime, timezone
from uuid import UUID

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.errors import domain_error_handler
from app.api.routers.evidence import router
from app.domain import entities as ent
from app.domain.errors import DomainError
from app.domain.pagination import Cursor, decode_cursor

USER_ID = UUID("00000000-0000-4000-8000-0000000000aa")
OTHER_ID = UUID("00000000-0000-4000-8000-0000000000ff")
NEW_ID = UUID("00000000-0000-4000-8000-000000000002")
MID_ID = UUID("00000000-0000-4000-8000-000000000004")
HIGH_ID = UUID("00000000-0000-4000-8000-000000000009")
LOW_ID = UUID("00000000-0000-4000-8000-000000000001")
T_NEW = datetime(2026, 3, 3, tzinfo=timezone.utc)
T_MID = datetime(2026, 2, 2, tzinfo=timezone.utc)
T_OLD = datetime(2026, 1, 1, tzinfo=timezone.utc)


def _iso(value: datetime) -> str:
    return value.strftime("%Y-%m-%dT%H:%M:%SZ")


def _uploads():
    return [
        {"id": LOW_ID, "file_name": "notes.txt", "mime_type": "text/plain",
         "size": 3, "page_count": None, "origin": None, "created_at": T_OLD},
        {"id": HIGH_ID, "file_name": "draft.docx",
         "mime_type": "application/octet-stream", "size": 8, "page_count": None,
         "origin": "AI", "created_at": T_OLD},
        {"id": NEW_ID, "file_name": "resume.pdf", "mime_type": "application/pdf",
         "size": 1200, "page_count": 4, "origin": "UPLOAD", "created_at": T_NEW},
    ]


def _documents():
    return [{"id": MID_ID, "title": "cover letter", "created_at": T_MID}]


def _item(id_, file_name, mime_type, size, page_count, created_at, origin):
    return {"id": str(id_), "fileName": file_name, "mimeType": mime_type,
            "size": size, "pageCount": page_count, "createdAt": _iso(created_at),
            "origin": origin}


class _AsUser:
    def __init__(self, app, user):
        self.app = app
        self.user = user

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            scope.setdefault("state", {})["user"] = self.user
        await self.app(scope, receive, send)


class _Rows:
    def __init__(self, sources, documents):
        self.sources = sources
        self.documents = documents
        self.calls = []

    def q(self):
        return self

    async def fetch(self, sql, *args):
        self.calls.append((sql, args))
        if "documents" in sql:
            return [dict(row) for row in self.documents]
        if "sources" in sql:
            return [dict(row) for row in self.sources]
        return []


def _client(db: _Rows) -> TestClient:
    app = FastAPI()
    app.add_exception_handler(DomainError, domain_error_handler)
    app.include_router(router, prefix="/api/v1")
    app.add_middleware(_AsUser, user=ent.User(
        id=USER_ID, display_name="Ada",
        created_at=datetime.now(timezone.utc)))
    app.state.db = db
    return TestClient(app)


def _db() -> _Rows:
    return _Rows(_uploads(), _documents())


def test_list_merges_uploads_and_documents_newest_first():
    res = _client(_db()).get("/api/v1/sources")
    assert res.status_code == 200
    body = res.json()
    assert body["data"] == [
        _item(NEW_ID, "resume.pdf", "application/pdf", 1200, 4, T_NEW, "UPLOAD"),
        _item(MID_ID, "cover letter", "application/json", 0, None, T_MID, "AI"),
        _item(HIGH_ID, "draft.docx", "application/octet-stream", 8, None, T_OLD, "AI"),
        _item(LOW_ID, "notes.txt", "text/plain", 3, None, T_OLD, "UPLOAD"),
    ]
    assert body["page"] == {"nextCursor": None, "hasMore": False}


def test_kind_ai_drops_uploads():
    db = _db()
    res = _client(db).get("/api/v1/sources", params={"kind": "AI"})
    assert res.status_code == 200
    assert res.json()["data"] == [
        _item(MID_ID, "cover letter", "application/json", 0, None, T_MID, "AI")]
    assert db.calls
    for sql, _args in db.calls:
        assert "documents" in sql
        assert "sources" not in sql


def test_cursor_skips_the_first_item_and_has_more():
    cursor = Cursor(created_at=T_NEW, id=NEW_ID).encode()
    res = _client(_db()).get(
        "/api/v1/sources", params={"cursor": cursor, "limit": 1})
    assert res.status_code == 200
    body = res.json()
    assert body["data"] == [
        _item(MID_ID, "cover letter", "application/json", 0, None, T_MID, "AI")]
    assert body["page"]["hasMore"] is True
    decoded = decode_cursor(body["page"]["nextCursor"])
    assert decoded.id == MID_ID
    assert decoded.created_at == T_MID


def test_sql_passes_the_caller_id_not_another_user():
    db = _db()
    res = _client(db).get("/api/v1/sources")
    assert res.status_code == 200
    assert db.calls
    saw_documents = False
    for sql, args in db.calls:
        assert "user_id" in sql
        assert USER_ID in args
        assert OTHER_ID not in args
        assert str(OTHER_ID) not in args
        if "documents" in sql:
            saw_documents = True
    assert saw_documents


def test_bad_kind_is_validation_error():
    db = _db()
    res = _client(db).get("/api/v1/sources", params={"kind": "NOPE"})
    assert res.status_code == 400
    assert res.json()["error"]["code"] == "VALIDATION_ERROR"
    assert res.json()["error"]["details"]["field"] == "kind"
    assert db.calls == []
