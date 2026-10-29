"""framework/rag.py: splitter selection, extra-source indexing, retriever cache."""
from __future__ import annotations

import sys
import types
from types import SimpleNamespace
from uuid import uuid4

import pytest

import app.framework.rag as rag
from app.domain import entities as ent
from tests.cov_fakes import NOW


class _Embed:
    def __init__(self, vectors=None):
        self.calls = []
        self.vectors = vectors

    async def embed(self, texts, user_id=None, job_id=None):
        self.calls.append((list(texts), user_id, job_id))
        if self.vectors is not None:
            return self.vectors
        return [[0.1, 0.2] for _ in texts]


class _Rag:
    def __init__(self, rows=None, hits=None):
        self.rows = rows or {}
        self.hits = hits or []
        self.replaced = []
        self.missing_calls = []

    async def missing(self, kind, user_id, limit):
        self.missing_calls.append((kind, user_id, limit))
        return self.rows.get(kind, [])

    async def replace(self, user_id, kind, source_id, title, pairs):
        self.replaced.append((user_id, kind, source_id, title, pairs))

    async def search(self, user_id, vector, k=6):
        return self.hits


class _NoChunks:
    async def evidence_ids_missing(self, user_id, limit=10):
        return []


def _langchain(monkeypatch):
    monkeypatch.delenv("RAG_ENGINE", raising=False)


def _legacy(monkeypatch):
    monkeypatch.setattr(rag, "use_langchain", lambda: False)
    monkeypatch.delenv("RAG_ENGINE", raising=False)


def test_split_text_uses_llamaindex_sentence_splitter_when_installed(monkeypatch):
    _langchain(monkeypatch)
    seen = {}

    class SentenceSplitter:
        def __init__(self, chunk_size, chunk_overlap):
            seen["size"] = (chunk_size, chunk_overlap)

        def split_text(self, text):
            seen["text"] = text
            return [" one ", "", "  ", "two"]

    parser = types.ModuleType("llama_index.core.node_parser")
    parser.SentenceSplitter = SentenceSplitter
    monkeypatch.setitem(sys.modules, "llama_index", types.ModuleType("llama_index"))
    monkeypatch.setitem(sys.modules, "llama_index.core", types.ModuleType("llama_index.core"))
    monkeypatch.setitem(sys.modules, "llama_index.core.node_parser", parser)

    assert rag.split_text("  body text  ") == ["one", "two"]
    assert seen == {"size": (512, 64), "text": "body text"}


def test_split_text_without_llamaindex_falls_back_to_chat_chunker(monkeypatch):
    _langchain(monkeypatch)
    monkeypatch.setitem(sys.modules, "llama_index.core.node_parser", None)
    assert rag.split_text("short text") == ["short text"]


def test_import_pgvector_store_returns_the_class_without_connecting(monkeypatch):
    class PGVectorStore:
        pass

    mod = types.ModuleType("llama_index.vector_stores.postgres")
    mod.PGVectorStore = PGVectorStore
    for name in ("llama_index", "llama_index.vector_stores"):
        monkeypatch.setitem(sys.modules, name, types.ModuleType(name))
    monkeypatch.setitem(sys.modules, "llama_index.vector_stores.postgres", mod)
    assert rag.import_pgvector_store() is PGVectorStore


@pytest.mark.parametrize(("kind", "row", "expected"), [
    ("job", {"company": "Acme", "title": "Backend", "source_text": "JD"},
     ("Acme Backend", "JD")),
    ("job", {}, ("job", "")),
    ("posting", {"company": "Acme", "title": "PM", "description": "desc"},
     ("Acme PM", "desc")),
    ("posting", {"company": None, "title": None}, ("posting", "")),
    ("link", {"title": "Blog", "url": "https://ex"}, ("Blog", "Blog\nhttps://ex")),
    ("link", {"url": "https://ex"}, ("https://ex", "https://ex\nhttps://ex")),
    ("link", {}, ("link", "link")),
    ("resume", {"title": "cv.pdf"}, ("cv.pdf", "")),
    ("resume", {}, ("resume", "")),
])
def test_row_text_titles_and_bodies_per_source_kind(kind, row, expected):
    assert rag._row_text(kind, row) == expected


async def test_resume_rows_load_text_through_the_evidence_loader():
    user_id, source_id = uuid4(), uuid4()
    calls = []

    async def loader(uid, sid):
        calls.append((uid, sid))
        return None

    svc = SimpleNamespace(evidence=SimpleNamespace(_source_text=loader))
    out = await rag._load_text(svc, user_id, "resume", {"id": source_id, "title": "cv"})
    assert out == ("cv", "")
    assert calls == [(user_id, source_id)]

    no_loader = SimpleNamespace(evidence=object())
    assert await rag._load_text(no_loader, user_id, "resume", {"id": source_id}) == ("resume", "")


async def test_langchain_indexes_extra_sources_and_skips_empty_or_mismatched(monkeypatch):
    _langchain(monkeypatch)
    user_id = uuid4()
    job_id, empty_id, short_id, cv_id = uuid4(), uuid4(), uuid4(), uuid4()

    async def loader(uid, sid):
        assert uid == user_id
        return "resume body"

    store = _Rag(rows={
        "resume": [{"id": cv_id, "title": "cv.pdf"}],
        "job": [{"id": job_id, "company": "Acme", "title": "BE", "source_text": "jd text"}],
        "posting": [{"id": empty_id, "company": "X", "title": "Y", "description": "  "}],
    }, hits=[{"title": "Acme BE", "text": "jd text", "evidence_id": job_id, "dist": 0.1}])

    class Embed(_Embed):
        async def embed(self, texts, user_id=None, job_id=None):
            self.calls.append((list(texts), user_id, job_id))
            if texts == ["resume body"]:
                return []
            return [[0.1] for _ in texts]

    embed = Embed()
    svc = SimpleNamespace(chunks=_NoChunks(), evidence=SimpleNamespace(_source_text=loader),
                          ai=embed, rag=store)
    out = await rag.collect_evidence(svc, {"user_id": user_id, "text": "q", "job_id": "j1"}, set())

    assert out == "[관련 근거]\n- Acme BE\njd text"
    assert [r[1:4] for r in store.replaced] == [("job", job_id, "Acme BE")]
    assert store.replaced[0][0] == user_id
    assert {c[0] for c in store.missing_calls} == {"resume", "job", "posting", "link"}
    assert all(c[1] == user_id for c in store.missing_calls)
    assert ["  "] not in [c[0] for c in embed.calls]


async def test_langchain_builds_a_rag_store_on_the_service_db_and_handles_no_vectors(monkeypatch):
    _langchain(monkeypatch)
    import app.infrastructure.store_rag as store_rag
    built = []

    class FakeRagStore(_Rag):
        def __init__(self, db):
            super().__init__()
            built.append(db)

    monkeypatch.setattr(store_rag, "RagStore", FakeRagStore)
    db = object()
    embed = _Embed(vectors=[])
    svc = SimpleNamespace(chunks=_NoChunks(), evidence=object(), ai=embed, db=db)
    assert await rag.collect_evidence(svc, {"user_id": uuid4(), "text": "q"}, set()) == ""
    assert built == [db]
    assert [c[0] for c in embed.calls] == [["q"]]


async def test_legacy_skips_evidence_without_text_and_returns_empty_without_vectors(monkeypatch):
    _legacy(monkeypatch)
    user_id = uuid4()
    blank_id = uuid4()
    blank = ent.CareerEvidence(id=blank_id, user_id=user_id, kind="CAREER", title="t",
                               source_text="   ", created_at=NOW, updated_at=NOW)

    class Chunks:
        replaced = []

        async def evidence_ids_missing(self, uid, limit=10):
            return [blank_id]

        async def replace_chunks(self, *args):
            self.replaced.append(args)

    class Evidence:
        async def get(self, uid, eid):
            assert uid == user_id
            return blank

    embed = _Embed(vectors=[])
    svc = SimpleNamespace(chunks=Chunks(), evidence=Evidence(), ai=embed)
    assert await rag.collect_evidence(svc, {"user_id": user_id, "text": "q"}, set()) == ""
    assert Chunks.replaced == []
    assert embed.calls == [(["q"], user_id, None)]


async def test_legacy_index_listing_failure_still_searches(monkeypatch):
    _legacy(monkeypatch)

    class Chunks:
        async def evidence_ids_missing(self, uid, limit=10):
            raise RuntimeError("table missing")

        async def search(self, uid, vector, k):
            return [{"title": "T", "text": "x", "evidence_id": uuid4(), "dist": 0.1}]

    svc = SimpleNamespace(chunks=Chunks(), ai=_Embed())
    assert await rag.collect_evidence(svc, {"user_id": uuid4(), "text": "q"}, set()) == "[관련 근거]\n- T\nx"


def test_retriever_is_built_once_and_shared(monkeypatch):
    import app.embedding.factory as factory
    import app.rag.retriever as retriever_mod
    monkeypatch.setattr(rag, "_shared", {})
    monkeypatch.delenv("REDIS_URL", raising=False)
    made = []

    def embedder(client, redis=None):
        made.append(("embed", redis))
        return SimpleNamespace(model="m")

    def reranker(client, redis=None):
        made.append(("rerank", redis))
        return object()

    monkeypatch.setattr(factory, "get_embedder", embedder)
    monkeypatch.setattr(factory, "get_reranker", reranker)
    db = object()
    first = rag._retriever(SimpleNamespace(db=db))
    second = rag._retriever(SimpleNamespace(db=object()))
    assert first is second
    assert isinstance(first, retriever_mod.Retriever)
    assert first.db is db
    assert made == [("embed", None), ("rerank", None)]


def test_retriever_uses_redis_cache_when_configured(monkeypatch):
    import app.embedding.factory as factory
    import redis.asyncio as redis_asyncio
    monkeypatch.setattr(rag, "_shared", {})
    monkeypatch.setenv("REDIS_URL", "redis://cache.invalid:6379/0")
    sentinel = object()
    urls = []

    def from_url(url, decode_responses=False):
        urls.append((url, decode_responses))
        return sentinel

    monkeypatch.setattr(redis_asyncio.Redis, "from_url", staticmethod(from_url))
    got = []
    monkeypatch.setattr(factory, "get_embedder", lambda c, r=None: got.append(r) or object())
    monkeypatch.setattr(factory, "get_reranker", lambda c, r=None: got.append(r) or object())
    rag._retriever(SimpleNamespace(db=None))
    assert urls == [("redis://cache.invalid:6379/0", True)]
    assert got == [sentinel, sentinel]


@pytest.mark.xfail(strict=True, reason=(
    "BUG: framework/rag.py:63 reads svc.evidence._source_text, but the chat/harness "
    "service binds svc.evidence to EvidenceStore (domain/services/conversation.py:180), "
    "which has no _source_text, so the profile resume is never indexed into rag_chunks"))
async def test_conversation_service_indexes_the_profile_resume(monkeypatch):
    _langchain(monkeypatch)
    from app.infrastructure.store_evidence import EvidenceStore
    from tests.cov_fakes import fake_db
    db, _ = fake_db()
    cv_id = uuid4()
    store = _Rag(rows={"resume": [{"id": cv_id, "title": "cv.pdf"}]})
    svc = SimpleNamespace(chunks=_NoChunks(), evidence=EvidenceStore(db), ai=_Embed(), rag=store)
    await rag.collect_evidence(svc, {"user_id": uuid4(), "text": "q"}, set())
    assert [r[2] for r in store.replaced] == [cv_id]
