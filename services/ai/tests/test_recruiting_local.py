from __future__ import annotations

import os
from pathlib import Path

import pytest

from app.api.gateway_secret import SharedSecretMiddleware, secrets_match
from app.infrastructure.images import image_bytes
from scripts import seed_local


def test_seed_refuses_unless_development(monkeypatch):
    monkeypatch.setenv("APP_ENV", "production")
    with pytest.raises(SystemExit, match="APP_ENV=development"):
        seed_local.assert_development()
    monkeypatch.delenv("APP_ENV", raising=False)
    with pytest.raises(SystemExit, match="APP_ENV=development"):
        seed_local.assert_development()


def test_seed_allows_development(monkeypatch):
    monkeypatch.setenv("APP_ENV", "development")
    seed_local.assert_development()


@pytest.mark.asyncio
async def test_image_bytes_reads_postgres_and_rejects_bad_keys():
    seen = []

    class Q:
        async def fetchval(self, sql, *args):
            seen.append(args)
            return b"\x89PNG"

    class Db:
        def q(self):
            return Q()

    key = "0123456789abcdef0123456789abcdef.png"
    assert await image_bytes(Db(), key) == b"\x89PNG"
    assert await image_bytes(Db(), "../etc/passwd") is None
    assert seen == [(key,)]


def test_shared_secret_constant_time_length():
    assert secrets_match("same", "same")
    assert not secrets_match("same", "other")
    assert not secrets_match("short", "longer")


@pytest.mark.asyncio
async def test_shared_secret_middleware(monkeypatch):
    monkeypatch.setenv("AI_SHARED_SECRET", "s3cret")
    called = {"ok": False}

    async def app(scope, receive, send):
        called["ok"] = True

    middleware = SharedSecretMiddleware(app)

    async def receive():
        return {"type": "http.disconnect"}

    denied = []

    async def deny_send(message):
        denied.append(message)

    await middleware(
        {"type": "http", "path": "/api/v1/jobs", "headers": [], "state": {"request_id": "r"}, "method": "GET"},
        receive, deny_send)
    assert called["ok"] is False
    assert denied[0]["status"] == 401

    async def allow_send(message):
        return None

    await middleware(
        {"type": "http", "path": "/healthz", "headers": [], "state": {}, "method": "GET"},
        receive, allow_send)
    assert called["ok"] is True

    called["ok"] = False
    await middleware(
        {"type": "http", "path": "/api/v1/jobs", "headers": [(b"x-push-ai-secret", b"s3cret")], "state": {}, "method": "GET"},
        receive, allow_send)
    assert called["ok"] is True

    monkeypatch.delenv("AI_SHARED_SECRET", raising=False)
    called["ok"] = False
    await middleware(
        {"type": "http", "path": "/api/v1/jobs", "headers": [], "state": {}, "method": "GET"},
        receive, allow_send)
    assert called["ok"] is True
