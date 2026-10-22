from __future__ import annotations

from datetime import datetime, timezone
from types import SimpleNamespace
from uuid import UUID

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.errors import domain_error_handler
from app.api.routers.evidence import router
from app.db import NotFoundError
from app.domain import entities as ent
from app.domain.errors import DomainError
from app.domain.profile_draft import parse_profile_draft
from app.domain.services.evidence import EvidenceService

USER_ID = UUID("00000000-0000-4000-8000-0000000000aa")
OTHER_ID = UUID("00000000-0000-4000-8000-0000000000ff")
SOURCE_ID = UUID("00000000-0000-4000-8000-0000000000c1")
NOW = datetime(2026, 3, 3, tzinfo=timezone.utc)

FIXTURE = (
    "이름: 김서준\n"
    "한 줄: 백엔드\n"
    "연차: 5\n"
    "소개: 서버를 만듭니다\n"
    "경력:\n"
    "푸시 | 백엔드 | 2020-01 | 2024-03\n"
    "기술: Kotlin, Spring\n"
)

DRAFT = {
    "displayName": "김서준",
    "headline": "백엔드",
    "tenureYears": 5,
    "intro": "서버를 만듭니다",
    "careers": [{
        "company": "푸시",
        "title": "백엔드",
        "start": "2020-01",
        "end": "2024-03",
    }],
    "skills": ["Kotlin", "Spring"],
}

BLANK = {
    "displayName": "",
    "headline": "",
    "tenureYears": None,
    "intro": "",
    "careers": [],
    "skills": [],
}


def test_labeled_fixture_fills_the_draft():
    assert parse_profile_draft(FIXTURE) == DRAFT


def test_empty_text_returns_blank_fields():
    assert parse_profile_draft("") == BLANK


def test_tenure_year_suffix_is_an_integer():
    draft = parse_profile_draft("연차: 5년")
    assert draft["tenureYears"] == 5
    assert draft["displayName"] == ""
    assert draft["careers"] == []
    assert draft["skills"] == []


def test_missing_or_non_numeric_tenure_is_null():
    assert parse_profile_draft("이름: 김서준")["tenureYears"] is None
    assert parse_profile_draft("연차: 많음")["tenureYears"] is None


def test_career_on_the_label_line():
    draft = parse_profile_draft("경력: 푸시 | 백엔드 | 2020-01 | 2024-03")
    assert draft["careers"] == DRAFT["careers"]


def test_skills_drop_blank_items():
    assert parse_profile_draft("기술: Kotlin, , Spring,")["skills"] == [
        "Kotlin", "Spring"]


class _AsUser:
    def __init__(self, app, user):
        self.app = app
        self.user = user

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            scope.setdefault("state", {})["user"] = self.user
        await self.app(scope, receive, send)


class _Sources:
    def __init__(self, rows):
        self.rows = rows

    async def get(self, user_id, id_):
        row = self.rows.get((user_id, id_))
        if row is None:
            raise NotFoundError()
        return row[0]

    async def content(self, user_id, id_):
        row = self.rows.get((user_id, id_))
        if row is None:
            raise NotFoundError()
        return row[1]


def _source(user_id, body: bytes) -> ent.Source:
    return ent.Source(
        id=SOURCE_ID, user_id=user_id, file_name="profile.txt",
        mime_type="text/plain", size=len(body), sha256="abc",
        path=f"db://sources/{SOURCE_ID}", status="STORED", created_at=NOW)


def _client(rows) -> TestClient:
    sources = _Sources(rows)
    evidence = EvidenceService.__new__(EvidenceService)
    evidence.sources = sources
    app = FastAPI()
    app.add_exception_handler(DomainError, domain_error_handler)
    app.include_router(router, prefix="/api/v1")
    app.add_middleware(_AsUser, user=ent.User(
        id=USER_ID, display_name="Ada", created_at=NOW))
    app.state.deps = SimpleNamespace(sources=sources, evidence=evidence)
    return TestClient(app)


def test_profile_draft_route_returns_the_parsed_source():
    body = FIXTURE.encode()
    res = _client({(USER_ID, SOURCE_ID): (_source(USER_ID, body), body)}).get(
        f"/api/v1/sources/{SOURCE_ID}/profile-draft")
    assert res.status_code == 200
    assert res.json() == {"data": DRAFT}


def test_other_users_source_is_404():
    body = FIXTURE.encode()
    res = _client({(OTHER_ID, SOURCE_ID): (_source(OTHER_ID, body), body)}).get(
        f"/api/v1/sources/{SOURCE_ID}/profile-draft")
    assert res.status_code == 404
    assert res.json()["error"]["code"] == "NOT_FOUND"
