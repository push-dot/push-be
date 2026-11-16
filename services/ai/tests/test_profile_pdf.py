from __future__ import annotations

import io
import struct
import zlib
from datetime import datetime, timezone
from uuid import uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pypdf import PdfReader

from app.api.errors import domain_error_handler
from app.api.routers.me import router
from app.domain import entities as ent
from app.domain.errors import DomainError
from app.infrastructure.doc_render import profile_lines

USER_ID = uuid4()
NOW = datetime(2026, 11, 16, tzinfo=timezone.utc)
ROW = {
    "display_name": "Ada Kim",
    "headline": "Payments backend engineer",
    "job_category": "dev",
    "tenure_years": 4,
    "career_status": "seeking",
    "intro": "I build payment systems.",
    "careers": [
        {"company": "Moapay", "role": "Backend Engineer",
         "startedOn": "2022-03-01", "endedOn": None,
         "description": "Owns the approval API."},
        {"company": "Haru Labs", "role": "Server Developer",
         "startedOn": "2021-01-01", "endedOn": "2022-02-28",
         "description": ""},
    ],
    "skills": ["Kotlin", "Spring Boot"],
    "avatar_key": None,
}


def _text(data: bytes) -> str:
    reader = PdfReader(io.BytesIO(data))
    return "\n".join(page.extract_text() or "" for page in reader.pages)


def _png() -> bytes:
    def chunk(tag: bytes, data: bytes) -> bytes:
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(b"\x00\xff\x00\x00"))
            + chunk(b"IEND", b""))


class _AsUser:
    def __init__(self, app, user):
        self.app = app
        self.user = user

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            scope.setdefault("state", {})["user"] = self.user
        await self.app(scope, receive, send)


class _Db:
    def __init__(self, rows, images=None):
        self.rows = rows
        self.images = images or {}
        self.profile_args = []

    def q(self):
        return self

    async def fetchrow(self, sql, *args):
        assert "FROM users" in sql
        self.profile_args.append(args)
        return self.rows.get(args[0])

    async def fetchval(self, sql, *args):
        assert "FROM upload_images" in sql
        return self.images.get(args[0])


def _client(db, user_id=USER_ID):
    app = FastAPI()
    app.add_exception_handler(DomainError, domain_error_handler)
    app.include_router(router, prefix="/api/v1")
    app.add_middleware(_AsUser, user=ent.User(
        id=user_id, display_name="Ada", created_at=NOW))
    app.state.db = db
    return TestClient(app)


def test_profile_lines_follow_the_profile_screen():
    lines = profile_lines(ROW)
    assert lines[:3] == [
        "# Ada Kim", "Payments backend engineer", "개발 · 4년차 · 이직/구직중"]
    assert "## 소개" in lines and "I build payment systems." in lines
    assert "## 경력" in lines
    assert "Moapay · Backend Engineer" in lines
    assert "2022년 3월 – 현재" in lines
    assert "Haru Labs · Server Developer" in lines
    assert "2021년 1월 – 2022년 2월" in lines
    assert "Owns the approval API." in lines
    assert "## 기술 스택" in lines and "Kotlin, Spring Boot" in lines


def test_profile_lines_skip_empty_sections():
    lines = profile_lines({"display_name": "Ada Kim", "headline": "",
                           "job_category": None, "tenure_years": None,
                           "career_status": None, "intro": "",
                           "careers": [], "skills": []})
    assert lines == ["# Ada Kim"]


def test_export_returns_the_callers_profile_as_a_pdf():
    db = _Db({USER_ID: ROW})
    res = _client(db).get("/api/v1/me/profile/pdf")
    assert res.status_code == 200
    assert res.headers["content-type"] == "application/pdf"
    assert res.headers["content-disposition"].startswith("attachment;")
    assert res.content.startswith(b"%PDF")
    text = _text(res.content)
    assert "Ada Kim" in text
    assert "Payments backend engineer" in text
    assert "Moapay" in text
    assert db.profile_args == [(USER_ID,)]


def test_export_never_reads_another_users_profile():
    other = uuid4()
    db = _Db({other: {**ROW, "display_name": "Bob Lee"}})
    res = _client(db).get("/api/v1/me/profile/pdf")
    assert res.status_code == 404
    assert res.json()["error"]["code"] == "NOT_FOUND"
    assert db.profile_args == [(USER_ID,)]


def test_export_works_for_a_user_without_a_profile_row():
    bare = {"display_name": "Ada Kim", "headline": None, "job_category": None,
            "tenure_years": None, "career_status": None, "intro": None,
            "careers": None, "skills": None, "avatar_key": None}
    res = _client(_Db({USER_ID: bare})).get("/api/v1/me/profile/pdf")
    assert res.status_code == 200
    assert "Ada Kim" in _text(res.content)


def test_photo_1_embeds_the_avatar_and_otherwise_it_is_left_out():
    pytest.importorskip("reportlab")  # photo embedding needs the local extra
    key = "ab" * 16 + ".png"
    db = _Db({USER_ID: {**ROW, "avatar_key": key}}, {key: _png()})
    client = _client(db)
    plain = client.get("/api/v1/me/profile/pdf")
    stamped = client.get("/api/v1/me/profile/pdf", params={"photo": "1"})
    assert b"/Subtype /Image" not in plain.content
    assert b"/Subtype /Image" in stamped.content


def test_photo_1_without_an_avatar_still_returns_the_pdf():
    res = _client(_Db({USER_ID: ROW})).get(
        "/api/v1/me/profile/pdf", params={"photo": "1"})
    assert res.status_code == 200
    assert b"/Subtype /Image" not in res.content
