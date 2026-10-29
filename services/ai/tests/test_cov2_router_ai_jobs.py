"""HTTP contract of the Python-owned /ai/models, /ai/generate and
/jobs/{id}/analyze routes."""
from __future__ import annotations

from types import SimpleNamespace
from uuid import uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.errors import domain_error_handler
from app.api.routers import ai, jobs
from app.domain import entities as ent
from app.domain.errors import DomainError, feature_disabled
from tests.test_cov_svc2_routers import AI, USER, _AsUser, _Recorder


def _client(user=USER, err=None, managed_ai=True, managed_go=False):
    app = FastAPI()
    app.add_exception_handler(DomainError, domain_error_handler)
    app.include_router(ai.router, prefix="/api/v1")
    app.include_router(jobs.router, prefix="/api/v1")
    rec = _Recorder(err)
    app.state.deps = SimpleNamespace(
        ai=rec, jobs=rec,
        cfg=SimpleNamespace(managed_ai=managed_ai, managed_go=managed_go))
    return TestClient(_AsUser(app, user)), rec


# ---- GET /ai/models --------------------------------------------------------

def _avail(r):
    return {m["model"]: m["available"] for m in r.json()["data"]}


def test_models_lists_every_managed_model_with_availability():
    c, _ = _client(managed_ai=True, managed_go=False)
    r = c.get("/api/v1/ai/models")
    assert r.status_code == 200
    data = r.json()["data"]
    assert [m["model"] for m in data] == [m.model for m in ent.OPENAI_MODELS]
    assert all(m["provider"] == "OPENAI" and
               m["supportedEfforts"] == ["LOW", "MEDIUM", "HIGH"] for m in data)
    avail = _avail(r)
    assert avail["opencode-go/deepseek-v4.1-flash"] is False
    assert avail["openai/gpt-5.6-sol"] is True


def test_models_go_availability_follows_its_own_key():
    c, _ = _client(managed_ai=False, managed_go=True)
    avail = _avail(c.get("/api/v1/ai/models"))
    assert avail["opencode-go/deepseek-v4.1-flash"] is True
    assert avail["deepseek/deepseek-v4.1-flash"] is False


def test_models_filtered_by_another_provider_is_empty():
    c, _ = _client()
    r = c.get("/api/v1/ai/models?provider=CLAUDE")
    assert r.status_code == 200 and r.json()["data"] == []


def test_models_rejects_unknown_provider_filter():
    c, _ = _client()
    r = c.get("/api/v1/ai/models?provider=NOPE")
    assert r.status_code == 400
    assert r.json()["error"]["details"] == {"field": "provider"}


# ---- POST /ai/generate -----------------------------------------------------

def test_generate_passes_user_prompt_and_options():
    c, rec = _client()
    aid, eid = uuid4(), uuid4()
    r = c.post("/api/v1/ai/generate",
               json={"ai": AI, "prompt": "write", "applicationId": str(aid),
                     "evidenceIds": [str(eid)]})
    assert r.status_code == 202
    assert r.json() == {"data": {"id": "op-1", "status": "SUCCEEDED"}}
    name, (uid, opts, prompt, a, ids) = rec.calls[0]
    assert (name, uid, prompt, a, ids) == ("generate", USER.id, "write", aid,
                                           [eid])
    assert isinstance(opts, ent.AiOptions)
    assert (opts.provider, opts.model, opts.effort) == ("OPENAI", "m", "LOW")


@pytest.mark.parametrize("body", [
    {"ai": AI, "applicationId": str(uuid4())},
    {"ai": AI, "prompt": "p", "applicationId": "nope"},
    {"ai": AI, "prompt": "p", "applicationId": str(uuid4()), "extra": 1},
])
def test_generate_rejects_bad_bodies(body):
    c, rec = _client()
    r = c.post("/api/v1/ai/generate", json=body)
    assert r.status_code == 400 and rec.calls == []


def test_generate_surfaces_plan_gate_errors():
    c, _ = _client(err=feature_disabled("limit"))
    r = c.post("/api/v1/ai/generate",
               json={"prompt": "p", "applicationId": str(uuid4())})
    assert r.status_code == 403
    assert r.json()["error"]["code"] == "FEATURE_DISABLED"


# ---- POST /jobs/{id}/analyze ----------------------------------------------

def test_analyze_routes_ids_revision_and_options():
    c, rec = _client()
    jid, aid, eid = uuid4(), uuid4(), uuid4()
    r = c.post(f"/api/v1/jobs/{jid}/analyze",
               json={"applicationId": str(aid), "expectedRevision": 2,
                     "evidenceIds": [str(eid)], "ai": AI})
    assert r.status_code == 202
    name, (uid, j, a, rev, ids, opts) = rec.calls[0]
    assert (name, uid, j, a, rev, ids) == ("analyze", USER.id, jid, aid, 2,
                                           [eid])
    assert opts.model == "m"


def test_analyze_defaults_to_rule_based_without_evidence():
    c, rec = _client()
    r = c.post(f"/api/v1/jobs/{uuid4()}/analyze",
               json={"applicationId": str(uuid4()), "expectedRevision": 1})
    assert r.status_code == 202
    assert rec.calls[0][1][4:] == ([], None)


@pytest.mark.parametrize("path,body", [
    ("/api/v1/jobs/nope/analyze",
     {"applicationId": str(uuid4()), "expectedRevision": 1}),
    (f"/api/v1/jobs/{uuid4()}/analyze", {"applicationId": str(uuid4())}),
])
def test_analyze_rejects_bad_path_or_body(path, body):
    c, rec = _client()
    assert c.post(path, json=body).status_code == 400
    assert rec.calls == []


@pytest.mark.parametrize("path,body", [
    ("/api/v1/ai/generate", {"prompt": "p", "applicationId": str(uuid4())}),
    (f"/api/v1/jobs/{uuid4()}/analyze",
     {"applicationId": str(uuid4()), "expectedRevision": 1}),
])
def test_writes_require_an_authenticated_user(path, body):
    c, rec = _client(user=None)
    r = c.post(path, json=body)
    assert r.status_code == 401 and rec.calls == []
