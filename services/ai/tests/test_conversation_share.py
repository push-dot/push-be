from __future__ import annotations

import hashlib
import re
from datetime import datetime, timezone
from uuid import UUID

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.errors import domain_error_handler
from app.api.middleware import _is_public
from app.api.routers.conversations import router
from app.domain import entities as ent
from app.domain.errors import DomainError

USER_ID = UUID("00000000-0000-4000-8000-0000000000aa")
OTHER_ID = UUID("00000000-0000-4000-8000-0000000000ff")
MEMBER_ID = UUID("00000000-0000-4000-8000-0000000000bb")
CONV_ID = UUID("00000000-0000-4000-8000-0000000000c1")
COMPANY_ID = UUID("00000000-0000-4000-8000-0000000000c0")
DOC_ATT = UUID("00000000-0000-4000-8000-0000000000d1")
DOC_ID = UUID("00000000-0000-4000-8000-0000000000d2")
EV_ID = UUID("00000000-0000-4000-8000-0000000000e1")
EV_DOC_ATT = UUID("00000000-0000-4000-8000-0000000000e3")
EV_DOC = UUID("00000000-0000-4000-8000-0000000000e2")
MSG_LATE = UUID("00000000-0000-4000-8000-000000000003")
MSG_EARLY = UUID("00000000-0000-4000-8000-000000000001")
MSG_MID_HI = UUID("00000000-0000-4000-8000-000000000012")
MSG_MID_LO = UUID("00000000-0000-4000-8000-000000000011")
T0 = datetime(2026, 1, 1, tzinfo=timezone.utc)
T_EARLY = datetime(2026, 1, 2, tzinfo=timezone.utc)
T_MID = datetime(2026, 1, 3, tzinfo=timezone.utc)
T_LATE = datetime(2026, 1, 4, tzinfo=timezone.utc)


def _iso(value: datetime) -> str:
    return value.strftime("%Y-%m-%dT%H:%M:%SZ")


def _user(user_id: UUID) -> ent.User:
    return ent.User(
        id=user_id, display_name="Ada", created_at=T0)


class _AsUser:
    def __init__(self, app, user):
        self.app = app
        self.user = user

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            scope.setdefault("state", {})["user"] = self.user
        await self.app(scope, receive, send)


class _Mem:
    def __init__(self):
        self.conversations = {}
        self.members = {}
        self.shares = {}
        self.messages = []
        self.calls = []

    def q(self):
        return self

    async def fetchrow(self, sql, *args):
        self.calls.append((sql, args))
        text = " ".join(sql.lower().split())
        if "conversation_shares" in text:
            return self._share_row(args[0])
        if "from conversations" in text:
            return self._conversation(text, args)
        return None

    async def fetch(self, sql, *args):
        self.calls.append((sql, args))
        text = " ".join(sql.lower().split())
        if "messages" not in text:
            return []
        rows = [dict(m) for m in self.messages if m["conversation_id"] == args[0]]
        if "order by created_at" in text and "id" in text:
            rows.sort(key=lambda m: (m["created_at"], m["id"]))
        return rows

    async def execute(self, sql, *args):
        self.calls.append((sql, args))
        text = " ".join(sql.lower().split())
        if "conversation_shares" in text:
            self.shares[args[0]] = args[1]
        return "INSERT 1"

    def _conversation(self, text, args):
        conv = self.conversations.get(args[0])
        if conv is None or len(args) < 2:
            return None
        user_id = args[1]
        if conv["user_id"] == user_id:
            return dict(conv)
        if "company_members" not in text:
            return None
        company_id = conv.get("company_id")
        if company_id is not None and self.members.get(user_id) == company_id:
            return dict(conv)
        return None

    def _share_row(self, token_hash):
        for conversation_id, stored in self.shares.items():
            if stored == token_hash:
                conv = self.conversations[conversation_id]
                return {
                    "conversation_id": conversation_id,
                    "title": conv["title"],
                    "token_hash": stored,
                }
        return None


def _message(id_, created_at, role, text, attachments=None):
    return {
        "id": id_,
        "conversation_id": CONV_ID,
        "role": role,
        "text": text,
        "attachments": attachments if attachments is not None else [],
        "created_at": created_at,
    }


def _db(messages=None, company_id=None, members=None) -> _Mem:
    db = _Mem()
    db.conversations[CONV_ID] = {
        "id": CONV_ID,
        "user_id": USER_ID,
        "revision": 1,
        "application_id": None,
        "title": "Interview prep",
        "pinned": False,
        "archived": False,
        "created_at": T0,
        "updated_at": T0,
        "company_id": company_id,
    }
    db.messages = list(messages or [])
    db.members = dict(members or {})
    return db


def _client(db: _Mem, user_id: UUID | None) -> TestClient:
    app = FastAPI()
    app.add_exception_handler(DomainError, domain_error_handler)
    app.include_router(router, prefix="/api/v1")
    if user_id is not None:
        app.add_middleware(_AsUser, user=_user(user_id))
    app.state.db = db
    return TestClient(app)


def _share(client: TestClient):
    return client.post(f"/api/v1/conversations/{CONV_ID}/share")


def _ordered_messages():
    return [
        _message(MSG_LATE, T_LATE, "ASSISTANT", "later"),
        _message(MSG_MID_HI, T_MID, "USER", "mid-hi"),
        _message(MSG_EARLY, T_EARLY, "USER", "early"),
        _message(MSG_MID_LO, T_MID, "ASSISTANT", "mid-lo"),
    ]


def test_shared_get_is_public_and_share_post_is_not():
    token_path = "/api/v1/conversations/shared/abc"
    assert _is_public(token_path, "GET")
    assert not _is_public(token_path, "POST")
    assert not _is_public("/api/v1/conversations/shared", "GET")
    assert not _is_public("/api/v1/conversations/shared/abc/extra", "GET")
    assert not _is_public(f"/api/v1/conversations/{CONV_ID}/share", "POST")
    assert not _is_public(f"/api/v1/conversations/{CONV_ID}/artifacts", "GET")
    assert _is_public("/api/v1/healthz", "GET")
    assert _is_public("/api/v1/uploads/images/a.png", "GET")


def test_create_returns_token_and_path():
    res = _share(_client(_db(), USER_ID))
    assert res.status_code == 200
    body = res.json()["data"]
    token = body["token"]
    assert re.fullmatch(r"[A-Za-z0-9_-]+", token)
    assert body["path"] == f"/api/v1/conversations/shared/{token}"
    assert set(body) == {"token", "path"}


def test_stored_value_is_sha256_hex_not_the_raw_token():
    db = _db()
    res = _share(_client(db, USER_ID))
    assert res.status_code == 200
    token = res.json()["data"]["token"]
    digest = hashlib.sha256(token.encode()).hexdigest()
    assert db.shares[CONV_ID] == digest
    assert digest != token
    stored = [arg for _, args in db.calls for arg in args]
    assert token not in stored
    assert any("company_members" in sql for sql, _ in db.calls)


def test_second_post_rotates_and_first_token_is_404():
    db = _db(_ordered_messages())
    owner = _client(db, USER_ID)
    public = _client(db, None)
    first = _share(owner)
    second = _share(owner)
    assert first.status_code == 200
    assert second.status_code == 200
    first_token = first.json()["data"]["token"]
    second_token = second.json()["data"]["token"]
    assert first_token != second_token
    assert db.shares[CONV_ID] == hashlib.sha256(second_token.encode()).hexdigest()
    gone = public.get(f"/api/v1/conversations/shared/{first_token}")
    assert gone.status_code == 404
    assert gone.json()["error"]["code"] == "NOT_FOUND"
    live = public.get(f"/api/v1/conversations/shared/{second_token}")
    assert live.status_code == 200


def test_public_get_returns_title_and_messages_without_user_id():
    db = _db(_ordered_messages())
    created = _share(_client(db, USER_ID))
    token = created.json()["data"]["token"]
    res = _client(db, None).get(f"/api/v1/conversations/shared/{token}")
    assert res.status_code == 200
    body = res.json()["data"]
    assert set(body) == {"title", "messages"}
    assert body["title"] == "Interview prep"
    assert body["messages"] == [
        {"role": "USER", "text": "early", "createdAt": _iso(T_EARLY)},
        {"role": "ASSISTANT", "text": "mid-lo", "createdAt": _iso(T_MID)},
        {"role": "USER", "text": "mid-hi", "createdAt": _iso(T_MID)},
        {"role": "ASSISTANT", "text": "later", "createdAt": _iso(T_LATE)},
    ]
    raw = res.text
    assert str(USER_ID) not in raw
    assert str(CONV_ID) not in raw
    assert db.shares[CONV_ID] not in raw


def test_wrong_token_is_404():
    db = _db()
    created = _share(_client(db, USER_ID))
    token = created.json()["data"]["token"]
    res = _client(db, None).get(
        f"/api/v1/conversations/shared/{token}nope")
    assert res.status_code == 404
    assert res.json()["error"]["code"] == "NOT_FOUND"


def test_artifacts_returns_document_attachment_and_skips_bare_evidence():
    attachments = [
        {"type": "DOCUMENT_VERSION", "id": str(DOC_ATT),
         "documentId": str(DOC_ID), "title": "Resume"},
        {"type": "EVIDENCE", "id": str(EV_ID), "title": "Notes"},
        {"type": "EVIDENCE", "id": str(EV_DOC_ATT), "documentId": str(EV_DOC)},
    ]
    db = _db([_message(MSG_EARLY, T_EARLY, "USER", "docs", attachments)])
    res = _client(db, USER_ID).get(
        f"/api/v1/conversations/{CONV_ID}/artifacts")
    assert res.status_code == 200
    assert res.json()["data"] == [
        {"type": "DOCUMENT_VERSION", "id": str(DOC_ATT), "title": "Resume"},
        {"type": "EVIDENCE", "id": str(EV_DOC_ATT), "title": ""},
    ]
    assert str(EV_ID) not in res.text


def test_empty_attachments_is_empty_data():
    db = _db([_message(MSG_EARLY, T_EARLY, "USER", "hi", [])])
    res = _client(db, USER_ID).get(
        f"/api/v1/conversations/{CONV_ID}/artifacts")
    assert res.status_code == 200
    assert res.json() == {"data": []}


def test_other_user_is_404():
    attachments = [
        {"type": "DOCUMENT_VERSION", "id": str(DOC_ATT),
         "documentId": str(DOC_ID), "title": "Resume"},
    ]
    db = _db([_message(MSG_EARLY, T_EARLY, "USER", "docs", attachments)])
    other = _client(db, OTHER_ID)
    share = _share(other)
    artifacts = other.get(f"/api/v1/conversations/{CONV_ID}/artifacts")
    assert share.status_code == 404
    assert share.json()["error"]["code"] == "NOT_FOUND"
    assert artifacts.status_code == 404
    assert artifacts.json()["error"]["code"] == "NOT_FOUND"
    assert db.shares == {}
    assert str(DOC_ATT) not in artifacts.text


def test_company_member_can_share():
    db = _db(company_id=COMPANY_ID, members={MEMBER_ID: COMPANY_ID})
    res = _share(_client(db, MEMBER_ID))
    assert res.status_code == 200
    assert CONV_ID in db.shares
