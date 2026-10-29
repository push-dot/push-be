import io
import os
import zipfile
from types import SimpleNamespace
from uuid import UUID, uuid4

import pytest

pytest.importorskip("llama_index.core")

from app.queue.worker import JobFailed
from app.rag.pipeline import CHUNK_OVERLAP, CHUNK_SIZE, Ingestor, approx_tokens
from app.rag.readers import docx_text
from app.rag.store import RagNodeStore, vector_literal
from app.rag.tenant import Tenant
from app.workers.handlers.ingest import make_ingest, reindex_all

USER = UUID("33333333-3333-4333-8333-333333333333")
OTHER = UUID("44444444-4444-4444-8444-444444444444")
SOURCE = UUID("55555555-5555-4555-8555-555555555555")


class MemoryStore:
    def __init__(self):
        self.rows = {}

    async def replace(self, source_type, source_id, model, rows):
        self.rows[(source_type, source_id, model)] = rows

    async def sources_missing(self, model, after=None, limit=100):
        ids = sorted(s for s in SOURCES if (("source", s, model) not in self.rows))
        return [{"id": s, "user_id": USER} for s in ids if after is None or s > after][:limit]

    async def evidence_missing(self, model, after=None, limit=100):
        return []

    async def documents_missing(self, model, after=None, limit=100):
        return []

    async def jobs_missing(self, model, after=None, limit=100):
        return []

    async def postings_missing(self, model, after=None, limit=100):
        return []


SOURCES = [SOURCE]


class Embedder:
    def __init__(self, model="BAAI/bge-m3"):
        self.model = model
        self.dim = 3
        self.calls = 0

    async def embed(self, texts):
        self.calls += 1
        return [[1.0, 0.0, float(len(t))] for t in texts]


class SourceQuery:
    def __init__(self, text, owner=USER):
        self.text = text
        self.owner = owner

    async def fetchrow(self, sql, *args):
        if "FROM sources" in sql:
            return {"id": args[0], "user_id": self.owner, "mime_type": "text/plain",
                    "file_name": "a.txt", "path": "db://sources/x", "content": self.text.encode()}
        return None


def long_text():
    return " ".join(f"{i}번 문장에서 결제 서버 장애를 줄였습니다." for i in range(400))


def ctx_for(payload, user_id=USER):
    async def beat():
        return None
    job = {"id": uuid4(), "user_id": user_id, "company_id": None, "payload": payload}
    return SimpleNamespace(job=job, heartbeat=beat)


@pytest.mark.asyncio
async def test_pipeline_splits_512_64_and_attaches_tenant_metadata():
    store = MemoryStore()
    count = await Ingestor(store, Embedder()).ingest_text(Tenant(user_id=USER), "source", SOURCE, long_text())
    rows = store.rows[("source", SOURCE, "BAAI/bge-m3")]
    assert count == len(rows) > 2
    assert (CHUNK_SIZE, CHUNK_OVERLAP) == (512, 64)
    assert max(len(approx_tokens(r["text"])) for r in rows) <= 512
    first, second = rows[0]["text"], rows[1]["text"]
    assert second[:20] in first
    assert [r["seq"] for r in rows] == list(range(count))
    meta = rows[0]["metadata"]
    assert meta["user_id"] == str(USER)
    assert meta["company_id"] is None
    assert meta["source_type"] == "source"
    assert meta["source_id"] == str(SOURCE)
    assert rows[0]["user_id"] == USER
    assert len(rows[0]["embedding"]) == 3


@pytest.mark.asyncio
async def test_pipeline_caps_text_before_embedding(monkeypatch):
    import app.rag.pipeline as pipeline
    monkeypatch.setattr(pipeline, "MAX_INGEST_CHARS", 2000)
    store = MemoryStore()
    await Ingestor(store, Embedder()).ingest_text(Tenant(user_id=USER), "source", SOURCE, long_text())
    rows = store.rows[("source", SOURCE, "BAAI/bge-m3")]
    assert sum(len(r["text"]) for r in rows) <= 2000 + 64 * 10


def test_ingest_requires_tenant():
    with pytest.raises(ValueError):
        Tenant()
    with pytest.raises(ValueError):
        Tenant(user_id=None, company_id=None)
    assert Tenant(company_id=OTHER).company_id == OTHER


@pytest.mark.asyncio
async def test_ingest_handler_rejects_someone_elses_source():
    store = MemoryStore()
    handle = make_ingest(lambda: SourceQuery("hi", owner=OTHER), store, Ingestor(store, Embedder()), None)
    with pytest.raises(JobFailed):
        await handle(ctx_for({"sourceId": str(SOURCE)}))
    assert store.rows == {}


@pytest.mark.asyncio
async def test_ingest_handler_indexes_an_uploaded_source():
    store = MemoryStore()
    handle = make_ingest(lambda: SourceQuery(long_text()), store, Ingestor(store, Embedder()), None)
    out = await handle(ctx_for({"sourceId": str(SOURCE)}))
    assert out["nodes"] == len(store.rows[("source", SOURCE, "BAAI/bge-m3")]) > 0


@pytest.mark.asyncio
async def test_reindex_writes_new_model_rows_without_touching_old():
    store = MemoryStore()
    old = [{"text": "old"}]
    store.rows[("source", SOURCE, "openai/text-embedding-3-small")] = old
    beats = []

    async def beat():
        beats.append(1)

    done = await reindex_all(lambda: SourceQuery(long_text()), store, Ingestor(store, Embedder("BAAI/bge-m3")), beat)
    assert done == 1
    assert store.rows[("source", SOURCE, "openai/text-embedding-3-small")] is old
    assert len(store.rows[("source", SOURCE, "BAAI/bge-m3")]) > 0
    assert beats == [1]


@pytest.mark.asyncio
async def test_reindex_stops_on_a_source_without_text():
    store = MemoryStore()
    done = await reindex_all(lambda: SourceQuery(""), store, Ingestor(store, Embedder()), _noop)
    assert done == 1
    assert store.rows[("source", SOURCE, "BAAI/bge-m3")] == []


async def _noop():
    return None


def test_docx_reader_extracts_paragraphs():
    body = (
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
        "<w:p><w:r><w:t>첫 문단</w:t></w:r></w:p><w:p><w:r><w:t>둘째</w:t></w:r><w:r><w:t> 문단</w:t></w:r></w:p>"
        "</w:body></w:document>")
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as archive:
        archive.writestr("word/document.xml", body)
    assert docx_text(buf.getvalue()) == "첫 문단\n둘째 문단"


@pytest.mark.asyncio
async def test_rag_node_store_round_trip_on_pgvector():
    url = os.environ.get("RAG_PG_URL")
    if not url:
        pytest.skip("RAG_PG_URL not set")
    asyncpg = pytest.importorskip("asyncpg")
    from app.db import DB, _init_conn

    pool = await asyncpg.create_pool(url, init=_init_conn, min_size=0, max_size=2)
    try:
        user = uuid4()
        source = uuid4()
        await pool.execute(
            "INSERT INTO users (id, provider, provider_subject, display_name) VALUES ($1, 'email', $2, 'a')",
            user, str(user))
        await pool.execute(
            "INSERT INTO sources (id, user_id, file_name, mime_type, size, sha256, path, status, created_at) "
            "VALUES ($1, $2, 'a.txt', 'text/plain', 1, 'x', 'db://x', 'STORED', now())", source, user)
        store = RagNodeStore(DB(pool))
        row = {"id": uuid4(), "user_id": user, "company_id": None, "source_type": "source",
               "source_id": source, "document_id": None, "plan": None, "seq": 0, "text": "결제 서버",
               "metadata": {"k": "v"}, "embedding": [0.1] * 1024}
        await store.replace("source", source, "BAAI/bge-m3", [row])
        assert await store.sources_missing("BAAI/bge-m3") == []
        assert [r["id"] for r in await store.sources_missing("other-model")] == [source]
        await store.replace("source", source, "BAAI/bge-m3", [{**row, "id": uuid4()}])
        assert await pool.fetchval("SELECT count(*) FROM rag_nodes WHERE source_id = $1", source) == 1
        await pool.execute("DELETE FROM sources WHERE id = $1", source)
        assert await pool.fetchval("SELECT count(*) FROM rag_nodes WHERE source_id = $1", source) == 0
        await pool.execute("DELETE FROM users WHERE id = $1", user)
    finally:
        await pool.close()
    assert vector_literal([1, 0.5]) == "[1.0,0.5]"
