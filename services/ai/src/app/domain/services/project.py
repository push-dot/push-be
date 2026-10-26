from __future__ import annotations
from app.clock import utcnow
from datetime import datetime
from typing import Optional
from uuid import UUID, uuid4

from app.db import DB, NotFoundError
from app.domain import entities as ent
from app.domain.errors import (
    invalid_transition, map_revision_err, not_found, plan_required,
    revision_conflict, validation_field,
)
from app.domain.services.ai import AIGate
from app.domain.services.approval import ApprovalService
from app.infrastructure.store_ai import AiUsageStore
from app.infrastructure.store_applications import ApplicationStore
from app.infrastructure.store_jobs import GapAnalysisStore
from app.infrastructure.store_operations import OperationStore
from app.infrastructure.store_projects import ProjectStore
from app.jsonutil import to_jsonable

RUN_VERIFYING = "VERIFYING"
RUN_VERIFIED = "VERIFIED"
RUN_FAILED = "FAILED"
PEV_PENDING = "PENDING"
PEV_VERIFIED = "VERIFIED"


def _now() -> datetime:
    return utcnow()


def blueprint_cap(plan: str | None) -> int | None:
    key = (plan or "FREE").strip().upper()
    if key == ent.PLAN_ULTRA:
        return None
    if key == ent.PLAN_PRO:
        return 20
    return 5


def build_blueprints(user_id: UUID, application_id: UUID, gap_analysis_id: UUID,
                     a: ent.GapAnalysis, now: datetime) -> list[ent.ProjectBlueprint]:
    gaps = list(a.missing) + list(a.preferred_missing) or ["general engineering practice"]
    out = []
    for i in range(4):
        skill = gaps[i % len(gaps)]
        out.append(ent.ProjectBlueprint(
            id=uuid4(), user_id=user_id, revision=1, application_id=application_id,
            gap_analysis_id=gap_analysis_id,
            title=f"Gap project {i + 1}: {skill}", skills=[skill],
            problem="Missing or unproven requirement: " + skill,
            solution="Build a small project that exercises " + skill,
            tasks=[ent.BlueprintTask(
                id="task-1", title="Implement core feature using " + skill,
                description="Create a minimal but working implementation",
                acceptance=["runs locally", "tests pass"])],
            completion_criteria=["committed to a remote repository",
                                 "tests pass in CI"],
            metrics=[ent.BlueprintMetric(name="test_coverage", unit="percent",
                                         measurement="coverage report", target=None)],
            estimated_effort=ent.EffortEstimate(min_hours=4, max_hours=16),
            state=ent.BLUEPRINT_DRAFT, created_at=now, updated_at=now))
    return out


class ProjectService:
    def __init__(self, db: DB, approvals: ApprovalService, ai: AIGate):
        self.db = db
        self.projects = ProjectStore(db)
        self.applications = ApplicationStore(db)
        self.analyses = GapAnalysisStore(db)
        self.approvals = approvals
        self.ops = OperationStore(db)
        self.locks = AiUsageStore(db)
        self.ai = ai

    async def generate_blueprints(self, user_id: UUID, application_id: UUID,
                                  gap_analysis_id: UUID,
                                  ai: Optional[ent.AiOptions]) -> ent.Operation:
        await self.ai.check(user_id, ai)
        try:
            user = await self.ai.users.get(user_id)
        except NotFoundError:
            raise not_found()
        cap = blueprint_cap(user.plan)
        op = None

        async def work():
            nonlocal op
            try:
                app = await self.applications.get(user_id, application_id)
            except NotFoundError:
                raise not_found()
            try:
                analysis = await self.analyses.get(user_id, gap_analysis_id)
            except Exception:
                raise not_found()
            if analysis.application_id != application_id:
                raise validation_field(
                    "gapAnalysisId", "analysis belongs to another application")
            now = _now()
            blueprints = build_blueprints(
                user_id, application_id, gap_analysis_id, analysis, now)
            # Without the lock two parallel requests both see the same count and pass the cap.
            await self.locks.lock_user(user_id)
            held = await self.projects.count_blueprints(user_id)
            if cap is not None and held + len(blueprints) > cap:
                raise plan_required("project blueprint limit reached")
            for b in blueprints:
                await self.projects.create_blueprint(b)
            op = ent.Operation(
                id=uuid4(), user_id=user_id, type=ent.OP_PROJECT_BLUEPRINTS,
                application_id=app.id, status=ent.OP_SUCCEEDED,
                result=ent.OperationResult(
                    kind=ent.OP_PROJECT_BLUEPRINTS,
                    value=[to_jsonable(b) for b in blueprints]),
                created_at=now, updated_at=now)
            await self.ops.create(op)

        await self.db.run(work)
        return op

    async def verify_evidence(self, user_id: UUID, project_id: UUID,
                              evidence_id: UUID, expected: int) -> ent.Operation:
        op = None

        async def work():
            nonlocal op
            try:
                e = await self.projects.get_evidence(user_id, project_id, evidence_id)
            except NotFoundError:
                raise not_found()
            if e.revision != expected:
                raise revision_conflict(e.revision)
            if e.status == PEV_VERIFIED:
                raise invalid_transition("evidence already verified")
            if e.test_results.exit_code != 0:
                raise invalid_transition("recorded tests failed")
            now = _now()
            e.status = PEV_VERIFIED
            e.verified_at = now
            e.updated_at = now
            try:
                await self.projects.update_evidence(e, expected)
            except Exception as err:
                raise map_revision_err(err)
            e.revision = expected + 1
            try:
                r = await self.projects.get_run(user_id, project_id, e.run_id)
            except NotFoundError:
                raise not_found()
            if r.state == RUN_VERIFYING:
                r.state = RUN_VERIFIED
                r.updated_at = now
                try:
                    await self.projects.update_run(r, r.revision)
                except Exception as err:
                    raise map_revision_err(err)
            try:
                b = await self.projects.get_blueprint(user_id, project_id)
            except NotFoundError:
                raise not_found()
            if b.state == ent.BLUEPRINT_IN_PROGRESS:
                b.state = ent.BLUEPRINT_VERIFIED
                b.updated_at = now
                try:
                    await self.projects.update_blueprint(b, b.revision)
                except Exception as err:
                    raise map_revision_err(err)
            op = ent.Operation(
                id=uuid4(), user_id=user_id, type=ent.OP_PROJECT_VERIFY,
                application_id=b.application_id, status=ent.OP_SUCCEEDED,
                result=ent.OperationResult(kind=ent.OP_PROJECT_VERIFY,
                                           value=to_jsonable(e)),
                created_at=now, updated_at=now)
            await self.ops.create(op)

        await self.db.run(work)
        return op
