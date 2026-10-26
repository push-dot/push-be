"""HTTP contract of the live Python project/application routes."""
from __future__ import annotations

from datetime import datetime, timezone
from types import SimpleNamespace
from uuid import UUID, uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.errors import domain_error_handler
from app.api.routers import applications, projects
from app.domain import entities as ent
from app.domain.errors import DomainError, not_found

USER = ent.User(id=UUID("00000000-0000-4000-8000-0000000000aa"),
                display_name="Ada",
                created_at=datetime(2026, 1, 1, tzinfo=timezone.utc))
AI = {"provider": "OPENAI", "model": "m", "effort": "LOW"}


class _AsUser:
    def __init__(self, app, user):
        self.app, self.user = app, user

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http" and self.user is not None:
            scope.setdefault("state", {})["user"] = self.user
        await self.app(scope, receive, send)


class _Recorder:
    def __init__(self, err=None):
        self.calls = []
        self.err = err

    def __getattr__(self, name):
        async def call(*args):
            self.calls.append((name, args))
            if self.err is not None:
                raise self.err
            return {"id": "op-1", "status": "SUCCEEDED"}
        return call


def _client(user=USER, err=None):
    app = FastAPI()
    app.add_exception_handler(DomainError, domain_error_handler)
    app.include_router(projects.router, prefix="/api/v1")
    app.include_router(applications.router, prefix="/api/v1")
    rec = _Recorder(err)
    app.state.deps = SimpleNamespace(projects=rec, resume_workflow=rec)
    return TestClient(_AsUser(app, user)), rec


def test_generate_blueprints_passes_user_and_ids():
    c, rec = _client()
    aid, gid = uuid4(), uuid4()
    r = c.post("/api/v1/projects/blueprints",
               json={"applicationId": str(aid), "gapAnalysisId": str(gid),
                     "ai": AI})
    assert r.status_code == 202
    assert r.json() == {"data": {"id": "op-1", "status": "SUCCEEDED"}}
    name, (uid, a, g, ai) = rec.calls[0]
    assert name == "generate_blueprints"
    assert (uid, a, g) == (USER.id, aid, gid)
    assert isinstance(ai, ent.AiOptions)
    assert (ai.provider, ai.model, ai.effort) == ("OPENAI", "m", "LOW")


def test_generate_blueprints_without_ai_passes_none():
    c, rec = _client()
    r = c.post("/api/v1/projects/blueprints",
               json={"applicationId": str(uuid4()),
                     "gapAnalysisId": str(uuid4())})
    assert r.status_code == 202
    assert rec.calls[0][1][3] is None


@pytest.mark.parametrize("body", [
    b"", b"{not json", b'{"applicationId": "x", "gapAnalysisId": "y"}',
    b'{"applicationId": "00000000-0000-4000-8000-000000000001"}',
    b'{"applicationId": "00000000-0000-4000-8000-000000000001",'
    b' "gapAnalysisId": "00000000-0000-4000-8000-000000000002", "extra": 1}',
])
def test_generate_blueprints_rejects_bad_bodies(body):
    c, rec = _client()
    r = c.post("/api/v1/projects/blueprints", content=body,
               headers={"content-type": "application/json"})
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "VALIDATION_ERROR"
    assert rec.calls == []


def test_verify_evidence_routes_ids_and_revision():
    c, rec = _client()
    pid, eid = uuid4(), uuid4()
    r = c.post(f"/api/v1/projects/{pid}/evidence/{eid}/verify",
               json={"expectedRevision": 3})
    assert r.status_code == 202
    assert rec.calls == [("verify_evidence", (USER.id, pid, eid, 3))]


@pytest.mark.parametrize("path,field", [
    ("/api/v1/projects/nope/evidence/{e}/verify", "id"),
    ("/api/v1/projects/{p}/evidence/nope/verify", "evidenceId"),
])
def test_verify_evidence_rejects_non_uuid_path(path, field):
    c, rec = _client()
    r = c.post(path.format(p=uuid4(), e=uuid4()), json={"expectedRevision": 1})
    assert r.status_code == 400
    assert r.json()["error"]["details"] == {"field": field}
    assert rec.calls == []


def test_verify_evidence_requires_integer_revision():
    c, rec = _client()
    r = c.post(f"/api/v1/projects/{uuid4()}/evidence/{uuid4()}/verify",
               json={"expectedRevision": "3"})
    assert r.status_code == 400
    assert rec.calls == []


def test_domain_errors_from_service_keep_status_and_code():
    c, _ = _client(err=not_found())
    r = c.post(f"/api/v1/projects/{uuid4()}/evidence/{uuid4()}/verify",
               json={"expectedRevision": 1})
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "NOT_FOUND"


def test_resume_run_passes_application_and_ai():
    c, rec = _client()
    aid = uuid4()
    r = c.post(f"/api/v1/applications/{aid}/resume-run", json={"ai": AI})
    assert r.status_code == 202
    name, (uid, a, ai) = rec.calls[0]
    assert (name, uid, a) == ("run", USER.id, aid)
    assert ai.model == "m"


def test_resume_run_accepts_empty_object_and_rejects_bad_id():
    c, rec = _client()
    assert c.post(f"/api/v1/applications/{uuid4()}/resume-run",
                  json={}).status_code == 202
    assert rec.calls[0][1][2] is None
    r = c.post("/api/v1/applications/xyz/resume-run", json={})
    assert r.status_code == 400
    assert len(rec.calls) == 1


@pytest.mark.parametrize("method,path,body", [
    ("post", "/api/v1/projects/blueprints",
     {"applicationId": str(uuid4()), "gapAnalysisId": str(uuid4())}),
    ("post", f"/api/v1/projects/{uuid4()}/evidence/{uuid4()}/verify",
     {"expectedRevision": 1}),
    ("post", f"/api/v1/applications/{uuid4()}/resume-run", {}),
])
def test_routes_require_an_authenticated_user(method, path, body):
    c, rec = _client(user=None)
    r = getattr(c, method)(path, json=body)
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "UNAUTHENTICATED"
    assert rec.calls == []
