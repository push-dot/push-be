from __future__ import annotations

from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.errors import domain_error_handler
from app.api.routers import ai
from app.domain.errors import DomainError
from app.main import app as main_app


def _client():
    app = FastAPI()
    app.add_exception_handler(DomainError, domain_error_handler)
    app.include_router(ai.router, prefix="/api/v1")
    app.state.deps = SimpleNamespace(cfg=SimpleNamespace(managed_ai=True, managed_go=False))
    return TestClient(app)


def test_python_exposes_no_ai_key_routes():
    paths = {getattr(route, "path", "") for route in main_app.routes}
    assert not any(path.startswith("/api/v1/ai/keys") for path in paths)
    assert _client().get("/api/v1/ai/keys").status_code == 404


def test_models_are_available_only_through_managed():
    r = _client().get("/api/v1/ai/models")
    assert r.status_code == 200
    rows = {m["model"]: m["available"] for m in r.json()["data"]}
    assert rows["deepseek/deepseek-v4.1-flash"] is True
    assert rows["opencode-go/deepseek-v4.1-flash"] is False
