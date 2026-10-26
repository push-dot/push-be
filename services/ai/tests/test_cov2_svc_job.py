"""JobService live paths: create (chat graph), get (resume workflow), analyze."""
from __future__ import annotations

from datetime import timedelta
from uuid import uuid4

import pytest

from app.domain import entities as ent
from app.domain.errors import DomainError, feature_disabled
from app.domain.services.approval import ApprovalService
from app.domain.services.job import JobService, part_scores
from tests import test_cov_svc_fakes as f

A, B = uuid4(), uuid4()


class _Analyses:
    def __init__(self):
        self.created, self.staled = [], []

    async def mark_stale_for_job(self, user_id, job_id, except_id):
        self.staled.append((user_id, job_id))

    async def create(self, a):
        self.created.append(a)


class _Jobs(f.OwnedStore):
    def __init__(self, err=None):
        super().__init__()
        self.err = err

    async def get(self, user_id, id_):
        if self.err:
            raise self.err
        return await super().get(user_id, id_)

    async def create(self, j):
        if self.err:
            raise self.err
        self.put(j)


class _Query:
    """Savepoint statements; ``fail`` maps a SQL prefix to an error."""

    def __init__(self, fail=()):
        self.fail = set(fail)
        self.sql = []

    async def execute(self, sql, *args):
        self.sql.append(sql)
        if any(sql.startswith(p) for p in self.fail):
            raise RuntimeError(sql)
        return "OK"


class _DB(f.FakeDB):
    def __init__(self, query=None):
        super().__init__()
        self.query = query or _Query()

    def q(self):
        return self.query


class _Samples:
    def __init__(self, ctx=None, err=None):
        self.ctx, self.err, self.inserted = ctx, err, []

    async def context(self, user_id):
        return self.ctx

    async def insert(self, *args):
        if self.err:
            raise self.err
        self.inserted.append(args)


def _svc(gate_err=None, query=None, samples=None, jobs=None):
    approvals = ApprovalService(f.FakeDB())
    approvals.approvals = f.ApprovalStore()
    gate = f.AIGate(gate_err)
    s = JobService(_DB(query), approvals, gate)
    s.jobs = jobs or _Jobs()
    s.applications = f.ApplicationStore()
    s.evidence = f.EvidenceStore()
    s.analyses = _Analyses()
    s.samples = samples or _Samples()
    s.ops = f.OperationStore()
    return s


def _seed(s, user=A, evidence_texts=("Built Go services with SQL",),
          approve=True):
    j = f.job(user, requirements=("Go backend", "SQL tuning", "Kotlin"))
    j.preferred = ["Rust experience"]
    j.keywords = ["Go", ""]
    s.jobs.put(j)
    app = f.application(user, job_id=j.id)
    s.applications.put(app)
    ids = []
    for text in evidence_texts:
        e = f.evidence(user, text, skills=["Go"])
        s.evidence.put(e)
        ids.append(e.id)
        if approve:
            s.approvals.approvals.put(f.approval(
                user, target_id=e.id, application_id=app.id,
                status=ent.APPROVAL_APPROVED))
    return j, app, ids


async def _code(aw) -> DomainError:
    with pytest.raises(DomainError) as e:
        await aw
    return e.value


# ---- create / get ---------------------------------------------------------

@pytest.mark.parametrize("args,field", [
    (("", "t", "TEXT", None, "x"), "company"),
    (("c" * 201, "t", "TEXT", None, "x"), "company"),
    (("c", "", "TEXT", None, "x"), "title"),
    (("c", "t" * 301, "TEXT", None, "x"), "title"),
    (("c", "t", "PDF", None, "x"), "sourceKind"),
    (("c", "t", "URL", None, "x"), "sourceUrl"),
    (("c", "t", "URL", "ftp://example.com/job", "x"), "sourceUrl"),
    (("c", "t", "URL", "https://u:p@example.com/job", "x"), "sourceUrl"),
    (("c", "t", "TEXT", None, ""), "sourceText"),
    (("c", "t", "TEXT", None, "x" * 200001), "sourceText"),
])
async def test_create_validates_input_and_writes_nothing(args, field):
    s = _svc()
    err = await _code(s.create(A, *args, [], [], None, "ko"))
    assert (err.code, err.details) == ("VALIDATION_ERROR", {"field": field})
    assert s.jobs.rows == {}


async def test_create_persists_a_fresh_owned_posting():
    s = _svc()
    j = await s.create(A, "Acme", "BE", "URL", "https://acme.dev/jobs/1",
                       "posting", ["Go"], None, None, "ko")
    assert (j.user_id, j.revision, j.requirements, j.preferred) == (
        A, 1, ["Go"], [])
    assert (await s.get(A, j.id)).source_url == "https://acme.dev/jobs/1"
    assert (await _code(s.get(B, j.id))).code == "NOT_FOUND"


async def test_create_and_get_map_store_failures_to_internal():
    s = _svc(jobs=_Jobs(err=RuntimeError("db")))
    assert (await _code(s.create(A, "c", "t", "TEXT", None, "x", [], [], None,
                                 "ko"))).code == "INTERNAL"
    assert (await _code(s.get(A, uuid4()))).code == "INTERNAL"


# ---- analyze --------------------------------------------------------------

async def test_analyze_records_gap_analysis_and_operation():
    s = _svc()
    j, app, ids = _seed(s)
    op = await s.analyze(A, j.id, app.id, j.revision, ids, None)
    assert op.status == ent.OP_SUCCEEDED and op.application_id == app.id
    (analysis,) = s.analyses.created
    assert analysis.method == ent.METHOD_RULE_BASED
    assert [m.requirement for m in analysis.matched] == [
        "Go backend", "SQL tuning"]
    assert analysis.missing == ["Kotlin"]
    assert analysis.preferred_missing == ["Rust experience"]
    assert analysis.fit_score == 66
    assert analysis.part_scores["techStack"] == 50  # "" keyword never hits
    assert s.analyses.staled == [(A, j.id)]
    assert s.ops.rows[op.id].result.value["fitScore"] == 66


async def test_analyze_with_ai_marks_ai_assisted_after_the_gate():
    s = _svc()
    j, app, ids = _seed(s)
    ai = ent.AiOptions(provider="OPENAI", model="m",
                       effort="LOW")
    await s.analyze(A, j.id, app.id, 1, ids, ai)
    assert s.ai.checked == [(A, ai)]
    assert s.analyses.created[0].method == ent.METHOD_AI_ASSISTED


async def test_analyze_gate_rejection_writes_nothing():
    s = _svc(gate_err=feature_disabled("limit"))
    j, app, ids = _seed(s)
    assert (await _code(s.analyze(A, j.id, app.id, 1, ids, None))
            ).code == "FEATURE_DISABLED"
    assert s.analyses.created == [] and s.ops.rows == {}


async def test_analyze_cannot_touch_another_users_job_or_application():
    s = _svc()
    j, app, ids = _seed(s, user=A)
    assert (await _code(s.analyze(B, j.id, app.id, 1, [], None))
            ).code == "NOT_FOUND"
    j_b, _, _ = _seed(s, user=B)
    # B's own job, A's application: still NOT_FOUND, never a leak.
    assert (await _code(s.analyze(B, j_b.id, app.id, 1, [], None))
            ).code == "NOT_FOUND"
    assert s.analyses.created == []


async def test_analyze_stale_revision_conflicts():
    s = _svc()
    j, app, ids = _seed(s)
    err = await _code(s.analyze(A, j.id, app.id, 7, ids, None))
    assert err.code == "REVISION_CONFLICT"
    assert s.analyses.created == []


async def test_analyze_rejects_application_of_another_job():
    s = _svc()
    j, _, ids = _seed(s)
    other = f.application(A)
    s.applications.put(other)
    err = await _code(s.analyze(A, j.id, other.id, 1, ids, None))
    assert err.details == {"field": "applicationId"}


async def test_analyze_rejects_missing_foreign_or_archived_evidence():
    s = _svc()
    j, app, ids = _seed(s)
    foreign = f.evidence(B, "B's secret")
    s.evidence.put(foreign)
    for eid in (uuid4(), foreign.id):
        err = await _code(s.analyze(A, j.id, app.id, 1, [eid], None))
        assert err.details == {"field": "evidenceIds"} and "not found" in \
            err.message
    archived = f.evidence(A, "old", archived=True)
    s.evidence.put(archived)
    err = await _code(s.analyze(A, j.id, app.id, 1, [archived.id], None))
    assert "archived" in err.message
    assert s.analyses.created == []


async def test_analyze_requires_evidence_use_approval():
    s = _svc()
    j, app, ids = _seed(s, approve=False)
    err = await _code(s.analyze(A, j.id, app.id, 1, ids, None))
    assert err.code == "APPROVAL_REQUIRED"
    assert s.analyses.created == []


# ---- reference samples ----------------------------------------------------

_CTX = {"reference_data": True, "job_category": "dev", "tenure_years": 3,
        "plan": "PRO"}


@pytest.mark.parametrize("ctx", [
    None,
    {**_CTX, "plan": "ENTERPRISE"},
])
async def test_reference_samples_skip_without_context_or_unknown_plan(ctx):
    samples = _Samples(ctx)
    s = _svc(samples=samples)
    j, app, ids = _seed(s)
    await s.analyze(A, j.id, app.id, 1, ids, None)
    assert samples.inserted == []


@pytest.mark.parametrize("plan", [None, " "])
async def test_reference_samples_blank_plan_counts_as_free(plan):
    samples = _Samples({**_CTX, "plan": plan})
    s = _svc(samples=samples)
    j, app, ids = _seed(s)
    await s.analyze(A, j.id, app.id, 1, ids, None)
    (args,) = samples.inserted
    assert args[1:5] == (A, "dev", 3, 66) and args[6] == "FREE"


@pytest.mark.parametrize("fail", [
    {"SAVEPOINT"},
    {"RELEASE"},
])
async def test_savepoint_errors_never_fail_the_analysis(fail):
    q = _Query(fail)
    s = _svc(query=q, samples=_Samples(_CTX))
    j, app, ids = _seed(s)
    op = await s.analyze(A, j.id, app.id, 1, ids, None)
    assert op is not None and len(s.analyses.created) == 1


@pytest.mark.parametrize("fail", [set(), {"ROLLBACK"}])
async def test_sample_insert_failure_rolls_back_to_savepoint(fail):
    q = _Query(fail)
    s = _svc(query=q, samples=_Samples(_CTX, err=RuntimeError("no table")))
    j, app, ids = _seed(s)
    op = await s.analyze(A, j.id, app.id, 1, ids, None)
    assert op is not None
    assert q.sql == ["SAVEPOINT reference_samples",
                     "ROLLBACK TO SAVEPOINT reference_samples"]


def test_part_scores_ignore_blank_keywords_and_wordless_requirements():
    e = f.evidence(A, "SQL", skills=["go"])
    assert part_scores(["a b"], ["", "GO"], [e]) == {
        "techStack": 50, "experienceLink": 0, "keyword": 0}


async def test_analyze_rejects_too_many_evidence_ids_before_any_lookup():
    from app.domain.services.job import MAX_ANALYSIS_EVIDENCE
    s = _svc()
    j, app, _ = _seed(s)
    ids = [uuid4() for _ in range(MAX_ANALYSIS_EVIDENCE + 1)]
    err = await _code(s.analyze(A, j.id, app.id, j.revision, ids, None))
    assert (err.code, err.details) == ("VALIDATION_ERROR", {"field": "evidenceIds"})
    assert s.analyses.created == []


async def test_analyze_uses_each_evidence_once():
    s = _svc()
    j, app, ids = _seed(s)
    op = await s.analyze(A, j.id, app.id, j.revision, ids * 3, None)
    assert op.result.value["evidenceIds"] == [str(ids[0])]
