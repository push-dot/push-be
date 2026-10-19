from __future__ import annotations

from datetime import datetime, timezone
from uuid import uuid4

import pytest

from app.db import NotFoundError
from app.domain import entities as ent
from app.domain.services.project import (
    ProjectService, PEV_VERIFIED, RUN_VERIFIED, RUN_VERIFYING,
)
from tests.stubs import FakeDB, StubOperationStore


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
