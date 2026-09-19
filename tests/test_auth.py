from __future__ import annotations

from datetime import datetime, timedelta, timezone
from uuid import uuid4

import pytest

from app.db import NotFoundError
from app.domain import entities as ent
from app.domain.errors import DomainError
from app.domain.services.auth import AuthService

from tests.stubs import FakeDB


class StubSessionStore:
    def __init__(self, rec=None):
        self.rec = rec
        self.revoked = []
        self.revoked_all = []
        self.saved_refresh = []
        self.saved_access = []

    async def get_refresh_token(self, token_hash: str):
        if self.rec is None:
            raise NotFoundError()
        return self.rec

    async def revoke_refresh_token(self, id_, at):
        if self.rec.revoked_at is not None:
            return False
        self.rec.revoked_at = at
        self.revoked.append(id_)
        return True

    async def revoke_access_tokens_for_refresh(self, refresh_id, at):
        return None

    async def revoke_all_sessions(self, user_id, at):
        self.revoked_all.append(user_id)

    async def save_refresh_token(self, t):
        self.saved_refresh.append(t)

    async def save_access_token(self, t):
        self.saved_access.append(t)


class StubUserStore:
    def __init__(self, user):
        self.user = user

    async def get(self, id_):
        if self.user is None or self.user.id != id_:
            raise NotFoundError()
        return self.user


def _user():
    return ent.User(id=uuid4(), provider="google", provider_subject="s",
                    display_name="U", locale="ko", created_at=datetime.now(timezone.utc))


def _refresh_rec(user_id, revoked=False):
    return ent.RefreshToken(
        id=uuid4(), user_id=user_id, token_hash="h",
        expires_at=datetime.now(timezone.utc) + timedelta(days=30),
        revoked_at=datetime.now(timezone.utc) if revoked else None,
        created_at=datetime.now(timezone.utc))


def _svc(sessions, user):
    svc = AuthService(FakeDB(), None, {}, "development", "", uuid4())
    svc.sessions = sessions
    svc.users = StubUserStore(user)
    return svc


@pytest.mark.asyncio
async def test_refresh_rotates_and_issues_new_session():
    user = _user()
    rec = _refresh_rec(user.id)
    sessions = StubSessionStore(rec)
    sess = await _svc(sessions, user).refresh("rt")
    assert sess.access_token and sess.refresh_token
    assert sessions.revoked == [rec.id]
    assert len(sessions.saved_refresh) == 1
    assert len(sessions.saved_access) == 1


@pytest.mark.asyncio
async def test_refresh_reuse_kills_all_sessions():
    user = _user()
    rec = _refresh_rec(user.id, revoked=True)
    sessions = StubSessionStore(rec)
    with pytest.raises(DomainError) as exc:
        await _svc(sessions, user).refresh("rt")
    assert exc.value.status == 401
    assert sessions.revoked_all == [user.id]


@pytest.mark.asyncio
async def test_refresh_unknown_token():
    sessions = StubSessionStore(None)
    with pytest.raises(DomainError) as exc:
        await _svc(sessions, _user()).refresh("rt")
    assert exc.value.status == 401
    assert sessions.revoked_all == []
