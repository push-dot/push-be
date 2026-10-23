"""Live ProjectService paths: generate_blueprints (POST /projects/blueprints)
and verify_evidence (POST /projects/{id}/evidence/{eid}/verify)."""
from __future__ import annotations

from datetime import datetime, timezone
from uuid import uuid4

import pytest

from app.db import ConflictError, NotFoundError
from app.domain import entities as ent
from app.domain.errors import DomainError
from app.domain.services.project import (
    PEV_PENDING, PEV_VERIFIED, RUN_FAILED, RUN_VERIFIED, RUN_VERIFYING,
    ProjectService, blueprint_cap, build_blueprints,
)
from tests.stubs import FakeDB, StubOperationStore, StubUserStore

T0 = datetime(2026, 1, 1, tzinfo=timezone.utc)


def _code(info) -> str:
    assert isinstance(info.value, DomainError)
    return info.value.code


# ---------- pure helpers ----------

@pytest.mark.parametrize("plan,cap", [
    ("FREE", 5), (None, 5), ("", 5), (" pro ", 20), ("PRO", 20),
    ("ultra", None), ("unknown", 5),
])
def test_blueprint_cap_per_plan(plan, cap):
    assert blueprint_cap(plan) == cap


def _analysis(app_id, missing=(), preferred=()):
    return ent.GapAnalysis(
        id=uuid4(), user_id=uuid4(), application_id=app_id, job_id=uuid4(),
        job_revision=1, method="RULE_BASED", missing=list(missing),
        preferred_missing=list(preferred), created_at=T0)


def test_build_blueprints_cycles_required_then_preferred_gaps():
    user_id, app_id, gap_id = uuid4(), uuid4(), uuid4()
    out = build_blueprints(user_id, app_id, gap_id,
                           _analysis(app_id, ["go", "k8s"], ["rust"]), T0)
    assert [b.skills for b in out] == [["go"], ["k8s"], ["rust"], ["go"]]
    assert [b.title for b in out][0] == "Gap project 1: go"
    assert all(b.state == ent.BLUEPRINT_DRAFT and b.revision == 1 for b in out)
    assert all(b.user_id == user_id and b.application_id == app_id
               and b.gap_analysis_id == gap_id for b in out)
    assert len({b.id for b in out}) == 4


def test_build_blueprints_without_gaps_uses_general_practice():
    out = build_blueprints(uuid4(), uuid4(), uuid4(), _analysis(uuid4()), T0)
    assert len(out) == 4
    assert all(b.skills == ["general engineering practice"] for b in out)


# ---------- generate_blueprints ----------

class _Gate:
    def __init__(self, user, check_err=None):
        self.users = StubUserStore(user)
        self.check_err = check_err
        self.checked = []

    async def check(self, user_id, ai):
        self.checked.append((user_id, ai))
        if self.check_err is not None:
            raise self.check_err


class _Apps:
    def __init__(self, app):
        self.app = app

    async def get(self, user_id, id_):
        if self.app is None or self.app.id != id_ or self.app.user_id != user_id:
            raise NotFoundError()
        return self.app


class _Analyses:
    def __init__(self, analysis, err=None):
        self.analysis = analysis
        self.err = err

    async def get(self, user_id, id_):
        if self.err is not None:
            raise self.err
        if self.analysis is None or self.analysis.id != id_:
            raise NotFoundError()
        return self.analysis


class _Blueprints:
    def __init__(self, held=0):
        self.held = held
        self.created = []

    async def count_blueprints(self, user_id):
        return self.held

    async def create_blueprint(self, b):
        self.created.append(b)


def _gen_svc(*, user_present=True, check_err=None, analysis_app=None,
             analysis_err=None, held=0, plan="FREE"):
    user_id = uuid4()
    app = ent.Application(
        id=uuid4(), user_id=user_id, job_id=uuid4(), company="c", title="t",
        created_at=T0, updated_at=T0)
    analysis = _analysis(analysis_app or app.id, ["python"])
    user = ent.User(id=user_id, display_name="u", plan=plan, created_at=T0)
    gate = _Gate(user if user_present else None, check_err)
    svc = ProjectService(FakeDB(), None, gate)
    svc.applications = _Apps(app)
    svc.analyses = _Analyses(analysis, analysis_err)
    svc.projects = _Blueprints(held)
    svc.ops = StubOperationStore()
    return svc, user_id, app, analysis, gate


async def test_generate_blueprints_success_persists_and_reports_operation():
    svc, user_id, app, analysis, gate = _gen_svc()
    ai = ent.AiOptions(provider="OPENAI", model="m",
                       effort="LOW")
    op = await svc.generate_blueprints(user_id, app.id, analysis.id, ai)
    assert gate.checked == [(user_id, ai)]
    assert len(svc.projects.created) == 4
    assert op.type == ent.OP_PROJECT_BLUEPRINTS
    assert op.status == ent.OP_SUCCEEDED
    assert op.application_id == app.id and op.user_id == user_id
    assert op.result.kind == ent.OP_PROJECT_BLUEPRINTS
    assert [v["id"] for v in op.result.value] == [
        str(b.id) for b in svc.projects.created]
    assert svc.ops.created == [op]


async def test_generate_blueprints_gate_rejection_stops_before_any_write():
    svc, user_id, app, analysis, _ = _gen_svc(
        check_err=DomainError(403, "PLAN_REQUIRED", "nope"))
    with pytest.raises(DomainError) as e:
        await svc.generate_blueprints(user_id, app.id, analysis.id, None)
    assert _code(e) == "PLAN_REQUIRED"
    assert svc.projects.created == [] and svc.ops.created == []


async def test_generate_blueprints_unknown_user_is_not_found():
    svc, user_id, app, analysis, _ = _gen_svc(user_present=False)
    with pytest.raises(DomainError) as e:
        await svc.generate_blueprints(user_id, app.id, analysis.id, None)
    assert _code(e) == "NOT_FOUND"


async def test_generate_blueprints_other_users_application_is_not_found():
    svc, user_id, app, analysis, _ = _gen_svc()
    with pytest.raises(DomainError) as e:
        await svc.generate_blueprints(user_id, uuid4(), analysis.id, None)
    assert _code(e) == "NOT_FOUND"
    # tenant isolation: the owner's app id under another user id is hidden
    with pytest.raises(DomainError) as e:
        await svc.generate_blueprints(uuid4(), app.id, analysis.id, None)
    assert _code(e) == "NOT_FOUND"
    assert svc.projects.created == []


@pytest.mark.parametrize("err", [NotFoundError(), RuntimeError("db down")])
async def test_generate_blueprints_missing_analysis_is_not_found(err):
    svc, user_id, app, analysis, _ = _gen_svc(analysis_err=err)
    with pytest.raises(DomainError) as e:
        await svc.generate_blueprints(user_id, app.id, analysis.id, None)
    assert _code(e) == "NOT_FOUND"


async def test_generate_blueprints_rejects_analysis_of_another_application():
    svc, user_id, app, analysis, _ = _gen_svc(analysis_app=uuid4())
    with pytest.raises(DomainError) as e:
        await svc.generate_blueprints(user_id, app.id, analysis.id, None)
    assert _code(e) == "VALIDATION_ERROR"
    assert e.value.details == {"field": "gapAnalysisId"}
    assert svc.projects.created == [] and svc.ops.created == []


# ---------- verify_evidence ----------

class _VerifyStore:
    def __init__(self, evidence, run, blueprint):
        self.evidence, self.run, self.blueprint = evidence, run, blueprint
        self.ev_err = self.run_err = self.bp_err = None
        self.ev_updates, self.run_updates, self.bp_updates = [], [], []

    async def get_evidence(self, user_id, project_id, evidence_id):
        e = self.evidence
        if (e is None or e.id != evidence_id or e.user_id != user_id
                or e.project_id != project_id):
            raise NotFoundError()
        return e

    async def update_evidence(self, e, expected):
        if self.ev_err:
            raise self.ev_err
        self.ev_updates.append(expected)

    async def get_run(self, user_id, project_id, run_id):
        r = self.run
        if r is None or r.id != run_id or r.user_id != user_id:
            raise NotFoundError()
        return r

    async def update_run(self, r, expected):
        if self.run_err:
            raise self.run_err
        self.run_updates.append((r.state, expected))

    async def get_blueprint(self, user_id, project_id):
        b = self.blueprint
        if b is None or b.id != project_id or b.user_id != user_id:
            raise NotFoundError()
        return b

    async def update_blueprint(self, b, expected):
        if self.bp_err:
            raise self.bp_err
        self.bp_updates.append((b.state, expected))


def _verify_fixture(*, ev_status=PEV_PENDING, ev_rev=1, run_state=RUN_VERIFYING,
                    bp_state=ent.BLUEPRINT_IN_PROGRESS):
    user_id, project_id, run_id = uuid4(), uuid4(), uuid4()
    app_id = uuid4()
    e = ent.ProjectEvidence(
        id=uuid4(), user_id=user_id, revision=ev_rev, project_id=project_id,
        run_id=run_id, commit_url="https://example.test/c", status=ev_status,
        created_at=T0, updated_at=T0)
    r = ent.CliRun(
        id=run_id, user_id=user_id, revision=3, project_id=project_id,
        application_id=app_id, provider="CODEX", working_directory="/w",
        executable="codex", prompt="p", payload_hash="h", state=run_state,
        created_at=T0, updated_at=T0)
    b = ent.ProjectBlueprint(
        id=project_id, user_id=user_id, revision=7, application_id=app_id,
        gap_analysis_id=uuid4(), title="t", state=bp_state,
        created_at=T0, updated_at=T0)
    store = _VerifyStore(e, r, b)
    svc = ProjectService(FakeDB(), None, None)
    svc.projects = store
    svc.ops = StubOperationStore()
    return svc, store, user_id, project_id, e


async def test_verify_evidence_happy_path_advances_run_and_blueprint():
    svc, store, user_id, project_id, e = _verify_fixture(ev_rev=4)
    op = await svc.verify_evidence(user_id, project_id, e.id, 4)
    assert store.ev_updates == [4]
    assert e.status == PEV_VERIFIED and e.revision == 5
    assert e.verified_at is not None
    assert store.run_updates == [(RUN_VERIFIED, 3)]
    assert store.bp_updates == [(ent.BLUEPRINT_VERIFIED, 7)]
    assert op.application_id == store.blueprint.application_id
    assert op.type == ent.OP_PROJECT_VERIFY and op.status == ent.OP_SUCCEEDED
    assert op.result.value["status"] == PEV_VERIFIED
    assert op.result.value["revision"] == 5
    assert svc.ops.created == [op]


async def test_verify_evidence_leaves_settled_run_and_blueprint_alone():
    svc, store, user_id, project_id, e = _verify_fixture(
        run_state=RUN_FAILED, bp_state=ent.BLUEPRINT_VERIFIED)
    op = await svc.verify_evidence(user_id, project_id, e.id, 1)
    assert store.run.state == RUN_FAILED and store.run_updates == []
    assert store.blueprint.state == ent.BLUEPRINT_VERIFIED
    assert store.bp_updates == []
    assert op.status == ent.OP_SUCCEEDED


async def test_verify_evidence_unknown_or_foreign_evidence_is_not_found():
    svc, store, user_id, project_id, e = _verify_fixture()
    for uid, pid, eid in ((user_id, project_id, uuid4()),
                          (uuid4(), project_id, e.id),
                          (user_id, uuid4(), e.id)):
        with pytest.raises(DomainError) as err:
            await svc.verify_evidence(uid, pid, eid, 1)
        assert _code(err) == "NOT_FOUND"
    assert store.ev_updates == [] and svc.ops.created == []


async def test_verify_evidence_stale_revision_conflicts():
    svc, store, user_id, project_id, e = _verify_fixture(ev_rev=2)
    with pytest.raises(DomainError) as err:
        await svc.verify_evidence(user_id, project_id, e.id, 1)
    assert _code(err) == "REVISION_CONFLICT"
    assert err.value.details == {"currentRevision": 2}
    assert e.status == PEV_PENDING


async def test_verify_evidence_twice_is_invalid_transition():
    svc, store, user_id, project_id, e = _verify_fixture(ev_status=PEV_VERIFIED)
    with pytest.raises(DomainError) as err:
        await svc.verify_evidence(user_id, project_id, e.id, 1)
    assert _code(err) == "INVALID_TRANSITION"
    assert store.ev_updates == []


@pytest.mark.parametrize("which", ["ev", "run", "bp"])
@pytest.mark.parametrize("err,code", [
    (ConflictError(9), "REVISION_CONFLICT"), (NotFoundError(), "NOT_FOUND"),
])
async def test_verify_evidence_maps_store_write_errors(which, err, code):
    svc, store, user_id, project_id, e = _verify_fixture()
    setattr(store, which + "_err", err)
    with pytest.raises(DomainError) as info:
        await svc.verify_evidence(user_id, project_id, e.id, 1)
    assert _code(info) == code
    if code == "REVISION_CONFLICT":
        assert info.value.details == {"currentRevision": 9}
    assert svc.ops.created == []


async def test_verify_evidence_unexpected_write_error_propagates():
    svc, store, user_id, project_id, e = _verify_fixture()
    store.ev_err = RuntimeError("boom")
    with pytest.raises(RuntimeError):
        await svc.verify_evidence(user_id, project_id, e.id, 1)


@pytest.mark.parametrize("missing", ["run", "blueprint"])
async def test_verify_evidence_missing_run_or_blueprint_is_not_found(missing):
    svc, store, user_id, project_id, e = _verify_fixture()
    setattr(store, missing, None)
    with pytest.raises(DomainError) as err:
        await svc.verify_evidence(user_id, project_id, e.id, 1)
    assert _code(err) == "NOT_FOUND"
    assert svc.ops.created == []

