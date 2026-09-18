from __future__ import annotations

from datetime import datetime, timezone
from uuid import uuid4

from app.domain import entities as ent
from app.domain.pagination import Page
from app.domain.services.resume_workflow import ResumeWorkflowService
from tests.stubs import FakeDB, StubOperationStore


def _now():
    return datetime.now(timezone.utc)


def _app(job_id):
    return ent.Application(id=uuid4(), user_id=uuid4(), job_id=job_id,
                           company="Acme", title="BE", created_at=_now(),
                           updated_at=_now())


def _op(kind, value):
    now = _now()
    return ent.Operation(
        id=uuid4(), user_id=uuid4(), type=kind, application_id=None,
        status=ent.OP_SUCCEEDED,
        result=ent.OperationResult(kind=kind, value=value),
        created_at=now, updated_at=now)


class _Apps:
    def __init__(self, app):
        self.app = app

    async def get(self, user_id, id_):
        return self.app


class _Jobs:
    def __init__(self, job):
        self.job = job

    async def get(self, user_id, id_):
        return self.job

    async def analyze(self, user_id, job_id, app_id, expected, eids, ai):
        return _op(ent.OP_JOB_ANALYSIS,
                   {"id": uuid4(), "fitScore": 80})


class _Evidence:
    def __init__(self, items):
        self.items = items

    async def list(self, user_id, kind, query, page):
        return Page(items=self.items)


class _Approvals:
    def __init__(self):
        self.required = []

    async def require_evidence_use(self, user_id, app_id, eid):
        self.required.append(eid)
        raise RuntimeError("not approved")

    async def create(self, user_id, kind, app_id, target_id, rev):
        return ent.Approval(
            id=uuid4(), user_id=user_id, revision=1, kind=kind,
            application_id=app_id, target_id=target_id, payload_hash="h",
            status=ent.APPROVAL_PENDING,
            expires_at=_now(), created_at=_now(), updated_at=_now())

    async def decide(self, user_id, id_, expected, decision):
        return ent.Approval(
            id=id_, user_id=user_id, revision=2, kind="",
            application_id=uuid4(), target_id=uuid4(), payload_hash="h",
            status=decision, expires_at=_now(),
            created_at=_now(), updated_at=_now())


class _Documents:
    async def create(self, user_id, app_id, title, kind, template, language):
        return ent.Document(
            id=uuid4(), user_id=user_id, revision=1, application_id=app_id,
            title=title, kind=kind, template=template, language=language,
            created_at=_now(), updated_at=_now())

    async def generate(self, user_id, doc_id, expected, eids, analysis_id,
                       ai, language):
        return _op(ent.OP_DOCUMENT_GENERATE, {
            "document": {"id": doc_id, "revision": 2},
            "version": {"id": uuid4(), "number": 1}})

    async def finalize(self, user_id, doc_id, expected, version_id, aid):
        d = ent.Document(
            id=doc_id, user_id=user_id, revision=3, application_id=uuid4(),
            title="t", kind="RESUME", template="CLASSIC", language="ko",
            status=ent.DOC_FINALIZED, created_at=_now(), updated_at=_now())
        d.finalized_version_id = version_id
        return d

    async def create_export(self, user_id, doc_id, version_id, fmt, rv):
        return ent.DocumentExport(
            id=uuid4(), user_id=user_id, document_id=doc_id,
            version_id=version_id, format=fmt, template="CLASSIC",
            language="ko", content={}, blocks=[], content_hash="h",
            status="READY_TO_RENDER", renderer_version=rv,
            created_at=_now(), updated_at=_now())


async def test_resume_workflow_chains_pipeline():
    job_id = uuid4()
    app = _app(job_id)
    ev = ent.CareerEvidence(
        id=uuid4(), user_id=uuid4(), kind="RESUME", title="r",
        source_text="text", source_url=None, skills=[],
        verification_status="USER_PROVIDED",
        created_at=_now(), updated_at=_now())
    svc = ResumeWorkflowService(
        FakeDB(), _Apps(app), _Jobs(ent.JobPosting(
            id=job_id, user_id=uuid4(), revision=1, company="Acme",
            title="BE", source_kind="MANUAL", source_url=None,
            source_text="t", requirements=["py"], preferred=[],
            keywords=[], risks=[], deadline=None, language="ko",
            created_at=_now(), updated_at=_now())),
        _Documents(), _Evidence([ev]), _Approvals())
    svc.ops = StubOperationStore()
    op = await svc.run(app.user_id, app.id, None)
    v = op.result.value
    assert v["fitScore"] == 80
    assert v["version"]["number"] == 1
    assert v["export"]["status"] == "READY_TO_RENDER"
