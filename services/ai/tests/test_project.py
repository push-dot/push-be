from __future__ import annotations

from datetime import datetime, timezone
from uuid import uuid4

import pytest

from app.db import NotFoundError
from app.domain import entities as ent
from app.domain.errors import DomainError
from app.domain.services.project import (
    ProjectService, PEV_VERIFIED, RUN_VERIFIED, RUN_VERIFYING,
)
from app.infrastructure.store_projects import ProjectStore
from tests.stubs import FakeDB, StubOperationStore, StubUserStore


def _now():
    return datetime.now(timezone.utc)


class StubProjectStore:
    def __init__(self, evidence, run, blueprint):
        self.evidence = evidence
        self.run = run
        self.blueprint = blueprint

    async def get_evidence(self, user_id, project_id, evidence_id):
        if self.evidence.id != evidence_id:
            raise NotFoundError()
        return self.evidence

    async def update_evidence(self, e, expected):
        pass

    async def get_run(self, user_id, project_id, run_id):
        if self.run.id != run_id:
            raise NotFoundError()
        return self.run

    async def update_run(self, r, expected):
        pass

    async def get_blueprint(self, user_id, project_id):
        if self.blueprint.id != project_id:
            raise NotFoundError()
        return self.blueprint

    async def update_blueprint(self, b, expected):
        pass


def _svc(store):
    svc = ProjectService(FakeDB(), None, None)
    svc.projects = store
    svc.ops = StubOperationStore()
    return svc


async def test_verify_evidence_completes_state_transitions():
    user_id, project_id, run_id, evidence_id = (uuid4() for _ in range(4))
    e = ent.ProjectEvidence(
        id=evidence_id, user_id=user_id, project_id=project_id,
        run_id=run_id, commit_url="https://x", status="PENDING",
        created_at=_now(), updated_at=_now())
    run = ent.CliRun(
        id=run_id, user_id=user_id, project_id=project_id,
        application_id=uuid4(), provider="CLAUDE", working_directory="d",
        executable="x", prompt="p", payload_hash="h", state=RUN_VERIFYING,
        created_at=_now(), updated_at=_now())
    b = ent.ProjectBlueprint(
        id=project_id, user_id=user_id, application_id=uuid4(),
        gap_analysis_id=uuid4(), title="t",
        state=ent.BLUEPRINT_IN_PROGRESS, created_at=_now(), updated_at=_now())
    ops = StubOperationStore()
    svc = _svc(StubProjectStore(e, run, b))
    svc.ops = ops

    op = await svc.verify_evidence(user_id, project_id, evidence_id, 1)

    assert e.status == PEV_VERIFIED and e.verified_at is not None
    assert run.state == RUN_VERIFIED
    assert b.state == ent.BLUEPRINT_VERIFIED
    assert op.type == ent.OP_PROJECT_VERIFY
    assert op.status == ent.OP_SUCCEEDED
    assert ops.created == [op]


class _Projects:
    def __init__(self, held: int):
        self.held = held
        self.created = []

    async def count_blueprints(self, user_id):
        return self.held

    async def create_blueprint(self, blueprint):
        self.created.append(blueprint)


class _Gate:
    def __init__(self, plan):
        self.users = StubUserStore(ent.User(
            id=uuid4(), provider="dev", provider_subject="d",
            display_name="d", created_at=_now(), plan=plan or "FREE"))

    async def check(self, *args, **kwargs):
        return None


def _blueprint_service(plan, held: int):
    user_id = uuid4()
    app_id = uuid4()
    now = _now()
    app = ent.Application(
        id=app_id, user_id=user_id, job_id=uuid4(), company="c", title="t",
        created_at=now, updated_at=now)
    analysis = ent.GapAnalysis(
        id=uuid4(), user_id=user_id, application_id=app_id, job_id=app.job_id,
        job_revision=1, method="RULE_BASED", missing=["python"], created_at=now)
    projects = _Projects(held)
    gate = _Gate(plan if plan is not None else "FREE")
    if plan is None:
        gate.users.user.plan = None
    svc = ProjectService(FakeDB(), None, gate)
    svc.projects = projects
    svc.ops = StubOperationStore()

    class _Apps:
        async def get(self, user_id, id_):
            return app

    class _Analyses:
        async def get(self, user_id, id_):
            return analysis

    svc.applications = _Apps()
    svc.analyses = _Analyses()
    return svc, user_id, app_id, analysis.id, projects


async def test_generate_blueprints_rejects_batch_over_free_cap():
    svc, user_id, app_id, gap_id, projects = _blueprint_service("FREE", 2)
    with pytest.raises(DomainError) as err:
        await svc.generate_blueprints(user_id, app_id, gap_id, None)
    assert err.value.status == 403
    assert err.value.code == "PLAN_REQUIRED"
    assert projects.created == []


async def test_generate_blueprints_allows_batch_that_lands_on_free_cap():
    svc, user_id, app_id, gap_id, projects = _blueprint_service("FREE", 1)
    op = await svc.generate_blueprints(user_id, app_id, gap_id, None)
    assert len(projects.created) == 4
    assert op.status == ent.OP_SUCCEEDED


async def test_generate_blueprints_null_plan_uses_free_cap():
    svc, user_id, app_id, gap_id, projects = _blueprint_service(None, 2)
    with pytest.raises(DomainError) as err:
        await svc.generate_blueprints(user_id, app_id, gap_id, None)
    assert err.value.code == "PLAN_REQUIRED"
    assert projects.created == []


async def test_generate_blueprints_pro_cap_and_ultra_unlimited():
    blocked, user_id, app_id, gap_id, projects = _blueprint_service("PRO", 17)
    with pytest.raises(DomainError) as err:
        await blocked.generate_blueprints(user_id, app_id, gap_id, None)
    assert err.value.code == "PLAN_REQUIRED"
    assert projects.created == []
    allowed, user_id, app_id, gap_id, projects = _blueprint_service("ULTRA", 100)
    await allowed.generate_blueprints(user_id, app_id, gap_id, None)
    assert len(projects.created) == 4


async def test_count_blueprints_excludes_archived():
    class _DB:
        def __init__(self):
            self.sql = ""
            self.args = ()

        def q(self):
            return self

        async def fetchval(self, sql, *args):
            self.sql = sql
            self.args = args
            return 3

    db = _DB()
    count = await ProjectStore(db).count_blueprints(uuid4())
    assert count == 3
    assert "state <> $2" in db.sql
    assert db.args[-1] == ent.BLUEPRINT_ARCHIVED
