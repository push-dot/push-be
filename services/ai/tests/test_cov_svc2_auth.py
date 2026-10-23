"""AuthService.resolve_access_token: the only AuthService path still live
(ApiMiddleware bearer auth). OAuth/exchange/refresh/logout moved to core."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from uuid import uuid4

import pytest

from app.db import NotFoundError
from app.domain import entities as ent
from app.domain.errors import DomainError
from app.domain.services.auth import AuthService
from app.infrastructure.crypto import token_hash
from tests.stubs import FakeDB

DEV_TOKEN = "dev-token-not-a-secret"


class _Users:
    def __init__(self, user):
        self.user = user
        self.gets = []

    async def get(self, id_):
        self.gets.append(id_)
        if self.user is None or self.user.id != id_:
            raise NotFoundError()
        return self.user


class _Sessions:
    def __init__(self, user=None, expires_in=timedelta(minutes=5)):
        self.user = user
        self.expires_in = expires_in
        self.lookups = []

    async def get_user_by_access_token(self, hashed):
        self.lookups.append(hashed)
        if self.user is None:
            raise NotFoundError()
        return self.user, datetime.now(timezone.utc) + self.expires_in


def _user(id_=None):
    return ent.User(id=id_ or uuid4(), display_name="Dev",
                    created_at=datetime(2026, 1, 1, tzinfo=timezone.utc))


def _svc(env, dev_user, sessions, dev_token=DEV_TOKEN):
    dev_id = dev_user.id if dev_user else uuid4()
    svc = AuthService(FakeDB(), None, {}, env, dev_token, dev_id)
    svc.users = _Users(dev_user)
    svc.sessions = sessions
    return svc


async def test_dev_token_in_development_resolves_seeded_dev_user():
    dev = _user()
    sessions = _Sessions()
    svc = _svc("development", dev, sessions)
    assert (await svc.resolve_access_token(DEV_TOKEN)) is dev
    assert sessions.lookups == []


async def test_dev_token_without_seeded_user_is_unauthenticated():
    svc = _svc("development", None, _Sessions())
    with pytest.raises(DomainError) as e:
        await svc.resolve_access_token(DEV_TOKEN)
    assert e.value.code == "UNAUTHENTICATED" and e.value.status == 401


@pytest.mark.parametrize("env", ["production", "staging", "test"])
async def test_dev_token_is_ignored_outside_development(env):
    sessions = _Sessions()
    svc = _svc(env, _user(), sessions)
    with pytest.raises(DomainError) as e:
        await svc.resolve_access_token(DEV_TOKEN)
    assert e.value.code == "UNAUTHENTICATED"
    assert sessions.lookups == [token_hash(DEV_TOKEN)]
    assert svc.users.gets == []


async def test_empty_dev_token_config_never_matches():
    sessions = _Sessions()
    svc = _svc("development", _user(), sessions, dev_token="")
    with pytest.raises(DomainError):
        await svc.resolve_access_token("")
    assert sessions.lookups == [token_hash("")]


async def test_session_lookup_uses_hash_not_raw_token():
    u = _user()
    sessions = _Sessions(u)
    svc = _svc("production", None, sessions)
    assert (await svc.resolve_access_token("opaque-access")) is u
    assert sessions.lookups == [token_hash("opaque-access")]
    assert "opaque-access" not in sessions.lookups
