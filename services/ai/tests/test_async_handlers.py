from types import SimpleNamespace
from uuid import UUID

import pytest
from fakeredis.aioredis import FakeRedis

from app.domain.errors import DomainError
from app.queue.streams import StreamQueue
from app.queue.worker import JobContext, JobFailed
from app.workers.ai_worker_main import ai_handlers
from app.workers.handlers.chat import chat
from app.workers.handlers.document import make_document
from app.workers.handlers.fit import make_fit
from tests.test_queue_worker import FIRST, USER, MemoryJobs, queued, worker

POSTING = UUID("00000000-0000-4000-8000-0000000000b1")
DOC = UUID("00000000-0000-4000-8000-0000000000d1")
EVIDENCE = UUID("00000000-0000-4000-8000-0000000000e1")


class FitQuery:
    def __init__(self, owner=USER):
        self.owner = owner
        self.cache = {}
        self.posting_reads = 0

    async def fetchrow(self, sql, *args):
        if "FROM posting_fit_cache" in sql:
            if len(args) < 4:
                return None
            return self.cache.get(args)
        if "FROM job_postings" in sql:
            self.posting_reads += 1
            if args[0] != self.owner:  # documents.user_id = $1
                return None
            return {"requirements": ["Python"], "skills": ["Python"], "description": "",
                    "content": "I use Python daily", "plan": "PRO", "revision": 1}
        return None

    async def execute(self, sql, *args):
        user_id, posting_id, document_id, score, parts, top_gap, plan = args[:7]
        self.cache[(user_id, posting_id, document_id, plan)] = {
            "fit_score": score, "parts": parts, "top_gap": top_gap, "plan": plan,
        }


def fit_job():
    job = queued(FIRST, "q:document")
    job["type"] = "fit"
    job["payload"] = {"postingId": str(POSTING), "documentId": str(DOC)}
    return job


def ctx_for(job):
    async def noop(*_args):
        return None
    return JobContext(job, noop, noop)


@pytest.mark.asyncio
async def test_fit_handler_caches_per_posting_document(monkeypatch):
    from app.domain.posting_fit import fit_view

    calls = {"n": 0}

    async def fake(requirements, keywords, description, content, plan, **kwargs):
        calls["n"] += 1
        return fit_view({
            "techStack": 10, "experienceLink": 8, "careerLevel": 6,
            "keyword": 4, "domain": 2,
        }, plan)

    monkeypatch.setattr(
        "app.infrastructure.posting_fit_cache.judge_fit", fake, raising=False)
    query = FitQuery()
    handle = make_fit(lambda: query)
    first = await handle(ctx_for(fit_job()))
    second = await handle(ctx_for(fit_job()))
    assert first == second
    assert first["plan"] == "PRO"
    assert first["fitScore"] == 7.4
    assert set(first["parts"]) == {
        "techStack", "experienceLink", "careerLevel", "keyword", "domain"}
    assert calls["n"] == 1
    assert query.posting_reads == 2
    assert list(query.cache) == [(USER, POSTING, DOC, "PRO")]


@pytest.mark.asyncio
async def test_fit_handler_fails_once_for_someone_elses_document():
    redis = FakeRedis(decode_responses=True)
    db = MemoryJobs()
    db.jobs[FIRST] = fit_job()
    released = []

    async def release(_db, job_id):
        released.append(job_id)

    box = worker(redis, db, {"fit": make_fit(lambda: FitQuery(owner=FIRST))}, release=release)
    await StreamQueue(redis).add("q:document", FIRST)
    msg = (await StreamQueue(redis).read("ai", "worker-a", ["q:document"], 1, 0))[0]
    assert await box.process(msg) == "failed"
    assert db.jobs[FIRST]["status"] == "FAILED"
    assert db.jobs[FIRST]["error"]["code"] == "NOT_FOUND"
    assert db.jobs[FIRST]["attempts"] == 0
    assert released == [FIRST]
    assert await redis.zcard("q:delayed") == 0


class Documents:
    def __init__(self, error=None):
        self.error = error
        self.calls = []

    async def generate(self, user_id, doc_id, expected, evidence_ids, analysis_id, ai, language):
        self.calls.append((user_id, doc_id, expected, evidence_ids, analysis_id, ai, language))
        if self.error:
            raise self.error
        return SimpleNamespace(
            id=UUID("00000000-0000-4000-8000-0000000000f1"),
            result=SimpleNamespace(value={"document": {"id": str(doc_id)}, "version": {"number": 2}}),
        )


def document_job(body):
    job = queued(FIRST, "q:document")
    job["type"] = "document"
    job["payload"] = {"documentId": str(DOC), "kind": "generate", "body": body}
    return job


@pytest.mark.asyncio
async def test_document_generate_handler_returns_operation_result():
    docs = Documents()
    out = await make_document(docs)(ctx_for(document_job({
        "expectedRevision": 3, "evidenceIds": [str(EVIDENCE)], "language": "ko",
    })))
    assert out == {
        "operationId": "00000000-0000-4000-8000-0000000000f1",
        "document": {"id": str(DOC)},
        "version": {"number": 2},
    }
    assert docs.calls == [(USER, DOC, 3, [EVIDENCE], None, None, "ko")]


@pytest.mark.asyncio
async def test_document_domain_error_fails_without_retry():
    redis = FakeRedis(decode_responses=True)
    db = MemoryJobs()
    db.jobs[FIRST] = document_job({"expectedRevision": 1, "evidenceIds": []})
    conflict = DomainError(409, "REVISION_CONFLICT", "stale", {"currentRevision": 2})
    box = worker(redis, db, {"document": make_document(Documents(conflict))})
    await StreamQueue(redis).add("q:document", FIRST)
    msg = (await StreamQueue(redis).read("ai", "worker-a", ["q:document"], 1, 0))[0]
    assert await box.process(msg) == "failed"
    assert db.jobs[FIRST]["status"] == "FAILED"
    assert db.jobs[FIRST]["error"] == {
        "code": "REVISION_CONFLICT", "message": "stale", "details": {"currentRevision": 2},
    }


@pytest.mark.asyncio
async def test_document_bad_body_fails_with_validation_error():
    with pytest.raises(JobFailed) as err:
        await make_document(Documents())(ctx_for(document_job({"expectedRevision": "x"})))
    assert err.value.error["code"] == "VALIDATION_ERROR"


def test_employer_ai_runs_through_the_chat_handler():
    handlers = ai_handlers(SimpleNamespace(documents=Documents()), lambda: FitQuery())
    assert handlers["employer_ai"] is chat
    assert set(handlers) == {"chat", "employer_ai", "document", "fit"}


def test_fit_worker_opens_usage_through_the_service_gate(monkeypatch):
    gate = object()
    seen = {}

    def fake_make(query, bound=None):
        seen["gate"] = bound
        return "fit-handler"

    monkeypatch.setattr("app.workers.handlers.fit.make_fit", fake_make)
    deps = SimpleNamespace(documents=Documents(), ai=SimpleNamespace(gate=gate))
    handlers = ai_handlers(deps, lambda: None)
    assert handlers["fit"] == "fit-handler"
    assert seen["gate"] is gate
