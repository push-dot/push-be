from __future__ import annotations
from datetime import datetime, timezone
from typing import Optional
from uuid import UUID, uuid4

from app.jsonutil import to_jsonable

from app.db import DB, NotFoundError
from app.domain import entities as ent
from app.domain.errors import not_found, validation_field
from app.domain.pagination import PageRequest
from app.domain.services.application import ApplicationService
from app.domain.services.approval import ApprovalService
from app.domain.services.document import DocumentService
from app.domain.services.evidence import EvidenceService
from app.domain.services.job import JobService
from app.infrastructure.store_operations import OperationStore


def _now() -> datetime:
    return datetime.now(timezone.utc)


class ResumeWorkflowService:
    def __init__(self, db: DB, applications: ApplicationService,
                 jobs: JobService, documents: DocumentService,
                 evidence: EvidenceService, approvals: ApprovalService):
        self.db = db
        self.applications = applications
        self.jobs = jobs
        self.documents = documents
        self.evidence = evidence
        self.approvals = approvals
        self.ops = OperationStore(db)

    async def _evidence_pool(self, user_id: UUID) -> list[ent.CareerEvidence]:
        page = await self.evidence.list(user_id, None, "", PageRequest(limit=100))
        return [e for e in page.items if not e.archived]

    async def _approve(self, user_id: UUID, kind: str, application_id: UUID,
                       target_id: UUID) -> ent.Approval:
        a = await self.approvals.create(
            user_id, kind, application_id, target_id, None)
        return await self.approvals.decide(
            user_id, a.id, a.revision, ent.APPROVAL_APPROVED)

    async def run(self, user_id: UUID, application_id: UUID,
                  ai: Optional[ent.AiOptions]) -> ent.Operation:
        try:
            app = await self.applications.get(user_id, application_id)
        except NotFoundError:
            raise not_found()
        try:
            j = await self.jobs.get(user_id, app.job_id)
        except NotFoundError:
            raise not_found()
        pool = await self._evidence_pool(user_id)
        if not pool:
            raise validation_field(
                "evidenceIds", "이력서/근거를 먼저 등록하세요")
        for e in pool:
            try:
                await self.approvals.require_evidence_use(
                    user_id, app.id, e.id)
            except Exception:
                await self._approve(
                    user_id, ent.APPROVAL_EVIDENCE_USE, app.id, e.id)
        eids = [e.id for e in pool]
        analyze_op = await self.jobs.analyze(
            user_id, j.id, app.id, j.revision, eids, ai)
        analysis = analyze_op.result.value
        title = app.company + " " + app.title + " 이력서"
        d = await self.documents.create(
            user_id, app.id, title, "RESUME", "CLASSIC", "ko")
        gen_op = await self.documents.generate(
            user_id, d.id, d.revision, eids, analysis["id"], ai, None)
        doc = gen_op.result.value["document"]
        version = gen_op.result.value["version"]
        fa = await self._approve(
            user_id, ent.APPROVAL_DOCUMENT_FINALIZE, app.id, version["id"])
        d = await self.documents.finalize(
            user_id, d.id, doc["revision"], version["id"], fa.id)
        export = await self.documents.create_export(
            user_id, d.id, version["id"], "PDF", "v1")
        now = _now()
        op = ent.Operation(
            id=uuid4(), user_id=user_id, type=ent.OP_RESUME_WORKFLOW,
            application_id=app.id, status=ent.OP_SUCCEEDED,
            result=ent.OperationResult(
                kind=ent.OP_RESUME_WORKFLOW,
                value={
                    "analysisId": analysis["id"],
                    "fitScore": analysis.get("fitScore"),
                    "document": to_jsonable(d),
                    "version": version,
                    "export": to_jsonable(export),
                }),
            created_at=now, updated_at=now)

        async def work():
            await self.ops.create(op)

        await self.db.do(work)
        return op
