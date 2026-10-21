from __future__ import annotations

import json
from datetime import datetime, timezone
from uuid import uuid4

import pytest

from app.domain import entities as ent
from app.domain.reference_text import (
    eligible, features_of, prompt_lines, score_band, templates_of,
)
from app.domain.services.job import JobService
from app.pgproto import PgError
from tests.stubs import StubApplicationStore, StubEvidenceStore, StubJobStore

_SENTENCE = (
    'H2O Corp에서 "민수"의 결제 프로젝트를 맡아 전환율을 40% 올렸다. '
    "연락은 ada@example.com 또는 010-1234-5678"
)
_OTHER = "다른 원문 secret@other.com 숫자 99"


def _now():
    return datetime.now(timezone.utc)


def _sample(category="dev", tenure=5, band=80, metric=True,
            depth="concrete", linked=True, secret="인용문장"):
    return {
        "job_category": category,
        "tenure_years": tenure,
        "score_band": band,
        "features": {
            "metric_count": 1 if metric else 0,
            "has_metric": metric,
            "tech_depth": depth,
            "links_experience": linked,
        },
        "sentence_templates": [secret],
        "source_text": secret,
    }


def test_template_masks_company_number_email_and_phone():
    samples = [
        _SENTENCE,
        "문의는 홍길동@kakao.com, user@회사.kr, a@b.c 입니다",
        "Samsung Co., Ltd에서 매출을 12% 올렸다. H2O Corporation에서 일했다",
    ]
    for text in samples:
        templates = templates_of(text)
        assert templates
        assert text not in templates
        blob = " ".join(templates)
        assert not any(ch.isdigit() for ch in blob)
        assert "@" not in blob
        for leaked in (
            "H2O", "Corp", "Corporation", "Ltd", "민수", "결제",
            "ada", "example.com", "kakao", "010",
        ):
            assert leaked not in blob, leaked


def test_features_are_counts_not_the_sentence():
    features = features_of(_SENTENCE)
    assert set(features) == {
        "metric_count", "has_metric", "tech_depth", "links_experience",
    }
    assert features["metric_count"] == 1
    assert features["has_metric"] is True
    assert features["tech_depth"] == "shallow"
    assert features["links_experience"] is True
    assert _SENTENCE not in features.values()
    concrete = features_of("Spring Boot로 결제 API를 개선해 전환율을 40% 올렸다")
    assert concrete["metric_count"] == 1
    assert concrete["has_metric"] is True
    assert concrete["tech_depth"] == "concrete"
    assert concrete["links_experience"] is True
    plain = features_of("일을 했다")
    assert plain == {
        "metric_count": 0,
        "has_metric": False,
        "tech_depth": "shallow",
        "links_experience": False,
    }


@pytest.mark.parametrize(
    ("score", "band"),
    [(0, 0), (9, 0), (10, 10), (82, 80), (99, 90), (100, 100)],
)
def test_score_band_floors_to_tens(score, band):
    assert score_band(score) == band


def test_bucket_of_29_samples_produces_an_empty_prompt_list():
    rows = [_sample(secret="raw@secret.com") for _ in range(29)]
    assert eligible(rows) == []
    assert prompt_lines(rows) == []


def test_prompt_lines_count_features_and_omit_templates():
    rows = []
    for i in range(30):
        rows.append(_sample(
            metric=i < 10,
            depth="concrete" if i < 20 else "shallow",
            linked=i < 5,
            secret="인용문장 raw@secret.com",
        ))
    assert prompt_lines(rows) == ["dev 5년 80점대 30건 수치 10 구체 20 연결 5"]


def test_eligible_groups_category_tenure_and_score_band():
    rows = (
        [_sample(category="dev", tenure=5, band=80) for _ in range(30)]
        + [_sample(category="dev", tenure=6, band=80) for _ in range(30)]
        + [_sample(category="design", tenure=5, band=80) for _ in range(30)]
        + [_sample(category="dev", tenure=5, band=70, secret="비밀문장") for _ in range(29)]
        + [{"job_category": "dev", "tenure_years": 5} for _ in range(40)]
    )
    kept = eligible(rows)
    assert len(kept) == 90
    assert {row["score_band"] for row in kept} == {80}
    assert prompt_lines(rows) == [
        "dev 5년 80점대 30건 수치 30 구체 30 연결 30",
        "dev 6년 80점대 30건 수치 30 구체 30 연결 30",
        "design 5년 80점대 30건 수치 30 구체 30 연결 30",
    ]


class _Query:
    def __init__(self, row, fail_read=False, fail_insert=False):
        self.row = row
        self.fail_read = fail_read
        self.fail_insert = fail_insert
        self.aborted = False
        self.calls = []

    async def fetchrow(self, sql, *args):
        self.calls.append((sql, args))
        if self.aborted:
            raise PgError("25P02", "current transaction is aborted")
        if self.fail_read:
            self.aborted = True
            raise PgError("42P01", 'relation "user_consents" does not exist')
        return self.row

    async def execute(self, sql, *args):
        self.calls.append((sql, args))
        if sql.startswith("ROLLBACK TO SAVEPOINT"):
            self.aborted = False
            return "OK"
        if self.aborted:
            raise PgError("25P02", "current transaction is aborted")
        if self.fail_insert and "INSERT INTO reference_samples" in sql:
            self.aborted = True
            raise PgError("42P01", 'relation "reference_samples" does not exist')
        return "OK"


class _DB:
    def __init__(self, query):
        self.query = query

    def q(self):
        return self.query

    async def run(self, fn):
        return await fn()


class _Approvals:
    async def require_evidence_use(self, user_id, application_id, evidence_id):
        return None


class _Gate:
    async def check(self, user_id, ai):
        return None


class _Analyses:
    def __init__(self, query):
        self.query = query
        self.created = []

    async def mark_stale_for_job(self, user_id, job_id, except_id):
        return None

    async def create(self, analysis):
        assert not any(
            "INSERT INTO reference_samples" in sql for sql, _ in self.query.calls)
        self.created.append(analysis)


class _Ops:
    def __init__(self, query):
        self.query = query
        self.created = []

    async def create(self, op):
        await self.query.execute("INSERT INTO operations (id) VALUES ($1)", op.id)
        self.created.append(op)


def _evidence(user_id, source, skills):
    return ent.CareerEvidence(
        id=uuid4(), user_id=user_id, kind="TEXT", title="resume",
        source_text=source, skills=skills, created_at=_now(), updated_at=_now())


def _service(query, requirements, evidences):
    user_id = evidences[0].user_id
    job_id = uuid4()
    app_id = uuid4()
    job = ent.JobPosting(
        id=job_id, user_id=user_id, company="Acme", title="Backend",
        source_kind="TEXT", source_text="posting body", requirements=requirements,
        revision=1, created_at=_now(), updated_at=_now())
    app = ent.Application(
        id=app_id, user_id=user_id, job_id=job_id, company="Acme", title="Backend",
        created_at=_now(), updated_at=_now())
    svc = JobService(_DB(query), _Approvals(), _Gate())
    svc.jobs = StubJobStore(job)
    svc.applications = StubApplicationStore(app)
    svc.evidence = StubEvidenceStore({item.id: item for item in evidences})
    svc.analyses = _Analyses(query)
    svc.ops = _Ops(query)
    return svc, user_id, job_id, app_id, [item.id for item in evidences]


def _inserts(query):
    return [(sql, args) for sql, args in query.calls
            if "INSERT INTO reference_samples" in sql]


def _consent_reads(query):
    return [sql for sql, _ in query.calls if "user_consents" in sql]


def _consented(plan="PRO", category="dev", tenure=5, consent=True):
    return {
        "reference_data": consent,
        "job_category": category,
        "tenure_years": tenure,
        "plan": plan,
    }


async def test_analyze_inserts_generalized_sample_without_raw_body():
    user_id = uuid4()
    evidences = [
        _evidence(user_id, _SENTENCE, ["python"]),
        _evidence(user_id, _OTHER, []),
    ]
    query = _Query(_consented())
    svc, user_id, job_id, app_id, ids = _service(
        query, ["python backend", "kubernetes cluster", "graphql schema"], evidences)
    op = await svc.analyze(user_id, job_id, app_id, 1, ids, None)
    assert op is not None
    assert len(svc.analyses.created) == 1
    assert len(svc.ops.created) == 1
    inserts = _inserts(query)
    assert len(inserts) == 2
    seen = set()
    for sql, args in inserts:
        assert "source_text" not in sql
        blob = json.dumps(args, default=str, ensure_ascii=False)
        assert _SENTENCE not in blob
        assert _OTHER not in blob
        assert "@" not in blob
        assert "H2O" not in blob
        assert "99" not in " ".join(args[9])
        assert args[1] == user_id
        assert args[2] == "dev"
        assert args[3] == 5
        assert args[6] == {}
        assert args[7] == "PRO"
        assert set(args[8]) == {
            "metric_count", "has_metric", "tech_depth", "links_experience",
        }
        assert isinstance(args[9], list)
        templates = " ".join(args[9])
        assert "@" not in templates
        assert not any(ch.isdigit() for ch in templates)
        seen.add((args[4], args[5]))
    assert seen == {(33, 30), (0, 0)}


@pytest.mark.parametrize("consent", [False, None])
async def test_analyze_inserts_nothing_when_consent_is_not_true(consent):
    user_id = uuid4()
    query = _Query(_consented(consent=consent))
    svc, user_id, job_id, app_id, ids = _service(
        query, ["python backend"], [_evidence(user_id, _SENTENCE, ["python"])])
    op = await svc.analyze(user_id, job_id, app_id, 1, ids, None)
    assert op is not None
    assert len(svc.analyses.created) == 1
    assert _consent_reads(query)
    assert _inserts(query) == []


@pytest.mark.parametrize(
    ("category", "tenure"),
    [(None, 5), ("dev", None)],
)
async def test_analyze_skips_sample_when_profile_bucket_is_missing(category, tenure):
    user_id = uuid4()
    query = _Query(_consented(category=category, tenure=tenure))
    svc, user_id, job_id, app_id, ids = _service(
        query, ["python backend"], [_evidence(user_id, _SENTENCE, ["python"])])
    op = await svc.analyze(user_id, job_id, app_id, 1, ids, None)
    assert op is not None
    assert len(svc.analyses.created) == 1
    assert _consent_reads(query)
    assert _inserts(query) == []


@pytest.mark.parametrize("plan", [None, "", "   "])
async def test_analyze_stores_free_when_plan_is_blank(plan):
    user_id = uuid4()
    query = _Query(_consented(plan=plan))
    svc, user_id, job_id, app_id, ids = _service(
        query, ["python backend"], [_evidence(user_id, _SENTENCE, ["python"])])
    op = await svc.analyze(user_id, job_id, app_id, 1, ids, None)
    assert op is not None
    inserts = _inserts(query)
    assert len(inserts) == 1
    assert inserts[0][1][7] == "FREE"


@pytest.mark.parametrize("plan", ["BASIC", "pro"])
async def test_analyze_skips_plan_outside_personal_set(plan):
    user_id = uuid4()
    query = _Query(_consented(plan=plan))
    svc, user_id, job_id, app_id, ids = _service(
        query, ["python backend"], [_evidence(user_id, _SENTENCE, ["python"])])
    op = await svc.analyze(user_id, job_id, app_id, 1, ids, None)
    assert op is not None
    assert len(svc.analyses.created) == 1
    assert _consent_reads(query)
    assert _inserts(query) == []


async def test_analyze_skips_documents_when_job_has_no_requirements():
    user_id = uuid4()
    query = _Query(_consented())
    svc, user_id, job_id, app_id, ids = _service(
        query, [], [_evidence(user_id, _SENTENCE, ["python"])])
    op = await svc.analyze(user_id, job_id, app_id, 1, ids, None)
    assert op is not None
    assert len(svc.analyses.created) == 1
    assert svc.analyses.created[0].fit_score is None
    assert _consent_reads(query)
    assert _inserts(query) == []


@pytest.mark.parametrize(
    ("fail_read", "fail_insert"),
    [(True, False), (False, True)],
)
async def test_analyze_survives_missing_reference_tables(fail_read, fail_insert):
    user_id = uuid4()
    query = _Query(_consented(), fail_read=fail_read, fail_insert=fail_insert)
    svc, user_id, job_id, app_id, ids = _service(
        query, ["python backend"], [_evidence(user_id, _SENTENCE, ["python"])])
    op = await svc.analyze(user_id, job_id, app_id, 1, ids, None)
    assert op is not None
    assert len(svc.analyses.created) == 1
    assert len(svc.ops.created) == 1
    assert _consent_reads(query)
