"""EvidenceService paths that are live: career-evidence import (+ its
NEEDS_INPUT completion), source text extraction, list/get. create/archive
moved to core and are not exercised here."""
from __future__ import annotations

from types import SimpleNamespace
from uuid import uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.errors import domain_error_handler
from app.api.routers.evidence import router
from app.domain import entities as ent
from app.domain.errors import DomainError
from app.domain.pagination import PageRequest
from app.domain.services.evidence import EvidenceService
from app.domain.validators import hash_bytes
from tests import test_cov_svc_fakes as f
from tests.test_cov_svc_approval import _AsUser

A, B = uuid4(), uuid4()


def _svc():
    s = EvidenceService(f.FakeDB())
    s.evidence = f.EvidenceStore()
    s.sources = f.SourceStore()
    s.ops = f.OperationStore()
    return s


async def _raises(code, aw):
    with pytest.raises(DomainError) as e:
        await aw
    assert e.value.code == code, e.value
    return e.value


async def test_import_with_full_details_creates_owned_evidence():
    s = _svc()
    op = await s.import_(A, None, "Led 3 engineers", "https://x.dev/cv", "sha-1",
                         "TEXT", "CAREER", "Lead")
    assert op.status == ent.OP_SUCCEEDED and op.type == ent.OP_EVIDENCE_IMPORT
    assert op.input_request is None
    [ev] = op.result.value["evidence"]
    stored = await s.evidence.get(A, ev["id"])
    assert stored.title == "Lead" and stored.kind == "CAREER"
    assert stored.source_url == "https://x.dev/cv"
    assert stored.provenance.content_hash == "sha-1"
    assert stored.provenance.source_location.end == len("Led 3 engineers")
    assert stored.verification_status == ent.VERIFICATION_USER_PROVIDED
    await _raises("NOT_FOUND", s.get(B, stored.id))
    assert (await s.ops.get(A, op.id)).status == ent.OP_SUCCEEDED


async def test_import_without_hash_hashes_text():
    s = _svc()
    op = await s.import_(A, None, "abc", None, "", "MARKDOWN", "SKILL", "t")
    ev = await s.evidence.get(A, op.result.value["evidence"][0]["id"])
    assert ev.provenance.content_hash == hash_bytes(b"abc")


async def test_import_missing_details_asks_for_input_and_creates_nothing():
    s = _svc()
    op = await s.import_(A, None, "", None, "", "TEXT", "NOT_A_KIND", "")
    assert op.status == ent.OP_NEEDS_INPUT and op.result is None
    assert op.input_request.code == "IMPORT_DETAILS_REQUIRED"
    assert [x.name for x in op.input_request.fields] == ["text", "kind", "title"]
    assert s.evidence.rows == {}
    assert (await s.ops.get(A, op.id)).pending_payload["kind"] == "NOT_A_KIND"


@pytest.mark.parametrize("fmt,url,code", [
    ("HTML", None, "VALIDATION_ERROR"),
    ("GITHUB", None, "INTEGRATION_REQUIRED"),
    ("TEXT", "ftp://x", "VALIDATION_ERROR"),
    ("TEXT", "https://u:p@x.dev", "VALIDATION_ERROR"),
])
async def test_import_rejects_bad_input(fmt, url, code):
    s = _svc()
    await _raises(code, s.import_(A, None, "t", url, "", fmt, "CAREER", "t"))
    assert s.ops.rows == {}


@pytest.mark.parametrize("mime,name", [
    ("text/plain", "cv.bin"),
    ("application/octet-stream", "cv.MD"),
    ("application/octet-stream", "cv.txt"),
])
async def test_import_reads_text_sources(mime, name):
    s = _svc()
    src = s.sources.add(A, "경력 10년".encode(), mime=mime, name=name)
    op = await s.import_(A, src.id, "", None, "", "TEXT", "RESUME", "CV")
    assert op.result.value["evidence"][0]["sourceText"] == "경력 10년"


async def test_import_explicit_text_wins_over_source():
    s = _svc()
    src = s.sources.add(B, b"other", mime="text/plain")  # not even readable by A
    op = await s.import_(A, src.id, "mine", None, "", "TEXT", "RESUME", "CV")
    assert op.result.value["evidence"][0]["sourceText"] == "mine"


async def test_import_pdf_source_uses_pdf_extractor(monkeypatch):
    import app.ingest.pdf_text as pdf
    seen = []
    monkeypatch.setattr(pdf, "extract_pdf_bytes",
                        lambda data: seen.append(data) or "from pdf")
    s = _svc()
    src = s.sources.add(A, b"%PDF-1.4", mime="application/pdf", name="cv.pdf")
    op = await s.import_(A, src.id, "", None, "", "PDF", "RESUME", "CV")
    assert seen == [b"%PDF-1.4"]
    assert op.result.value["evidence"][0]["sourceText"] == "from pdf"


async def test_source_text_errors():
    s = _svc()
    other = s.sources.add(B, b"x")
    err = await _raises("VALIDATION_ERROR", s._source_text(A, other.id))
    assert err.details == {"field": "sourceId"}
    img = s.sources.add(A, b"\x89PNG", mime="image/png", name="a.png")
    err = await _raises("VALIDATION_ERROR", s._source_text(A, img.id))
    assert "image/png" in err.message


async def test_source_text_outages_are_internal(monkeypatch):
    import app.ingest.pdf_text as pdf

    def broken(data):
        raise ValueError("corrupt pdf")
    monkeypatch.setattr(pdf, "extract_pdf_bytes", broken)
    s = _svc()
    src = s.sources.add(A, b"x", mime="application/pdf")
    await _raises("INTERNAL", s._source_text(A, src.id))
    s.sources = f.Boom()
    await _raises("INTERNAL", s._source_text(A, src.id))


async def test_complete_import_input_rejects_unrequested_fields():
    s = _svc()
    op = await s.import_(A, None, "text", None, "", "TEXT", "", "")
    assert [x.name for x in op.input_request.fields] == ["kind", "title"]
    err = await _raises("VALIDATION_ERROR",
                        s.complete_import_input(op, {"text": "overwrite"}))
    assert err.details == {"field": "fields.text"}


async def test_complete_import_input_finishes_import():
    s = _svc()
    op = await s.import_(A, None, "text", None, "", "TEXT", "", "")
    await s.complete_import_input(op, {"kind": "PROJECT", "title": "Side"})
    assert op.status == ent.OP_SUCCEEDED
    ev = await s.evidence.get(A, op.result.value["evidence"][0]["id"])
    assert (ev.kind, ev.title, ev.source_text) == ("PROJECT", "Side", "text")


async def test_list_and_get_are_scoped_and_map_outages():
    s = _svc()
    mine = s.evidence.put(f.evidence(A))
    s.evidence.put(f.evidence(B))
    assert [e.id for e in (await s.list(A, None, "", PageRequest())).items] == [mine.id]
    assert (await s.get(A, mine.id)).id == mine.id
    await _raises("NOT_FOUND", s.get(B, mine.id))
    s.evidence = f.Boom()
    await _raises("INTERNAL", s.get(A, mine.id))
    await _raises("INTERNAL", s.list(A, None, "", PageRequest()))


# ---- router -----------------------------------------------------------------

def _client(svc, user_id=A):
    app = FastAPI()
    app.add_exception_handler(DomainError, domain_error_handler)
    app.include_router(router, prefix="/api/v1")
    app.add_middleware(_AsUser, user=ent.User(id=user_id, display_name="u",
                                              created_at=f.now()))
    app.state.deps = SimpleNamespace(evidence=svc, sources=svc.sources)
    return TestClient(app)


def test_import_route_returns_202_operation():
    s = _svc()
    body = {"text": "Go", "contentHash": "", "format": "TEXT", "kind": "SKILL",
            "title": "Go"}
    res = _client(s).post("/api/v1/career-evidence/import", json=body)
    assert res.status_code == 202, res.text
    data = res.json()["data"]
    assert data["status"] == "SUCCEEDED" and "pendingPayload" not in data
    bad = _client(s).post("/api/v1/career-evidence/import", json={**body, "format": "X"})
    assert bad.status_code == 400


def test_profile_draft_route_unknown_source_is_404():
    res = _client(_svc()).get(f"/api/v1/sources/{uuid4()}/profile-draft")
    assert res.status_code == 404


@pytest.mark.xfail(strict=True, reason=(
    "BUG: import_/_progress_import never apply validate_evidence_input, so the "
    "1-200 char title limit enforced by evidence create (here and in core-api "
    "routes/evidence.ts:111) is bypassed by POST /career-evidence/import"))
async def test_import_enforces_the_evidence_title_limit():
    s = _svc()
    try:
        op = await s.import_(A, None, "text", None, "", "TEXT", "CAREER", "x" * 201)
    except DomainError as e:
        assert e.code == "VALIDATION_ERROR"
    else:
        assert op.status != ent.OP_SUCCEEDED
    assert s.evidence.rows == {}
