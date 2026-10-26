from __future__ import annotations
from app.clock import utcnow
from datetime import datetime
from typing import Optional
from uuid import UUID, uuid4

from app.db import DB, NotFoundError
from app.domain import entities as ent
from app.domain.errors import internal, not_found
from app.domain.services.approval import ApprovalService
from app.infrastructure.store_applications import ApplicationStore
from app.infrastructure.store_jobs import JobStore

def _now() -> datetime:
    return utcnow()


class ApplicationService:
    # approvals/adapters served submissions, which moved to core; main.py still passes them.
    def __init__(self, db: DB, approvals: ApprovalService, adapters: dict):
        self.db = db
        self.applications = ApplicationStore(db)
        self.jobs = JobStore(db)

    async def list(self, user_id: UUID, stage: Optional[str], query: str, page):
        try:
            return await self.applications.list(user_id, stage, query, page)
        except Exception:
            raise internal()

    async def get(self, user_id: UUID, id_: UUID) -> ent.Application:
        try:
            return await self.applications.get(user_id, id_)
        except NotFoundError:
            raise not_found()
        except Exception:
            raise internal()

    async def create(self, user_id: UUID, job_id: UUID, notes: str) -> ent.Application:
        try:
            j = await self.jobs.get(user_id, job_id)
        except NotFoundError:
            raise not_found()
        except Exception:
            raise internal()
        now = _now()
        a = ent.Application(
            id=uuid4(), user_id=user_id, revision=1, job_id=job_id, company=j.company,
            title=j.title, stage="DISCOVERED", notes=notes, created_at=now, updated_at=now)
        try:
            await self.applications.create(a)
        except Exception:
            raise internal()
        return a
