from uuid import UUID

import pytest

from app.queue.worker import JobFailed
from app.rag.pipeline import Ingestor
from app.rag.store import RagNodeStore
from app.workers.handlers.ingest import make_ingest, reindex_all

USER = UUID("33333333-3333-4333-8333-333333333333")
OTHER = UUID("44444444-4444-4444-8444-444444444444")
COMPANY = UUID("77777777-7777-4777-8777-777777777777")
EVIDENCE = UUID("11111111-1111-4111-8111-111111111111")
DOCUMENT = UUID("22222222-2222-4222-8222-222222222222")
JOB = UUID("12121212-1212-4212-8212-121212121212")
POSTING = UUID("66666666-6666-4666-8666-666666666666")
MODEL = "BAAI/bge-m3"


class Embedder:
    model = MODEL
    dim = 3

    async def embed(self, texts):
        return [[1.0, 0.0, float(len(text))] for text in texts]


class Query:
    def __init__(self, evidence=None, documents=None, jobs=None, postings=None):
        self.evidence = evidence or {}
        self.documents = documents or {}
        self.jobs = jobs or {}
        self.postings = postings or {}

    async def fetchrow(self, sql, *args):
        if "career_evidence" in sql:
            return self.evidence.get(args[0])
        if "document_versions" in sql or "FROM documents" in sql:
            return self.documents.get(args[0])
        if "FROM jobs" in sql:
            return self.jobs.get(args[0])
        if "job_postings" in sql:
            return self.postings.get(args[0])
        return None


class Store:
    def __init__(self):
        self.rows = {}
        self.pending = {"evidence": [], "document": [], "job": [], "posting": []}

    async def replace(self, source_type, source_id, model, rows):
        self.rows[(source_type, source_id, model)] = rows

    async def _missing(self, kind, model, after, limit):
        have = {sid for (stored, sid, stored_model) in self.rows if stored == kind and stored_model == model}
        rows = [row for row in self.pending[kind] if row["id"] not in have]
        rows = [row for row in rows if after is None or row["id"] > after]
        return rows[:limit]

    async def sources_missing(self, model, after=None, limit=100):
        return []

    async def evidence_missing(self, model, after=None, limit=100):
        return await self._missing("evidence", model, after, limit)

    async def documents_missing(self, model, after=None, limit=100):
        return await self._missing("document", model, after, limit)

    async def jobs_missing(self, model, after=None, limit=100):
        return await self._missing("job", model, after, limit)

    async def postings_missing(self, model, after=None, limit=100):
        return await self._missing("posting", model, after, limit)


class Rec:
    def __init__(self):
        self.sqls = []

    def q(self):
        return self

    async def fetch(self, sql, *args):
        self.sqls.append(sql)
        return []


def ctx(payload, user_id=USER):
    async def beat():
        return None

    job = {"id": EVIDENCE, "user_id": user_id, "company_id": None, "payload": payload}
    return type("Ctx", (), {"job": job, "heartbeat": beat})()


async def _noop():
    return None


async def cover(kind, payload, query, pending, needle, *, user_id=USER, company_id=None):
    store = Store()
    store.pending[kind] = [pending]
    ingestor = Ingestor(store, Embedder())
    handle = make_ingest(lambda: query, store, ingestor, None)
    out = await handle(ctx(payload))
    key = (kind, pending["id"], MODEL)
    rows = store.rows[key]
    assert out["nodes"] == len(rows) > 0
    assert needle in rows[0]["text"]
    assert rows[0]["metadata"]["kind"] == kind
    assert rows[0]["metadata"]["source_id"] == str(pending["id"])
    assert rows[0]["user_id"] == user_id
    assert rows[0]["company_id"] == company_id
    store.rows.clear()
    done = await reindex_all(lambda: query, store, ingestor, _noop)
    assert done == 1
    assert needle in store.rows[key][0]["text"]


@pytest.mark.asyncio
async def test_evidence_ingest_and_reindex():
    query = Query(evidence={EVIDENCE: {
        "user_id": USER, "title": "결제 장애", "source_text": "서버 타임아웃을 줄였다",
    }})
    await cover(
        "evidence", {"evidenceId": str(EVIDENCE)}, query,
        {"id": EVIDENCE, "user_id": USER}, "결제 장애")


@pytest.mark.asyncio
async def test_evidence_payload_rejects_another_user():
    store = Store()
    query = Query(evidence={EVIDENCE: {
        "user_id": OTHER, "title": "비밀", "source_text": "남의 글",
    }})
    handle = make_ingest(lambda: query, store, Ingestor(store, Embedder()), None)
    with pytest.raises(JobFailed) as err:
        await handle(ctx({"evidenceId": str(EVIDENCE)}))
    assert err.value.error["code"] == "NOT_FOUND"
    assert store.rows == {}


@pytest.mark.asyncio
async def test_document_ingest_and_reindex():
    query = Query(documents={DOCUMENT: {
        "user_id": USER, "title": "이력서",
        "blocks": [{"id": "b1", "text": "결제 서버를 운영했다"}],
    }})
    await cover(
        "document", {"documentId": str(DOCUMENT)}, query,
        {"id": DOCUMENT, "user_id": USER}, "결제 서버를 운영했다")


@pytest.mark.asyncio
async def test_job_ingest_and_reindex():
    query = Query(jobs={JOB: {
        "user_id": USER, "company": "Acme", "title": "Backend",
        "source_text": "TypeScript 결제 모듈", "requirements": ["장애 대응"],
    }})
    await cover(
        "job", {"jobId": str(JOB)}, query,
        {"id": JOB, "user_id": USER}, "장애 대응")


@pytest.mark.asyncio
async def test_posting_ingest_and_reindex():
    query = Query(postings={POSTING: {
        "company_id": COMPANY, "title": "Backend", "description": "결제 API",
        "requirements": ["Kotlin"],
    }})
    await cover(
        "posting", {"postingId": str(POSTING)}, query,
        {"id": POSTING, "company_id": COMPANY}, "결제 API",
        user_id=None, company_id=COMPANY)


@pytest.mark.asyncio
async def test_missing_queries_name_each_source_table():
    db = Rec()
    store = RagNodeStore(db)
    await store.evidence_missing(MODEL)
    await store.documents_missing(MODEL)
    await store.jobs_missing(MODEL)
    await store.postings_missing(MODEL)
    joined = "\n".join(db.sqls)
    assert "career_evidence" in joined and "archived = false" in joined
    assert "documents" in joined and "document_versions" in joined
    assert "source_type = 'job'" in joined and "archived = false" in joined
    assert "job_postings" in joined and "source_type = 'posting'" in joined
    assert all("embedding_model = $1" in sql for sql in db.sqls)
