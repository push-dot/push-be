from __future__ import annotations

import io
import re
import struct
import zlib
from datetime import datetime, timezone
from uuid import uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pypdf import PdfReader

from app.api.errors import domain_error_handler
from app.api.routers.documents import router
from app.db import NotFoundError
from app.domain import entities as ent
from app.domain.errors import DomainError
from app.domain.services.document import DocumentService
from app.infrastructure.doc_render import render_pdf
from tests.stubs import FakeDB

USER_ID = uuid4()
NOW = datetime(2026, 10, 22, tzinfo=timezone.utc)
LINES = ["Hello extract"]
STORED = ("SIMPLE", "MODERN", "CREATIVE", "ATS")


def _text(data: bytes) -> str:
    reader = PdfReader(io.BytesIO(data))
    return "\n".join(page.extract_text() or "" for page in reader.pages)


def _stable(data: bytes) -> bytes:
    data = re.sub(br"/ID\s*\[<[^>\]]+><[^>\]]+>\]", b"/ID []", data)
    data = re.sub(br"/CreationDate\s*\([^)]*\)", b"", data)
    data = re.sub(br"/ModDate\s*\([^)]*\)", b"", data)
    return data


def _png() -> bytes:
    def chunk(tag: bytes, data: bytes) -> bytes:
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    raw = b"\x00\xff\x00\x00"
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw))
            + chunk(b"IEND", b""))


class _Approvals:
    async def consume(self, *args, **kwargs):
        return None


class _Store:
    def __init__(self, doc=None):
        self.docs = {}
        if doc is not None:
            self.docs[doc.id] = doc

    async def create(self, doc):
        self.docs[doc.id] = doc

    async def get(self, user_id, id_):
        doc = self.docs.get(id_)
        if doc is None or doc.user_id != user_id:
            raise NotFoundError()
        return doc

    async def update(self, doc, expected):
        self.docs[doc.id] = doc


def _service(store: _Store) -> DocumentService:
    svc = DocumentService(FakeDB(), _Approvals(), None)
    svc.documents = store
    return svc


def _document(template: str) -> ent.Document:
    return ent.Document(
        id=uuid4(), user_id=USER_ID, revision=1, title="resume",
        kind="RESUME", template=template, language="ko",
        created_at=NOW, updated_at=NOW)


def _version(doc: ent.Document) -> ent.DocumentVersion:
    version = ent.DocumentVersion(
        id=uuid4(), user_id=USER_ID, document_id=doc.id, number=1,
        content={"type": "doc", "content": [{
            "type": "paragraph",
            "content": [{"type": "text", "text": "Hello extract"}],
        }]},
        blocks=[], created_at=NOW)
    doc.finalized_version_id = version.id
    return version


class _AsUser:
    def __init__(self, app, user):
        self.app = app
        self.user = user

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            scope.setdefault("state", {})["user"] = self.user
        await self.app(scope, receive, send)


class _Documents:
    def __init__(self, doc, version):
        self.doc = doc
        self.version = version
        self.writes = []

    async def get(self, user_id, id_):
        if user_id != self.doc.user_id or id_ != self.doc.id:
            raise NotFoundError()
        return self.doc

    async def get_version(self, user_id, document_id, version_id):
        if (user_id != self.version.user_id or version_id != self.version.id
                or document_id != self.version.document_id):
            raise NotFoundError()
        return self.version

    async def update(self, doc, expected):
        self.writes.append(doc.template)


class _Deps:
    def __init__(self, documents, storage_dir):
        self.documents = documents
        self.storage_dir = storage_dir


class _Db:
    def __init__(self, avatar_key=None, images=None):
        self.avatar_key = avatar_key
        self.images = images or {}
        self.calls = []

    def q(self):
        return self

    async def fetchrow(self, sql, *args):
        self.calls.append((sql, args))
        return {"avatar_key": self.avatar_key}

    async def fetchval(self, sql, *args):
        self.calls.append((sql, args))
        assert "FROM upload_images" in sql
        return self.images.get(args[0])

    async def execute(self, sql, *args):
        self.calls.append((sql, args))
        return "UPDATE 1"


def _client(doc, version, db, storage_dir):
    documents = _Documents(doc, version)
    app = FastAPI()
    app.add_exception_handler(DomainError, domain_error_handler)
    app.include_router(router, prefix="/api/v1")
    app.add_middleware(_AsUser, user=ent.User(
        id=USER_ID, display_name="Ada", created_at=NOW))
    app.state.deps = _Deps(documents, storage_dir)
    app.state.db = db
    return TestClient(app), documents


def _export(client, doc, version, **params):
    return client.get(
        f"/api/v1/documents/{doc.id}/versions/{version.id}/export",
        params=params)


def _wrote(db, documents) -> bool:
    if documents.writes:
        return True
    return any(sql.lstrip().upper().startswith("UPDATE") for sql, _ in db.calls)


@pytest.mark.parametrize("name", STORED)
async def test_create_stores_the_four_names(name):
    svc = _service(_Store())
    created = await svc.create(USER_ID, None, "resume", "RESUME", name, "ko")
    loaded = await svc.get(USER_ID, created.id)
    assert created.template == name
    assert loaded.template == name


async def test_create_stores_classic_as_simple():
    svc = _service(_Store())
    created = await svc.create(
        USER_ID, None, "resume", "RESUME", "CLASSIC", "ko")
    loaded = await svc.get(USER_ID, created.id)
    assert created.template == "SIMPLE"
    assert loaded.template == "SIMPLE"


async def test_create_rejects_an_unknown_template():
    svc = _service(_Store())
    with pytest.raises(DomainError) as caught:
        await svc.create(USER_ID, None, "resume", "RESUME", "NOPE", "ko")
    assert caught.value.status == 400
    assert caught.value.details["field"] == "template"


def test_simple_and_ats_pdfs_differ_and_ats_text_extracts():
    simple = render_pdf(LINES, "SIMPLE")
    classic = render_pdf(LINES, "CLASSIC")
    ats = render_pdf(LINES, "ATS")
    compact = render_pdf(LINES, "COMPACT")
    assert simple.startswith(b"%PDF")
    assert ats.startswith(b"%PDF")
    assert _stable(simple) != _stable(ats)
    assert _stable(classic) == _stable(simple)
    assert _stable(compact) == _stable(ats)
    assert "Hello extract" in _text(ats)
    assert "ATS" in _text(ats)
    assert "SIMPLE" in _text(simple)
    assert "ATS" not in _text(simple)


def test_photo_bytes_change_the_pdf():
    pytest.importorskip("reportlab")  # photo embedding needs the local extra
    plain = render_pdf(LINES, "ATS")
    stamped = render_pdf(LINES, "ATS", _png())
    assert stamped.startswith(b"%PDF")
    assert _stable(stamped) != _stable(plain)
    assert b"/Subtype /Image" in stamped
    assert b"/Subtype /Image" not in plain
    assert "Hello extract" in _text(plain)


def test_export_template_does_not_write_the_row(tmp_path):
    doc = _document("SIMPLE")
    version = _version(doc)
    db = _Db()
    client, documents = _client(doc, version, db, str(tmp_path))
    res = _export(client, doc, version, template="ATS")
    other = _export(client, doc, version, template="SIMPLE")
    assert res.status_code == 200
    assert _stable(res.content) != _stable(other.content)
    assert "ATS" in _text(res.content)
    assert "SIMPLE" in _text(other.content)
    assert doc.template == "SIMPLE"
    assert _wrote(db, documents) is False


def test_export_accepts_aliases_without_a_write(tmp_path):
    doc = _document("MODERN")
    version = _version(doc)
    db = _Db()
    client, documents = _client(doc, version, db, str(tmp_path))
    classic = _export(client, doc, version, template="CLASSIC")
    simple = _export(client, doc, version, template="SIMPLE")
    assert classic.status_code == 200
    assert "SIMPLE" in _text(classic.content)
    assert _stable(classic.content) == _stable(simple.content)
    assert doc.template == "MODERN"
    assert _wrote(db, documents) is False


def test_export_of_stored_classic_renders_simple(tmp_path):
    doc = _document("CLASSIC")
    version = _version(doc)
    db = _Db()
    client, documents = _client(doc, version, db, str(tmp_path))
    res = _export(client, doc, version)
    assert res.status_code == 200
    assert "SIMPLE" in _text(res.content)
    assert "Hello extract" in _text(res.content)
    assert doc.template == "CLASSIC"
    assert _wrote(db, documents) is False


def test_export_rejects_an_unknown_template(tmp_path):
    doc = _document("SIMPLE")
    version = _version(doc)
    db = _Db()
    client, documents = _client(doc, version, db, str(tmp_path))
    res = _export(client, doc, version, template="NOPE")
    assert res.status_code == 400
    assert res.json()["error"]["code"] == "VALIDATION_ERROR"
    assert res.json()["error"]["details"]["field"] == "template"
    assert doc.template == "SIMPLE"
    assert _wrote(db, documents) is False


def test_export_photo_uses_the_uploaded_image_row(tmp_path):
    pytest.importorskip("reportlab")  # photo embedding needs the local extra
    doc = _document("ATS")
    version = _version(doc)
    key = "ab" * 16 + ".png"
    db = _Db(avatar_key=key, images={key: _png()})
    client, documents = _client(doc, version, db, str(tmp_path))
    plain = _export(client, doc, version)
    photo = _export(client, doc, version, photo="1")
    omitted = _export(client, doc, version, photo="0")
    assert photo.status_code == 200
    assert photo.content.startswith(b"%PDF")
    assert b"/Subtype /Image" in photo.content
    assert _stable(photo.content) != _stable(plain.content)
    assert b"/Subtype /Image" not in plain.content
    assert _stable(omitted.content) == _stable(plain.content)
    assert doc.template == "ATS"
    assert _wrote(db, documents) is False
    assert any("avatar_key" in sql for sql, _ in db.calls)


def test_export_missing_photo_still_returns_text(tmp_path):
    doc = _document("ATS")
    version = _version(doc)
    missing = _Db(avatar_key="cd" * 16 + ".png")
    client, _documents = _client(doc, version, missing, str(tmp_path))
    gone = _export(client, doc, version, photo="1")
    assert gone.status_code == 200
    assert gone.content.startswith(b"%PDF")
    assert "Hello extract" in _text(gone.content)
    empty = _Db(avatar_key=None)
    client, _documents = _client(doc, version, empty, str(tmp_path))
    no_key = _export(client, doc, version, photo="1")
    assert no_key.status_code == 200
    assert "Hello extract" in _text(no_key.content)
