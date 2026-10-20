from __future__ import annotations

import os
from pathlib import Path

import pytest

from app.api.gateway_secret import SharedSecretMiddleware, secrets_match
from app.domain.errors import DomainError
from app.infrastructure.images import save_image
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


def test_save_image_writes_under_images(tmp_path: Path):
    png = b"\x89PNG\r\n\x1a\n" + b"rest"
    key, url = save_image(str(tmp_path), png, "image/png")
    path = tmp_path / "images" / key
    assert path.is_file()
    assert path.read_bytes() == png
    assert url == "/api/v1/uploads/images/" + key
    source = Path(__file__).resolve().parents[1].joinpath("src/app/infrastructure/images.py").read_text()
    assert "shortcut: local disk, swap to R2 at deploy" in source


def test_save_image_rejects_other_types(tmp_path: Path):
    with pytest.raises(DomainError) as caught:
        save_image(str(tmp_path), b"not an image", "text/plain")
    assert caught.value.status == 400


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
