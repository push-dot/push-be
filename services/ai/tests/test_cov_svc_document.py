"""DocumentService paths that are still live in Python: the revision proposal
route, the export route's get/get_version, the resume-run workflow
(create -> generate -> finalize -> create_export) and the harness
(list/get/create/create_version). Uses the real ApprovalService over
in-memory stores so approval gating is exercised end to end."""
from __future__ import annotations

from types import SimpleNamespace
from uuid import uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.errors import domain_error_handler
from app.api.routers.documents import router
from app.db import ConflictError
from app.domain import entities as ent
from app.domain.errors import DomainError
from app.domain.pagination import PageRequest
from app.domain.services.document import DocumentService, compute_quality
from tests import test_cov_svc_fakes as f
from tests.test_cov_svc_approval import _AsUser, _svc as _approval_svc

A, B = uuid4(), uuid4()


def _svc(gate=None):
    ap = _approval_svc()
    s = DocumentService(f.FakeDB(), ap, gate or f.AIGate())
    # One shared world: approvals see the same documents/evidence/apps.
    s.documents = ap.documents
    s.evidence = ap.evidence
    s.applications = ap.applications
    s.ops = f.OperationStore()
    return s


async def _raises(code, aw):
    with pytest.raises(DomainError) as e:
        await aw
    assert e.value.code == code, e.value
    return e.value


def _doc(s, user_id=A, app_id=None, **kw):
    return s.documents.put(f.document(user_id, app_id, **kw))


def _content(*texts):
    return {"type": "doc", "content": [
        {"type": "paragraph", "attrs": {"blockId": f"b{i}"},
         "content": [{"type": "text", "text": t}]} for i, t in enumerate(texts, 1)]}


def _ref(e, start, end):
    return ent.EvidenceRef(evidence_id=e.id, start=start, end=end)


async def _approve(s, kind, app_id, target_id, user_id=A):
    a = await s.approvals.create(user_id, kind, app_id, target_id, None)
    return await s.approvals.decide(user_id, a.id, a.revision, ent.APPROVAL_APPROVED)


# ---- quality ----------------------------------------------------------------

def test_compute_quality_scores_fidelity_and_lists_issues():
    blocks = [ent.Block(id="a", text="x", claim_status=ent.CLAIM_SUPPORTED),
              ent.Block(id="b", text="y", claim_status=ent.CLAIM_UNSUPPORTED),
              ent.Block(id="c", text="z", claim_status=ent.CLAIM_NEEDS_REVIEW)]
    q = compute_quality(blocks, ent.METHOD_RULE_BASED)
    assert q.evidence_fidelity == 66
    assert [(i.code, i.severity, i.block_id) for i in q.issues] == [
        ("UNSUPPORTED_CLAIM", "ERROR", "b"), ("NEEDS_REVIEW", "WARN", "c")]
    assert compute_quality([], "M").evidence_fidelity is None


# ---- create / list / get ----------------------------------------------------

async def test_create_stores_draft_with_canonical_template():
    s = _svc()
    app = s.applications.put(f.application(A))
    d = await s.create(A, app.id, "CV", "RESUME", "CLASSIC", "ko")
    assert d.status == ent.DOC_DRAFT and d.template == "SIMPLE" and d.revision == 1
    assert (await s.get(A, d.id)).application_id == app.id
    statement = await s.create(A, None, "경력", "CAREER_STATEMENT", "SIMPLE", "ko")
    assert statement.kind == "CAREER_STATEMENT" and statement.status == ent.DOC_DRAFT


@pytest.mark.parametrize("title,kind,template,field", [
    ("", "RESUME", "SIMPLE", "title"),
    ("x" * 301, "RESUME", "SIMPLE", "title"),
    ("CV", "LETTER", "SIMPLE", "kind"),
    ("CV", "RESUME", "FANCY", "template"),
])
async def test_create_validates_input(title, kind, template, field):
    s = _svc()
    err = await _raises("VALIDATION_ERROR", s.create(A, None, title, kind, template, ""))
    assert err.details == {"field": field}
    assert s.documents.rows == {}


async def test_create_cannot_attach_to_another_users_application():
    s = _svc()
    app = s.applications.put(f.application(B))
    await _raises("NOT_FOUND", s.create(A, app.id, "CV", "RESUME", "SIMPLE", ""))
    s.applications = f.Boom()
    await _raises("INTERNAL", s.create(A, app.id, "CV", "RESUME", "SIMPLE", ""))


async def test_create_store_failure_is_internal():
    s = _svc()
    s.documents = f.Boom()
    await _raises("INTERNAL", s.create(A, None, "CV", "RESUME", "SIMPLE", ""))


async def test_list_get_get_version_are_owner_scoped():
    s = _svc()
    mine, theirs = _doc(s), _doc(s, B)
    assert [d.id for d in (await s.list(A, None, None, PageRequest())).items] == [mine.id]
    await _raises("NOT_FOUND", s.get(A, theirs.id))
    v = f.version(B, theirs)
    await s.documents.create_version(v)
    await _raises("NOT_FOUND", s.get_version(A, theirs.id, v.id))
    # A version id from another document does not resolve under mine.
    await _raises("NOT_FOUND", s.get_version(A, mine.id, v.id))
    mv = f.version(A, mine)
    await s.documents.create_version(mv)
    assert (await s.get_version(A, mine.id, mv.id)).id == mv.id


async def test_read_outages_are_internal():
    s = _svc()
    d = _doc(s)
    real = s.documents
    s.documents = f.Boom()
    await _raises("INTERNAL", s.get(A, d.id))
    await _raises("INTERNAL", s.list(A, None, None, PageRequest()))

    class VersionBoom(f.DocumentStore):
        async def get_version(self, *a):
            raise RuntimeError("db down")
    s.documents = VersionBoom()
    s.documents.rows = real.rows
    await _raises("INTERNAL", s.get_version(A, d.id, uuid4()))


# ---- create_version (harness save) -----------------------------------------

async def test_create_version_grades_blocks_against_evidence():
    s = _svc()
    e = s.evidence.put(f.evidence(A, text="Built a Go API"))
    d = _doc(s, status=ent.DOC_FINALIZED, finalized_version_id=uuid4())
    blocks = [ent.Block(id="b1", text="I Built a Go API", evidence_refs=[_ref(e, 0, 14)]),
              ent.Block(id="b2", text="Rust expert", evidence_refs=[_ref(e, 0, 5)]),
              ent.Block(id="b3", text="Team player")]
    content = _content("I Built a Go API", "Rust expert", "Team player")
    out_doc, v = await s.create_version(A, d.id, 1, content, blocks, "save")
    assert [b.claim_status for b in v.blocks] == ["SUPPORTED", "NEEDS_REVIEW", "UNSUPPORTED"]
    assert v.quality.evidence_fidelity == 66 and v.number == 1
    assert blocks[0].claim_status == ""  # caller's blocks are not mutated
    assert out_doc.status == ent.DOC_DRAFT and out_doc.finalized_version_id is None
    assert out_doc.latest_version_id == v.id and out_doc.revision == 2
    stored = await s.documents.get(A, d.id)
    assert stored.revision == 2 and stored.latest_version_id == v.id
    _, v2 = await s.create_version(A, d.id, 2, content, blocks, "again")
    assert v2.number == 2


@pytest.mark.parametrize("case", ["missing", "foreign", "archived", "range"])
async def test_create_version_rejects_bad_evidence_refs(case):
    s = _svc()
    d = _doc(s)
    e = f.evidence(B if case == "foreign" else A, archived=case == "archived", text="abc")
    if case != "missing":
        s.evidence.put(e)
    end = 99 if case == "range" else 3
    blocks = [ent.Block(id="b1", text="abc", evidence_refs=[_ref(e, 0, end)])]
    err = await _raises("VALIDATION_ERROR", s.create_version(A, d.id, 1, _content("abc"),
                                                             blocks, ""))
    assert err.details == {"field": "blocks"}
    assert s.documents.versions == {}


async def test_create_version_guards_state_revision_and_content():
    s = _svc()
    arch = _doc(s, status=ent.DOC_ARCHIVED)
    await _raises("INVALID_TRANSITION", s.create_version(A, arch.id, 1, _content(), [], ""))
    d = _doc(s)
    await _raises("REVISION_CONFLICT", s.create_version(A, d.id, 7, _content(), [], ""))
    await _raises("NOT_FOUND", s.create_version(B, d.id, 1, _content(), [], ""))
    mismatch = [ent.Block(id="b1", text="other")]
    await _raises("VALIDATION_ERROR",
                  s.create_version(A, d.id, 1, _content("text"), mismatch, ""))


async def test_create_version_lost_race_is_revision_conflict():
    s = _svc()
    d = _doc(s)

    async def racing(doc, expected):
        raise ConflictError(4)
    s.documents.update = racing
    err = await _raises("REVISION_CONFLICT", s.create_version(A, d.id, 1, _content(), [], ""))
    assert err.details == {"currentRevision": 4}


# ---- generate ---------------------------------------------------------------

async def test_generate_requires_approved_evidence_use():
    s = _svc()
    app = s.applications.put(f.application(A))
    d = _doc(s, app_id=app.id)
    e = s.evidence.put(f.evidence(A))
    await _raises("APPROVAL_REQUIRED", s.generate(A, d.id, 1, [e.id], None, None, None))
    assert s.documents.versions == {} and s.ops.rows == {}
    # Approval granted for a different application does not count.
    await _approve(s, ent.APPROVAL_EVIDENCE_USE, None, e.id)
    await _raises("APPROVAL_REQUIRED", s.generate(A, d.id, 1, [e.id], None, None, None))


async def test_generate_builds_excerpt_version_and_operation():
    gate = f.AIGate()
    s = _svc(gate)
    app = s.applications.put(f.application(A))
    d = _doc(s, app_id=app.id, status=ent.DOC_FINALIZED, finalized_version_id=uuid4())
    long_e = s.evidence.put(f.evidence(A, text="a" * 600))
    short_e = s.evidence.put(f.evidence(A, text="short"))
    for e in (long_e, short_e):
        await _approve(s, ent.APPROVAL_EVIDENCE_USE, app.id, e.id)
    op = await s.generate(A, d.id, 1, [long_e.id, short_e.id], None, None, "en")
    assert gate.checked == [(A, None)]
    assert op.status == ent.OP_SUCCEEDED and op.type == ent.OP_DOCUMENT_GENERATE
    doc, ver = op.result.value["document"], op.result.value["version"]
    assert doc["status"] == "DRAFT" and doc["finalizedVersionId"] is None
    assert doc["language"] == "en" and doc["revision"] == 2
    assert [b["text"] for b in ver["blocks"]] == ["a" * 500, "short"]
    assert ver["blocks"][0]["evidenceRefs"][0]["end"] == 500
    assert ver["quality"]["evidenceFidelity"] == 100
    assert (await s.ops.get(A, op.id)).id == op.id
    assert (await s.documents.get(A, d.id)).latest_version_id is not None


async def test_generate_validates_evidence_list():
    s = _svc()
    d = _doc(s)
    err = await _raises("VALIDATION_ERROR", s.generate(A, d.id, 1, [], None, None, None))
    assert err.details == {"field": "evidenceIds"}
    await _raises("VALIDATION_ERROR", s.generate(A, d.id, 1, [uuid4()], None, None, None))
    foreign = s.evidence.put(f.evidence(B))
    await _raises("VALIDATION_ERROR", s.generate(A, d.id, 1, [foreign.id], None, None, None))
    archived = s.evidence.put(f.evidence(A, archived=True))
    await _raises("VALIDATION_ERROR", s.generate(A, d.id, 1, [archived.id], None, None, None))
    await _raises("REVISION_CONFLICT", s.generate(A, d.id, 3, [archived.id], None, None, None))


async def test_generate_lost_race_is_revision_conflict():
    s = _svc()
    d = _doc(s)
    e = s.evidence.put(f.evidence(A))
    await _approve(s, ent.APPROVAL_EVIDENCE_USE, None, e.id)

    async def racing(doc, expected):
        raise ConflictError(3)
    s.documents.update = racing
    await _raises("REVISION_CONFLICT", s.generate(A, d.id, 1, [e.id], None, None, None))


# ---- finalize + export (resume-run pipeline) ---------------------------------

async def _generated(s, app_id=None):
    d = _doc(s, app_id=app_id)
    e = s.evidence.put(f.evidence(A, text="Shipped payments"))
    await _approve(s, ent.APPROVAL_EVIDENCE_USE, app_id, e.id)
    op = await s.generate(A, d.id, 1, [e.id], None, None, None)
    vid = op.result.value["version"]["id"]
    return d, e, (await s.documents.get_version(A, d.id, vid))


async def test_finalize_consumes_approval_and_records_event():
    s = _svc()
    app = s.applications.put(f.application(A))
    d, _, v = await _generated(s, app.id)
    fa = await _approve(s, ent.APPROVAL_DOCUMENT_FINALIZE, app.id, v.id)
    out = await s.finalize(A, d.id, 2, v.id, fa.id)
    assert out.status == ent.DOC_FINALIZED and out.finalized_version_id == v.id
    assert out.revision == 3
    assert (await s.approvals.approvals.get(A, fa.id)).status == ent.APPROVAL_CONSUMED
    [ev] = s.applications.events
    assert ev.type == ent.EVENT_DOCUMENT_FINAL and ev.payload["versionId"] == v.id
    # The one-shot approval cannot finalize again.
    await _raises("APPROVAL_REQUIRED", s.finalize(A, d.id, 3, v.id, fa.id))

    exp = await s.create_export(A, d.id, v.id, "PDF", "v1")
    assert exp.status == "READY_TO_RENDER" and exp.version_id == v.id
    assert exp.template == "SIMPLE" and exp.language == "ko" and len(exp.content_hash) == 64
    assert s.documents.exports == [exp]


async def test_finalize_without_application_has_no_event():
    s = _svc()
    d, _, v = await _generated(s)
    fa = await _approve(s, ent.APPROVAL_DOCUMENT_FINALIZE, None, v.id)
    assert (await s.finalize(A, d.id, 2, v.id, fa.id)).status == ent.DOC_FINALIZED
    assert s.applications.events == []


async def test_finalize_refuses_unsupported_claims():
    s = _svc()
    d = _doc(s)
    _, v = await s.create_version(A, d.id, 1, _content("bare claim"),
                                  [ent.Block(id="b1", text="bare claim")], "")
    fa = await _approve(s, ent.APPROVAL_DOCUMENT_FINALIZE, None, v.id)
    await _raises("UNSUPPORTED_CLAIM", s.finalize(A, d.id, 2, v.id, fa.id))
    assert (await s.approvals.approvals.get(A, fa.id)).status == ent.APPROVAL_APPROVED


async def test_finalize_requires_matching_approval_and_evidence_use():
    s = _svc()
    d, e, v = await _generated(s)
    other_ver = v.model_copy(deep=True, update={"id": uuid4(), "number": 2})
    fa_other = await _approve(s, ent.APPROVAL_DOCUMENT_FINALIZE, None, v.id)
    await s.documents.create_version(other_ver)
    # Approval for a different version does not cover this one.
    await _raises("APPROVAL_REQUIRED", s.finalize(A, d.id, 2, other_ver.id, fa_other.id))
    # Revoke evidence use: finalize must re-check it.
    for a in list(s.approvals.approvals.rows.values()):
        if a.kind == ent.APPROVAL_EVIDENCE_USE:
            del s.approvals.approvals.rows[a.id]
    await _raises("APPROVAL_REQUIRED", s.finalize(A, d.id, 2, v.id, fa_other.id))


async def test_finalize_guards():
    s = _svc()
    d, _, v = await _generated(s)
    fa = await _approve(s, ent.APPROVAL_DOCUMENT_FINALIZE, None, v.id)
    await _raises("REVISION_CONFLICT", s.finalize(A, d.id, 1, v.id, fa.id))
    await _raises("NOT_FOUND", s.finalize(A, d.id, 2, uuid4(), fa.id))
    await _raises("NOT_FOUND", s.finalize(B, d.id, 2, v.id, fa.id))

    async def racing(doc, expected):
        raise ConflictError(8)
    s.documents.update = racing
    await _raises("REVISION_CONFLICT", s.finalize(A, d.id, 2, v.id, fa.id))


async def test_create_export_guards():
    s = _svc()
    d, _, v = await _generated(s)
    await _raises("VALIDATION_ERROR", s.create_export(A, d.id, v.id, "HTML", "v1"))
    await _raises("VALIDATION_ERROR", s.create_export(A, d.id, v.id, "PDF", ""))
    err = await _raises("DOCUMENT_NOT_FINALIZED", s.create_export(A, d.id, v.id, "DOCX", "v1"))
    assert err.status == 422
    await _raises("NOT_FOUND", s.create_export(B, d.id, v.id, "PDF", "v1"))
    await _raises("NOT_FOUND", s.create_export(A, d.id, uuid4(), "PDF", "v1"))
    assert s.documents.exports == []


# ---- create_revision --------------------------------------------------------

async def _with_version(s, text="Increased revenue by 40 percent"):
    d = _doc(s)
    _, v = await s.create_version(A, d.id, 1, _content(text),
                                  [ent.Block(id="b1", text=text)], "")
    return d, v


@pytest.mark.parametrize("action,replacement", [
    ("SHORTEN", "revenu"), ("REWRITE", "revenue by 40"), ("TAILOR_TO_JOB", "revenue by 40")])
async def test_create_revision_records_proposal(action, replacement):
    gate = f.AIGate()
    s = _svc(gate)
    d, v = await _with_version(s)
    sel = ent.Selection(**{"from": 10, "to": 23, "text": "revenue by 40"})
    op = await s.create_revision(A, d.id, 2, v.id, sel, action, "", None)
    assert gate.checked == [(A, None)]
    assert op.type == ent.OP_DOCUMENT_REVISE and op.status == ent.OP_SUCCEEDED
    p = op.result.value
    assert p["sourceVersionId"] == str(v.id) and p["sourceRevision"] == 2
    assert p["claimStatus"] == ent.CLAIM_NEEDS_REVIEW
    assert p["replacement"] == replacement
    [stored] = s.documents.proposals
    assert stored.document_id == d.id and stored.user_id == A


@pytest.mark.parametrize("sel", [
    {"from": -1, "to": 3, "text": "abc"},
    {"from": 3, "to": 3, "text": "abc"},
    {"from": 0, "to": 3, "text": ""},
])
async def test_create_revision_rejects_bad_selection(sel):
    s = _svc()
    err = await _raises("VALIDATION_ERROR", s.create_revision(
        A, uuid4(), 1, uuid4(), ent.Selection(**sel), "REWRITE", "", None))
    assert err.details == {"field": "selection"}


async def test_create_revision_guards():
    s = _svc()
    d, v = await _with_version(s)
    sel = ent.Selection(**{"from": 0, "to": 3, "text": "Inc"})
    await _raises("VALIDATION_ERROR", s.create_revision(A, d.id, 2, v.id, sel, "DELETE", "", None))
    missing = ent.Selection(**{"from": 0, "to": 3, "text": "zzz"})
    await _raises("VALIDATION_ERROR", s.create_revision(A, d.id, 2, v.id, missing, "REWRITE", "", None))
    await _raises("REVISION_CONFLICT", s.create_revision(A, d.id, 1, v.id, sel, "REWRITE", "", None))
    await _raises("NOT_FOUND", s.create_revision(B, d.id, 2, v.id, sel, "REWRITE", "", None))
    other, ov = await _with_version(s)
    await _raises("NOT_FOUND", s.create_revision(A, d.id, 2, ov.id, sel, "REWRITE", "", None))
    arch = _doc(s, status=ent.DOC_ARCHIVED)
    await _raises("INVALID_TRANSITION", s.create_revision(A, arch.id, 1, v.id, sel, "REWRITE", "", None))
    assert s.documents.proposals == [] and s.ops.rows == {}


def test_revision_route_returns_202():
    import asyncio
    s = _svc()
    d, v = asyncio.run(_with_version(s, "hello world"))
    app = FastAPI()
    app.add_exception_handler(DomainError, domain_error_handler)
    app.include_router(router, prefix="/api/v1")
    app.add_middleware(_AsUser, user=ent.User(id=A, display_name="u", created_at=f.now()))
    app.state.deps = SimpleNamespace(documents=s)
    c = TestClient(app)
    body = {"expectedRevision": 2, "versionId": str(v.id), "action": "REWRITE",
            "selection": {"from": 0, "to": 5, "text": "hello"}}
    res = c.post(f"/api/v1/documents/{d.id}/revisions", json=body)
    assert res.status_code == 202, res.text
    assert res.json()["data"]["result"]["value"]["replacement"] == "hello"
    bad = c.post(f"/api/v1/documents/{d.id}/revisions", json={**body, "action": "NOPE"})
    assert bad.status_code == 400


async def test_mutable_lookup_outage_is_internal():
    s = _svc()
    s.documents = f.Boom()
    await _raises("INTERNAL", s.create_version(A, uuid4(), 1, _content(), [], ""))


# ---- export route -----------------------------------------------------------

def _export_client(s, user_id=A):
    app = FastAPI()
    app.add_exception_handler(DomainError, domain_error_handler)
    app.include_router(router, prefix="/api/v1")
    app.add_middleware(_AsUser, user=ent.User(id=user_id, display_name="u",
                                              created_at=f.now()))
    app.state.deps = SimpleNamespace(documents=s)
    return TestClient(app)


def _finalized(s):
    d = _doc(s, title="이력서")
    v = f.version(A, d, blocks_text=("Docx body line",))
    s.documents.versions[v.id] = v
    d.finalized_version_id = v.id
    d.status = ent.DOC_FINALIZED
    s.documents.put(d)
    return d, v


def test_export_route_docx_and_guards():
    import io
    import zipfile
    s = _svc()
    d, v = _finalized(s)
    url = f"/api/v1/documents/{d.id}/versions/{v.id}/export"
    c = _export_client(s)
    res = c.get(url, params={"format": "docx"})
    assert res.status_code == 200, res.text
    assert res.headers["content-type"].startswith("application/vnd.openxmlformats")
    assert "filename*=UTF-8''%EC%9D%B4%EB%A0%A5%EC%84%9C.docx" in res.headers["content-disposition"]
    body = zipfile.ZipFile(io.BytesIO(res.content)).read("word/document.xml").decode()
    assert "Docx body line" in body
    assert c.get(url, params={"format": "HTML"}).status_code == 400
    assert _export_client(s, B).get(url).status_code == 404
    draft = f.version(A, d, blocks_text=("draft",))
    s.documents.versions[draft.id] = draft
    res = c.get(f"/api/v1/documents/{d.id}/versions/{draft.id}/export")
    assert res.status_code == 422
    assert res.json()["error"]["code"] == "DOCUMENT_NOT_FINALIZED"
