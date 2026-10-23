"""InterviewService.prepare is the only live entry point (POST
/interviews/{id}/prepare and the personal harness tool); list/create/patch
moved to core."""
from __future__ import annotations

from types import SimpleNamespace
from uuid import uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.errors import domain_error_handler
from app.api.routers.interviews import router
from app.domain import entities as ent
from app.domain.errors import DomainError, feature_disabled
from app.domain.services.interview import InterviewService
from tests import test_cov_svc_fakes as f
from tests.test_cov_svc_approval import _AsUser

A, B = uuid4(), uuid4()


def _world(user_id=A, sources=(), requirements=("Go", "SQL"), evidence_count=1,
           gate=None):
    s = InterviewService(f.FakeDB(), gate or f.AIGate())
    s.interviews = f.OwnedStore()
    s.applications = f.ApplicationStore()
    s.jobs = f.OwnedStore()
    s.evidence = f.EvidenceStore()
    s.ops = f.OperationStore()
    j = s.jobs.put(f.job(user_id, requirements=requirements))
    app = s.applications.put(f.application(user_id, j.id))
    evs = [s.evidence.put(f.evidence(user_id, title=f"E{i}"))
           for i in range(evidence_count)]
    iv = s.interviews.put(ent.InterviewSession(
        id=uuid4(), user_id=user_id, revision=2, application_id=app.id,
        title="Onsite", scheduled_at=f.now(), evidence_ids=[e.id for e in evs],
        company_sources=list(sources), created_at=f.now(), updated_at=f.now()))
    return s, iv, evs


async def _raises(code, aw):
    with pytest.raises(DomainError) as e:
        await aw
    assert e.value.code == code, e.value
    return e.value


async def test_prepare_builds_questions_star_answers_and_research():
    long_text = "가" * 250
    src = ent.CompanySource(source_url="https://acme.dev/about", source_text=long_text,
                            accessed_at=f.now())
    short = ent.CompanySource(source_url="https://acme.dev/b", source_text="Small team",
                              accessed_at=f.now())
    s, iv, evs = _world(sources=[src, short])
    op = await s.prepare(A, iv.id, 2, None)
    assert op.status == ent.OP_SUCCEEDED and op.type == ent.OP_INTERVIEW_PREPARE
    assert op.application_id == iv.application_id and op.user_id == A
    v = op.result.value
    eids = [str(evs[0].id)]
    assert v["questions"] == [
        {"question": "Describe your experience with: Go", "requirement": "Go",
         "evidenceIds": eids},
        {"question": "Describe your experience with: SQL", "requirement": "SQL",
         "evidenceIds": eids}]
    assert v["starAnswers"] == [{"evidenceIds": eids, "situation": "E0", "task": "",
                                 "action": "", "result": "",
                                 "needsInput": ["task", "action", "result"]}]
    assert v["research"][0]["claim"] == "가" * 200
    assert v["research"][1]["claim"] == "Small team"
    assert v["research"][0]["verificationStatus"] == ent.VERIFICATION_USER_PROVIDED
    assert v["research"][0]["sourceUrl"] == "https://acme.dev/about"
    assert (await s.ops.get(A, op.id)).status == ent.OP_SUCCEEDED
    # prepare is read-only for the interview itself.
    assert (await s.interviews.get(A, iv.id)).revision == 2


async def test_prepare_with_no_requirements_or_evidence_is_empty():
    s, iv, _ = _world(requirements=(), evidence_count=0)
    v = (await s.prepare(A, iv.id, 2, None)).result.value
    assert v == {"questions": [], "starAnswers": [], "research": []}


async def test_prepare_checks_ai_gate_first_and_writes_nothing_on_refusal():
    gate = f.AIGate(err=feature_disabled("ultraResume requires the ULTRA plan"))
    s, iv, _ = _world(gate=gate)
    opts = ent.AiOptions(provider="OPENAI", model="m",
                         effort="LOW")
    await _raises("FEATURE_DISABLED", s.prepare(A, iv.id, 2, opts))
    assert gate.checked == [(A, opts)] and s.ops.rows == {}


async def test_prepare_other_users_interview_is_not_found():
    s, iv, _ = _world(user_id=B)
    await _raises("NOT_FOUND", s.prepare(A, iv.id, 2, None))
    assert s.ops.rows == {}


async def test_prepare_stale_revision_conflicts():
    s, iv, _ = _world()
    err = await _raises("REVISION_CONFLICT", s.prepare(A, iv.id, 1, None))
    assert err.details == {"currentRevision": 2}


async def test_prepare_with_deleted_evidence_is_not_found():
    s, iv, evs = _world()
    del s.evidence.rows[evs[0].id]
    await _raises("NOT_FOUND", s.prepare(A, iv.id, 2, None))


def test_prepare_route_returns_202():
    s, iv, _ = _world()
    app = FastAPI()
    app.add_exception_handler(DomainError, domain_error_handler)
    app.include_router(router, prefix="/api/v1")
    app.add_middleware(_AsUser, user=ent.User(id=A, display_name="u",
                                              created_at=f.now()))
    app.state.deps = SimpleNamespace(interviews=s)
    c = TestClient(app)
    res = c.post(f"/api/v1/interviews/{iv.id}/prepare", json={"expectedRevision": 2})
    assert res.status_code == 202, res.text
    assert res.json()["data"]["result"]["kind"] == "INTERVIEW_PREPARE"
    stale = c.post(f"/api/v1/interviews/{iv.id}/prepare", json={"expectedRevision": 9})
    assert stale.status_code == 409
