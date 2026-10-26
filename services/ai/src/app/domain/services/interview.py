from __future__ import annotations
from app.clock import utcnow
from datetime import datetime
from typing import Optional
from uuid import UUID, uuid4

from app.db import DB, NotFoundError
from app.domain import entities as ent
from app.domain.errors import internal, not_found, revision_conflict
from app.domain.services.ai import AIGate
from app.domain.content import code_point_slice
from app.domain.validators import code_point_len
from app.infrastructure.store_applications import ApplicationStore
from app.infrastructure.store_calendar import InterviewStore
from app.infrastructure.store_evidence import EvidenceStore
from app.infrastructure.store_jobs import JobStore
from app.infrastructure.store_operations import OperationStore
from app.jsonutil import _ts


def _now() -> datetime:
    return utcnow()


class InterviewService:
    def __init__(self, db: DB, ai: AIGate):
        self.db = db
        self.interviews = InterviewStore(db)
        self.applications = ApplicationStore(db)
        self.jobs = JobStore(db)
        self.evidence = EvidenceStore(db)
        self.ops = OperationStore(db)
        self.ai = ai

    async def prepare(self, user_id: UUID, id_: UUID, expected: int,
                      ai: Optional[ent.AiOptions]) -> ent.Operation:
        await self.ai.check(user_id, ai)
        op = None

        async def work():
            nonlocal op
            try:
                v = await self.interviews.get(user_id, id_)
            except NotFoundError:
                raise not_found()
            if v.revision != expected:
                raise revision_conflict(v.revision)
            try:
                app = await self.applications.get(user_id, v.application_id)
                job = await self.jobs.get(user_id, app.job_id)
            except Exception:
                raise internal()
            eids = [str(e) for e in v.evidence_ids]
            questions = [
                {"question": "Describe your experience with: " + req,
                 "requirement": req, "evidenceIds": eids}
                for req in job.requirements
            ]
            star_answers = []
            for eid in v.evidence_ids:
                try:
                    e = await self.evidence.get(user_id, eid)
                except NotFoundError:
                    raise not_found()
                star_answers.append({
                    "evidenceIds": [str(eid)], "situation": e.title,
                    "task": "", "action": "", "result": "",
                    "needsInput": ["task", "action", "result"]})
            research = []
            for cs in v.company_sources:
                claim = cs.source_text
                if code_point_len(claim) > 200:
                    claim = code_point_slice(claim, 0, 200)
                research.append({
                    "claim": claim, "sourceUrl": cs.source_url,
                    "accessedAt": _ts(cs.accessed_at),
                    "verificationStatus": ent.VERIFICATION_USER_PROVIDED})
            now = _now()
            op = ent.Operation(
                id=uuid4(), user_id=user_id, type=ent.OP_INTERVIEW_PREPARE,
                application_id=v.application_id, status=ent.OP_SUCCEEDED,
                result=ent.OperationResult(
                    kind=ent.OP_INTERVIEW_PREPARE,
                    value={"questions": questions, "starAnswers": star_answers,
                           "research": research}),
                created_at=now, updated_at=now)
            await self.ops.create(op)

        await self.db.run(work)
        return op
