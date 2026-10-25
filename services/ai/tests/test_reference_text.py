from __future__ import annotations

import json
from datetime import datetime, timezone
from types import SimpleNamespace
from uuid import uuid4

import pytest

from app.domain import entities as ent
from app.domain.reference_text import (
    eligible, features_of, prompt_lines, score_band, templates_of,
)
from app.domain.services.job import JobService
from app.graphs.chat import bind_chat_nodes, event_sink
from app.pgproto import PgError
from tests.stubs import (
    StubApplicationStore, StubConversationStore, StubEvidenceStore, StubJobStore,
)
from tests.test_conversation import _svc as _chat_svc

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
    assert op.result.value["partScores"] == {
        "techStack": 0, "experienceLink": 100, "keyword": 16,
    }
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
        assert "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)" in sql
        assert "part_scores, plan, features, sentence_templates" in sql
        assert args[6] in (
            {"techStack": 0, "experienceLink": 100, "keyword": 16},
            {"techStack": 0, "experienceLink": 0, "keyword": 0},
        )
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


def _cell(n, tenure=5, band=80, category="dev"):
    return [_sample(category=category, tenure=tenure, band=band) for _ in range(n)]


def test_eligible_keeps_exact_cell_of_30_and_drops_29():
    rows = _cell(30, band=80) + _cell(29, band=70)
    kept = eligible(rows)
    assert len(kept) == 30
    assert {row["score_band"] for row in kept} == {80}


def test_window_does_not_pool_two_cells_of_15():
    from app.domain.reference_text import prompt_samples
    rows = _cell(15, tenure=5) + _cell(15, tenure=6)
    assert prompt_samples(rows, "dev", 5, 80, "plus1", "same") == []


def test_plus1_excludes_tenure_two_away():
    from app.domain.reference_text import prompt_samples
    rows = (
        _cell(30, tenure=3) + _cell(30, tenure=4) + _cell(30, tenure=5)
        + _cell(30, tenure=6) + _cell(30, tenure=7)
    )
    text = "\n".join(prompt_lines(prompt_samples(rows, "dev", 5, 80, "plus1", "same")))
    assert "dev 3년" not in text
    assert "dev 7년" not in text
    assert "dev 4년 80점대 30건" in text
    assert "dev 5년 80점대 30건" in text
    assert "dev 6년 80점대 30건" in text


def test_up1_includes_band_and_next_only():
    from app.domain.reference_text import prompt_samples
    rows = _cell(30, band=70) + _cell(30, band=80) + _cell(30, band=90) + _cell(30, band=100)
    text = "\n".join(prompt_lines(prompt_samples(rows, "dev", 5, 82, "same", "up1")))
    assert "70점대" not in text
    assert "100점대" not in text
    assert "80점대" in text
    assert "90점대" in text


def test_top_includes_subject_band_through_100():
    from app.domain.reference_text import prompt_samples
    rows = _cell(30, band=70) + _cell(30, band=80) + _cell(30, band=90) + _cell(30, band=100)
    text = "\n".join(prompt_lines(prompt_samples(rows, "dev", 5, 82, "same", "top")))
    assert "70점대" not in text
    assert "80점대" in text
    assert "90점대" in text
    assert "100점대" in text


def test_same_without_score_returns_no_lines():
    from app.domain.reference_text import prompt_samples
    rows = _cell(30, band=0)
    assert prompt_lines(prompt_samples(rows, "dev", 5, None, "same", "same")) == []


def test_all_score_window_does_not_need_a_score():
    from app.domain.reference_text import prompt_samples
    rows = _cell(30, band=0)
    assert prompt_lines(prompt_samples(rows, "dev", 5, None, "all", "all")) == [
        "dev 5년 0점대 30건 수치 30 구체 30 연결 30",
    ]


def test_missing_category_or_tenure_returns_nothing():
    from app.domain.reference_text import prompt_samples
    rows = _cell(30)
    assert prompt_samples(rows, None, 5, 80, "all", "all") == []
    assert prompt_samples(rows, "dev", None, None, "all", "all") == []


def test_part_scores_are_integer_percents():
    from app.domain.services.job import part_scores
    user_id = uuid4()
    linked = _evidence(user_id, "시스템을 구현했다", ["python", "kubernetes", "graphql"])
    plain = _evidence(user_id, "일함", [])
    assert part_scores(["python service"], [], [linked])["techStack"] == 0
    assert part_scores(["python service"], ["Python", "Rust"], [linked])["techStack"] == 50
    sourced = _evidence(user_id, "I use kubernetes daily", [])
    assert part_scores([], ["Kubernetes"], [sourced])["techStack"] == 100
    scored = part_scores(
        ["python service", "kubernetes cluster", "graphql schema"],
        [],
        [linked],
    )
    assert scored["experienceLink"] == 33
    assert scored["keyword"] == 50
    deduped = part_scores(["python api", "python sdk"], [], [
        _evidence(user_id, "python으로 했다", []),
    ])
    assert deduped["keyword"] == 33
    assert part_scores(["go", "ai"], ["python"], [plain])["keyword"] == 0
    other = _evidence(user_id, "구현하고 개선하고 운영하고 설계했다", [])
    rust = _evidence(user_id, "텍스트", ["rust"])
    pool = part_scores(
        ["python work", "rust work"], ["Python", "Rust"], [linked, rust, other],
    )
    assert pool["techStack"] == 100
    assert pool["experienceLink"] == 50
    assert part_scores(
        ["python work", "rust work"], ["Python", "Rust"], [linked],
    )["techStack"] == 50


class _PromptQuery:
    def __init__(self, samples, profiles, applicant, fit=82, fail=False):
        self.samples = samples
        self.profiles = profiles
        self.applicant = applicant
        self.fit = fit
        self.fail = fail
        self.calls = []
        self.selected_templates = False

    async def fetchrow(self, sql, *args):
        self.calls.append((sql, args))
        if args and args[0] in self.profiles:
            return self.profiles[args[0]]
        if "fit_score" in sql or "gap_analyses" in sql:
            return {"fit_score": self.fit}
        return None

    async def fetch(self, sql, *args):
        self.calls.append((sql, args))
        if "reference_samples" not in sql:
            return []
        if "sentence_templates" in sql:
            self.selected_templates = True
        if self.fail:
            raise PgError("42P01", 'relation "reference_samples" does not exist')
        return self.samples

    async def fetchval(self, sql, *args):
        self.calls.append((sql, args))
        if self.fail and "reference_samples" in sql:
            raise PgError("42P01", 'relation "reference_samples" does not exist')
        if "applications" in sql:
            return self.applicant
        if "gap_analyses" in sql or "fit_score" in sql:
            return self.fit
        return None

    async def execute(self, sql, *args):
        self.calls.append((sql, args))
        return "OK"


class _PromptDB:
    def __init__(self, query):
        self.query = query

    def q(self):
        return self.query


def _profile(category="dev", tenure=5, plan="FREE"):
    return {
        "plan": plan,
        "job_category": category,
        "tenure_years": tenure,
        "reference_data": True,
    }


async def _prepare_prompt(query, *, user_id, text, employer=False, intent=None,
                          plan="BASIC", application_on="conv"):
    app_id = uuid4()
    conv = SimpleNamespace(
        id=uuid4(), user_id=user_id, archived=False, title="", revision=1,
        company_id=uuid4() if employer else None,
        application_id=app_id if application_on == "conv" else None,
    )
    svc = _chat_svc(StubConversationStore())
    svc.db = _PromptDB(query)

    async def company_plan(_company_id):
        return plan

    svc.conversations.company_plan = company_plan
    state = {
        "user_id": user_id,
        "text": text,
        "conversation": conv,
        "context": {},
        "attachments": [],
        "ai": {
            "provider": "OPENAI", "model": "client-model",
            "effort": "LOW",
        },
    }
    if intent:
        state["intent"] = intent
    if application_on == "application_id":
        state["application_id"] = app_id
    if application_on == "applicationId":
        state["applicationId"] = app_id
    nodes = bind_chat_nodes(svc)
    token = event_sink.set([])
    try:
        return await nodes["prepare_reply"](state)
    finally:
        event_sink.reset(token)


def _prompt_rows(n):
    return [
        _sample(secret="SECRET_TEMPLATE_SENTENCE") for _ in range(n)
    ]


async def test_resume_prompt_includes_a_full_cell_and_hides_templates():
    user_id = uuid4()
    query = _PromptQuery(_prompt_rows(30), {user_id: _profile()}, user_id)
    out = await _prepare_prompt(query, user_id=user_id, text="이력서 써 줘")
    assert "dev 5년 80점대 30건 수치" in out["prompt_system"]
    assert "SECRET_TEMPLATE_SENTENCE" not in out["prompt_system"]
    assert "SECRET_TEMPLATE_SENTENCE" not in out["prompt_user"]
    selected = [sql for sql, _ in query.calls if "FROM reference_samples" in sql]
    assert selected
    assert query.selected_templates is False


async def test_resume_prompt_skips_a_cell_of_29():
    user_id = uuid4()
    query = _PromptQuery(_prompt_rows(29), {user_id: _profile()}, user_id)
    out = await _prepare_prompt(query, user_id=user_id, text="이력서 써 줘")
    assert "건 수치" not in out["prompt_system"]


@pytest.mark.parametrize("intent", ["posting", "general"])
async def test_posting_and_general_do_not_inject_reference_lines(intent):
    user_id = uuid4()
    applicant = uuid4()
    query = _PromptQuery(_prompt_rows(30), {applicant: _profile()}, applicant)
    out = await _prepare_prompt(
        query, user_id=user_id, text="백엔드 공고를 써 줘", employer=True,
        intent=intent, plan="BASIC", application_on="application_id",
    )
    assert "건 수치" not in out["prompt_system"]
    if intent == "posting":
        assert "```posting-draft" in out["prompt_system"]


@pytest.mark.parametrize(
    ("intent", "plan", "application_on"),
    [("review", "BASIC", "applicationId"), ("interview", "PRO", "application_id")],
)
async def test_review_and_interview_inject_reference_lines(intent, plan, application_on):
    user_id = uuid4()
    applicant = uuid4()
    query = _PromptQuery(_prompt_rows(30), {applicant: _profile()}, applicant)
    out = await _prepare_prompt(
        query, user_id=user_id, text="이 지원자를 봐 줘", employer=True,
        intent=intent, plan=plan, application_on=application_on,
    )
    assert "dev 5년 80점대 30건 수치" in out["prompt_system"]
    assert "SECRET_TEMPLATE_SENTENCE" not in out["prompt_system"]


async def test_resume_prompt_survives_a_missing_sample_table():
    user_id = uuid4()
    query = _PromptQuery(_prompt_rows(30), {user_id: _profile()}, user_id, fail=True)
    out = await _prepare_prompt(query, user_id=user_id, text="이력서 써 줘")
    assert out["prepared"] is True
    assert out["prompt_system"]
    assert "건 수치" not in out["prompt_system"]


@pytest.mark.parametrize("text", [
    "a" * 50_000,
    "가" * 50_000,
    "「" * 50_000,
    "x@" * 25_000,
    "1-" * 25_000 + "a",
], ids=["latin", "hangul", "open-quotes", "at-signs", "phone-like"])
def test_long_single_tokens_scan_in_linear_time(text):
    import time
    from app.domain.reference_text import features_of, templates_of
    started = time.perf_counter()
    features_of(text)
    templates_of(text)
    assert time.perf_counter() - started < 1.0
