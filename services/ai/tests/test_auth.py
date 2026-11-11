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
    pass


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


def _svc(sessions, user):
    svc = AuthService(FakeDB(), "development", "", uuid4())
    svc.sessions = sessions
    svc.users = StubUserStore(user)
    return svc


@pytest.mark.asyncio
async def test_resolve_access_token_is_one_lookup():
    user = _user()
    sessions = StubSessionStore()
    calls = []

    async def get_user_by_access_token(token_hash):
        calls.append(token_hash)
        return user, datetime.now(timezone.utc) + timedelta(minutes=5)

    sessions.get_user_by_access_token = get_user_by_access_token
    svc = _svc(sessions, user)
    svc.app_env = "production"
    out = await svc.resolve_access_token("secret-token")
    assert out.id == user.id
    assert len(calls) == 1


@pytest.mark.asyncio
async def test_resolve_access_token_expired_and_missing():
    user = _user()
    sessions = StubSessionStore()

    async def expired(token_hash):
        return user, datetime.now(timezone.utc) - timedelta(seconds=1)

    sessions.get_user_by_access_token = expired
    svc = _svc(sessions, user)
    svc.app_env = "production"
    with pytest.raises(DomainError) as exc:
        await svc.resolve_access_token("secret-token")
    assert exc.value.code == "TOKEN_EXPIRED"

    async def missing(token_hash):
        raise NotFoundError()

    sessions.get_user_by_access_token = missing
    with pytest.raises(DomainError) as exc:
        await svc.resolve_access_token("secret-token")
    assert exc.value.code == "UNAUTHENTICATED"
