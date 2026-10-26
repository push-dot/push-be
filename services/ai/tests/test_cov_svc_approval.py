from __future__ import annotations

from datetime import timedelta
from types import SimpleNamespace
from uuid import UUID, uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.errors import domain_error_handler
from app.api.routers.approvals import router
from app.db import ConflictError
from app.domain import entities as ent
from app.domain.errors import DomainError
from app.domain.pagination import PageRequest
from app.domain.services.approval import ApprovalService, hash_json
from tests import test_cov_svc_fakes as f

A, B = uuid4(), uuid4()


def _svc():
    s = ApprovalService(f.FakeDB())
    s.approvals = f.ApprovalStore()
    s.applications = f.ApplicationStore()
    s.evidence = f.EvidenceStore()
    s.documents = f.DocumentStore()
    s.submissions = f.SubmissionStore()
    s.projects = f.ProjectStore()
    return s


async def _raises(code, aw):
    with pytest.raises(DomainError) as e:
        await aw
    assert e.value.code == code, e.value
    return e.value


def _draft(user_id, app_id):
    return ent.SubmissionDraft(id=uuid4(), user_id=user_id, application_id=app_id,
                               application_revision=1, mode="MANUAL",
                               document_version_ids=[uuid4()],
                               payload_hash="draft-hash", created_at=f.now())


def _run(user_id, app_id):
    return ent.CliRun(id=uuid4(), user_id=user_id, project_id=uuid4(),
                      application_id=app_id, provider="CODEX",
                      working_directory="/w", executable="codex",
                      arguments=["exec"], prompt="p", payload_hash="run-hash",
                      state="APPROVAL_REQUIRED", created_at=f.now(),
                      updated_at=f.now())


# ---- create -----------------------------------------------------------------

async def test_create_evidence_use_hashes_content_and_starts_pending():
    s = _svc()
    e = s.evidence.put(f.evidence(A, content_hash="c1"))
    before = f.now()
    a = await s.create(A, ent.APPROVAL_EVIDENCE_USE, None, e.id, 3)
    assert a.status == ent.APPROVAL_PENDING and a.revision == 1
    assert a.user_id == A and a.target_revision == 3
    assert a.payload_hash == hash_json({"kind": ent.APPROVAL_EVIDENCE_USE,
                                        "evidenceId": e.id, "contentHash": "c1"})
    assert before + ent.DEFAULT_APPROVAL_TTL <= a.expires_at
    assert (await s.approvals.get(A, a.id)).payload_hash == a.payload_hash


async def test_create_hash_changes_when_evidence_content_changes():
    s = _svc()
    e1 = s.evidence.put(f.evidence(A, content_hash="c1"))
    e2 = s.evidence.put(f.evidence(A, id=e1.id, content_hash="c2"))
    h1 = hash_json({"kind": "EVIDENCE_USE", "evidenceId": e1.id, "contentHash": "c1"})
    a = await s.create(A, ent.APPROVAL_EVIDENCE_USE, None, e2.id, None)
    assert a.payload_hash != h1


async def test_create_rejects_unknown_kind():
    err = await _raises("VALIDATION_ERROR",
                        _svc().create(A, "DELETE_ACCOUNT", None, uuid4(), None))
    assert err.details == {"field": "kind"}


async def test_create_refuses_archived_evidence():
    s = _svc()
    e = s.evidence.put(f.evidence(A, archived=True))
    await _raises("INVALID_TRANSITION",
                  s.create(A, ent.APPROVAL_EVIDENCE_USE, None, e.id, None))
    assert s.approvals.rows == {}


async def test_create_cannot_target_another_users_evidence():
    s = _svc()
    e = s.evidence.put(f.evidence(B))
    await _raises("NOT_FOUND", s.create(A, ent.APPROVAL_EVIDENCE_USE, None, e.id, None))


async def test_create_cannot_bind_another_users_application():
    s = _svc()
    app = s.applications.put(f.application(B))
    e = s.evidence.put(f.evidence(A))
    await _raises("NOT_FOUND",
                  s.create(A, ent.APPROVAL_EVIDENCE_USE, app.id, e.id, None))


async def test_create_application_lookup_failure_is_internal():
    s = _svc()
    s.applications = f.Boom()
    await _raises("INTERNAL", s.create(A, ent.APPROVAL_EVIDENCE_USE, uuid4(), uuid4(), None))


async def test_create_document_finalize_hash_and_application_scope():
    s = _svc()
    app = s.applications.put(f.application(A))
    doc = f.document(A, app.id)
    v = f.version(A, doc)
    await s.documents.create_version(v)
    a = await s.create(A, ent.APPROVAL_DOCUMENT_FINALIZE, app.id, v.id, None)
    assert a.payload_hash == hash_json({"kind": "DOCUMENT_FINALIZE", "versionId": v.id,
                                        "content": v.content, "blocks": v.blocks})
    # Same version cannot be approved under no / another application.
    await _raises("NOT_FOUND",
                  s.create(A, ent.APPROVAL_DOCUMENT_FINALIZE, None, v.id, None))


async def test_create_application_submit_uses_draft_hash_and_scope():
    s = _svc()
    app = s.applications.put(f.application(A))
    other = s.applications.put(f.application(A))
    d = s.submissions.put(_draft(A, app.id))
    a = await s.create(A, ent.APPROVAL_APPLICATION_SUBMIT, app.id, d.id, None)
    assert a.payload_hash == "draft-hash"
    await _raises("NOT_FOUND",
                  s.create(A, ent.APPROVAL_APPLICATION_SUBMIT, other.id, d.id, None))


async def test_create_cli_execute_uses_run_hash_and_scope():
    s = _svc()
    app = s.applications.put(f.application(A))
    r = s.projects.put(_run(A, app.id))
    a = await s.create(A, ent.APPROVAL_CLI_EXECUTE, app.id, r.id, 1)
    assert a.payload_hash == "run-hash"
    await _raises("NOT_FOUND", s.create(A, ent.APPROVAL_CLI_EXECUTE, None, r.id, 1))


async def test_create_missing_target_is_not_found_and_outage_is_internal():
    s = _svc()
    await _raises("NOT_FOUND",
                  s.create(A, ent.APPROVAL_APPLICATION_SUBMIT, None, uuid4(), None))
    s.evidence = f.Boom()
    await _raises("INTERNAL", s.create(A, ent.APPROVAL_EVIDENCE_USE, None, uuid4(), None))


async def test_create_store_failure_is_internal():
    s = _svc()
    e = s.evidence.put(f.evidence(A))
    s.approvals = f.Boom()
    await _raises("INTERNAL", s.create(A, ent.APPROVAL_EVIDENCE_USE, None, e.id, None))


# ---- list / get -------------------------------------------------------------

async def test_list_is_scoped_to_user_and_filters():
    s = _svc()
    app = uuid4()
    mine = s.approvals.put(f.approval(A, application_id=app))
    s.approvals.put(f.approval(A, status=ent.APPROVAL_APPROVED))
    s.approvals.put(f.approval(B, application_id=app))
    page = await s.list(A, app, "PENDING", PageRequest())
    assert [x.id for x in page.items] == [mine.id]
    assert len((await s.list(A, None, None, PageRequest())).items) == 2
    s.approvals = f.Boom()
    await _raises("INTERNAL", s.list(A, None, None, PageRequest()))


async def test_get_returns_target_summary_per_kind():
    s = _svc()
    app = s.applications.put(f.application(A))
    e = s.evidence.put(f.evidence(A, title="Go API"))
    doc = f.document(A, app.id)
    v = f.version(A, doc)
    await s.documents.create_version(v)
    d = s.submissions.put(_draft(A, app.id))
    r = s.projects.put(_run(A, app.id))
    cases = [
        (ent.APPROVAL_EVIDENCE_USE, e.id,
         {"type": "EVIDENCE", "id": str(e.id), "title": "Go API", "kind": "CAREER"}),
        (ent.APPROVAL_DOCUMENT_FINALIZE, v.id,
         {"type": "DOCUMENT_VERSION", "id": str(v.id), "documentId": str(doc.id),
          "number": 1}),
        (ent.APPROVAL_APPLICATION_SUBMIT, d.id,
         {"type": "SUBMISSION_DRAFT", "id": str(d.id), "mode": "MANUAL",
          "documentVersionIds": [str(d.document_version_ids[0])]}),
        (ent.APPROVAL_CLI_EXECUTE, r.id,
         {"type": "CLI_RUN", "id": str(r.id), "provider": "CODEX",
          "workingDirectory": "/w", "executable": "codex", "arguments": ["exec"],
          "prompt": "p"}),
    ]
    for kind, target, want in cases:
        a = s.approvals.put(f.approval(A, kind=kind, target_id=target))
        got, summary = await s.get(A, a.id)
        assert got.id == a.id
        assert summary == want


async def test_get_with_vanished_target_has_empty_summary():
    s = _svc()
    a = s.approvals.put(f.approval(A, target_id=uuid4()))
    _, summary = await s.get(A, a.id)
    assert summary == {}
    a2 = s.approvals.put(f.approval(A, kind="LEGACY_KIND"))
    assert (await s.get(A, a2.id))[1] == {}


async def test_get_is_owner_only_and_maps_outages():
    s = _svc()
    a = s.approvals.put(f.approval(A))
    await _raises("NOT_FOUND", s.get(B, a.id))
    s.evidence = f.Boom()
    await _raises("INTERNAL", s.get(A, a.id))
    s.approvals = f.Boom()
    await _raises("INTERNAL", s.get(A, a.id))


# ---- decide -----------------------------------------------------------------

@pytest.mark.parametrize("decision", [ent.APPROVAL_APPROVED, ent.APPROVAL_DENIED])
async def test_decide_moves_pending_to_decision_and_bumps_revision(decision):
    s = _svc()
    a = s.approvals.put(f.approval(A))
    out = await s.decide(A, a.id, 1, decision)
    assert out.status == decision and out.revision == 2 and out.decided_at
    stored = await s.approvals.get(A, a.id)
    assert stored.status == decision and stored.revision == 2


async def test_decide_validates_decision_value():
    await _raises("VALIDATION_ERROR", _svc().decide(A, uuid4(), 1, "CONSUMED"))


async def test_decide_other_users_approval_is_not_found():
    s = _svc()
    a = s.approvals.put(f.approval(B))
    await _raises("NOT_FOUND", s.decide(A, a.id, 1, ent.APPROVAL_APPROVED))
    assert (await s.approvals.get(B, a.id)).status == ent.APPROVAL_PENDING


async def test_decide_stale_revision_conflicts():
    s = _svc()
    a = s.approvals.put(f.approval(A, revision=2))
    err = await _raises("REVISION_CONFLICT", s.decide(A, a.id, 1, ent.APPROVAL_APPROVED))
    assert err.details == {"currentRevision": 2}


async def test_decide_twice_is_invalid_transition():
    s = _svc()
    a = s.approvals.put(f.approval(A))
    await s.decide(A, a.id, 1, ent.APPROVAL_DENIED)
    await _raises("INVALID_TRANSITION", s.decide(A, a.id, 2, ent.APPROVAL_APPROVED))
    assert (await s.approvals.get(A, a.id)).status == ent.APPROVAL_DENIED


async def test_decide_expired_pending_persists_expired_and_refuses():
    s = _svc()
    a = s.approvals.put(f.approval(A, expires_in=timedelta(seconds=-1)))
    err = await _raises("INVALID_TRANSITION", s.decide(A, a.id, 1, ent.APPROVAL_APPROVED))
    assert "expired" in err.message
    stored = await s.approvals.get(A, a.id)
    assert stored.status == ent.APPROVAL_EXPIRED and stored.revision == 2


async def test_decide_lost_race_maps_to_revision_conflict():
    s = _svc()
    a = s.approvals.put(f.approval(A))

    async def racing_update(row, expected):
        raise ConflictError(5)
    s.approvals.update = racing_update
    await _raises("REVISION_CONFLICT", s.decide(A, a.id, 1, ent.APPROVAL_APPROVED))
    expired = s.approvals.put(f.approval(A, expires_in=timedelta(seconds=-1)))
    await _raises("REVISION_CONFLICT", s.decide(A, expired.id, 1, ent.APPROVAL_DENIED))


# ---- consume ----------------------------------------------------------------

def _approved(s, kind=ent.APPROVAL_DOCUMENT_FINALIZE, app=None, target=None, **kw):
    return s.approvals.put(f.approval(A, kind=kind, application_id=app,
                                      target_id=target or uuid4(),
                                      status=ent.APPROVAL_APPROVED, **kw))


async def test_consume_one_shot_marks_consumed_and_cannot_be_reused():
    s = _svc()
    app = uuid4()
    a = _approved(s, app=app)
    out = await s.consume(A, a.id, a.kind, app, a.target_id, "h")
    assert out.status == ent.APPROVAL_CONSUMED and out.consumed_at and out.revision == 2
    assert (await s.approvals.get(A, a.id)).status == ent.APPROVAL_CONSUMED
    await _raises("APPROVAL_REQUIRED", s.consume(A, a.id, a.kind, app, a.target_id, "h"))


async def test_consume_evidence_use_is_reusable():
    s = _svc()
    a = _approved(s, kind=ent.APPROVAL_EVIDENCE_USE)
    for _ in range(2):
        out = await s.consume(A, a.id, a.kind, None, a.target_id, "h")
        assert out.status == ent.APPROVAL_APPROVED
    assert (await s.approvals.get(A, a.id)).revision == 1


async def test_consume_rejects_mismatched_scope():
    s = _svc()
    app = uuid4()
    a = _approved(s, app=app)
    for kind, app_id, target in [
        (ent.APPROVAL_CLI_EXECUTE, app, a.target_id),
        (a.kind, uuid4(), a.target_id),
        (a.kind, app, uuid4()),
    ]:
        err = await _raises("APPROVAL_REQUIRED", s.consume(A, a.id, kind, app_id, target, "h"))
        assert "does not cover" in err.message


async def test_consume_rejects_expired_unapproved_stale_and_foreign():
    s = _svc()
    exp = _approved(s, expires_in=timedelta(seconds=-1))
    await _raises("APPROVAL_REQUIRED", s.consume(A, exp.id, exp.kind, None, exp.target_id, "h"))
    pend = s.approvals.put(f.approval(A, kind=ent.APPROVAL_DOCUMENT_FINALIZE))
    await _raises("APPROVAL_REQUIRED",
                  s.consume(A, pend.id, pend.kind, None, pend.target_id, "h"))
    ok = _approved(s)
    await _raises("APPROVAL_STALE", s.consume(A, ok.id, ok.kind, None, ok.target_id, "other"))
    await _raises("APPROVAL_REQUIRED", s.consume(B, ok.id, ok.kind, None, ok.target_id, "h"))
    # An empty expected hash skips the content check.
    assert (await s.consume(A, ok.id, ok.kind, None, ok.target_id, "")).status == "CONSUMED"


async def test_consume_store_failures():
    s = _svc()
    a = _approved(s)

    async def racing_update(row, expected):
        raise ConflictError(9)
    s.approvals.update = racing_update
    await _raises("REVISION_CONFLICT", s.consume(A, a.id, a.kind, None, a.target_id, "h"))
    s.approvals = f.Boom()
    await _raises("INTERNAL", s.consume(A, a.id, a.kind, None, a.target_id, "h"))


# ---- require_evidence_use ---------------------------------------------------

async def test_require_evidence_use_needs_an_approved_unexpired_grant():
    s = _svc()
    app, ev = uuid4(), uuid4()
    await _raises("APPROVAL_REQUIRED", s.require_evidence_use(A, app, ev))
    s.approvals.put(f.approval(A, target_id=ev, application_id=app))  # pending
    await _raises("APPROVAL_REQUIRED", s.require_evidence_use(A, app, ev))
    s.approvals.put(f.approval(B, target_id=ev, application_id=app,
                               status=ent.APPROVAL_APPROVED))  # someone else's
    await _raises("APPROVAL_REQUIRED", s.require_evidence_use(A, app, ev))
    s.approvals.put(f.approval(A, target_id=ev, application_id=app,
                               status=ent.APPROVAL_APPROVED))
    await s.require_evidence_use(A, app, ev)
    # Approval for another application does not leak across.
    await _raises("APPROVAL_REQUIRED", s.require_evidence_use(A, uuid4(), ev))
    s.approvals = f.Boom()
    await _raises("INTERNAL", s.require_evidence_use(A, app, ev))


# ---- router -----------------------------------------------------------------

class _AsUser:
    def __init__(self, app, user):
        self.app, self.user = app, user

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http" and self.user is not None:
            scope.setdefault("state", {})["user"] = self.user
        await self.app(scope, receive, send)


def _client(svc, user_id=A):
    app = FastAPI()
    app.add_exception_handler(DomainError, domain_error_handler)
    app.include_router(router, prefix="/api/v1")
    app.add_middleware(_AsUser, user=None if user_id is None else ent.User(
        id=user_id, display_name="u", created_at=f.now()))
    app.state.deps = SimpleNamespace(approvals=svc)
    return TestClient(app)


def test_router_create_get_decide_list_roundtrip():
    s = _svc()
    e = s.evidence.put(f.evidence(A, title="Go"))
    c = _client(s)
    res = c.post("/api/v1/approvals", json={"kind": "EVIDENCE_USE", "targetId": str(e.id)})
    assert res.status_code == 201, res.text
    a = res.json()["data"]
    assert a["status"] == "PENDING" and "userId" not in a
    got = c.get(f"/api/v1/approvals/{a['id']}").json()["data"]
    assert got["target"]["title"] == "Go" and got["approval"]["id"] == a["id"]
    dec = c.post(f"/api/v1/approvals/{a['id']}/decision",
                 json={"expectedRevision": 1, "decision": "APPROVED"})
    assert dec.status_code == 200 and dec.json()["data"]["revision"] == 2
    page = c.get("/api/v1/approvals?status=APPROVED").json()
    assert [x["id"] for x in page["data"]] == [a["id"]]
    assert page["page"] == {"nextCursor": None, "hasMore": False}


def test_router_rejects_bad_status_bad_id_and_other_user():
    s = _svc()
    a = s.approvals.put(f.approval(A))
    c = _client(s)
    assert c.get("/api/v1/approvals?status=BOGUS").status_code == 400
    assert c.get("/api/v1/approvals?applicationId=nope").status_code == 400
    assert c.get("/api/v1/approvals/not-a-uuid").status_code == 400
    other = _client(s, B).get(f"/api/v1/approvals/{a.id}")
    assert other.status_code == 404 and other.json()["error"]["code"] == "NOT_FOUND"
    assert _client(s, None).get("/api/v1/approvals").status_code == 401


async def test_denied_evidence_lists_only_this_users_refused_evidence_use():
    s = _svc()
    app_id, other_app = uuid4(), uuid4()
    refused = s.approvals.put(f.approval(A, application_id=app_id,
                                         status=ent.APPROVAL_DENIED))
    s.approvals.put(f.approval(A, application_id=app_id, status=ent.APPROVAL_APPROVED))
    s.approvals.put(f.approval(A, kind=ent.APPROVAL_DOCUMENT_FINALIZE,
                               application_id=app_id, status=ent.APPROVAL_DENIED))
    s.approvals.put(f.approval(A, application_id=other_app, status=ent.APPROVAL_DENIED))
    s.approvals.put(f.approval(B, application_id=app_id, status=ent.APPROVAL_DENIED))
    assert await s.denied_evidence(A, app_id) == {refused.target_id}
