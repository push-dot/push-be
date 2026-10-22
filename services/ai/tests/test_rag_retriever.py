import os
from uuid import UUID, uuid4

import pytest

from app.framework import rag as framework_rag
from app.rag.retriever import Retriever, rag_engine
from app.rag.tenant import Tenant

USER = UUID("33333333-3333-4333-8333-333333333333")
OTHER = UUID("44444444-4444-4444-8444-444444444444")


def node(id_, text, user_id=USER, seq=0):
    return {"id": id_, "user_id": user_id, "company_id": None, "source_type": "source",
            "source_id": UUID(int=id_), "document_id": None, "seq": seq, "text": text}


class FakeDb:
    def __init__(self, rows):
        self.rows = rows
        self.calls = []

    def q(self):
        return self

    async def run(self, fn):
        return await fn()

    async def execute(self, sql, *args):
        self.calls.append(("execute", sql, args))

    async def fetch(self, sql, *args):
        self.calls.append(("fetch", sql, args))
        user_id, company_id = args[1], args[2]
        visible = [r for r in self.rows
                   if (user_id is not None and r["user_id"] == user_id)
                   or (company_id is not None and r["company_id"] == company_id)]
        if "<=>" in sql:
            return visible[:30]
        return [r for r in visible if "장애" in r["text"]][:30]


class Embedder:
    model = "BAAI/bge-m3"
    dim = 2

    async def embed(self, texts):
        return [[1.0, 0.0] for _ in texts]


class Reranker:
    def __init__(self):
        self.seen = []

    async def rerank(self, query, texts):
        self.seen.append(list(texts))
        return [float(len(t)) for t in texts]


@pytest.mark.asyncio
async def test_search_without_tenant_raises():
    retriever = Retriever(FakeDb([]), Embedder(), Reranker())
    with pytest.raises(ValueError):
        await retriever.search("q", None)
    with pytest.raises(ValueError):
        await retriever.search("q", Tenant())


@pytest.mark.asyncio
async def test_search_never_returns_other_tenant_rows():
    db = FakeDb([node(1, "mine"), node(2, "theirs, much longer text", user_id=OTHER)])
    hits = await Retriever(db, Embedder(), Reranker()).search("q", Tenant(user_id=USER))
    assert [h.text for h in hits] == ["mine"]
    for kind, sql, args in db.calls:
        if kind == "fetch":
            assert "user_id = $2" in sql and "company_id = $3" in sql
            assert args[1] == USER and args[2] is None


@pytest.mark.asyncio
async def test_hybrid_merges_dense_and_trigram_then_reranks():
    rows = [node(i, "장애 " * i, seq=i) if i % 2 else node(i, "x" * i, seq=i) for i in range(1, 8)]
    db = FakeDb(rows)
    reranker = Reranker()
    hits = await Retriever(db, Embedder(), reranker).search("결제 장애", Tenant(user_id=USER), k=3)
    assert len(reranker.seen[0]) == 7
    assert [h.score for h in hits] == sorted([h.score for h in hits], reverse=True)
    assert len(hits) == 3
    assert hits[0].text == "장애 " * 7
    assert hits[0].citation_id == f"source:{UUID(int=7)}:7"
    fetches = [sql for kind, sql, _ in db.calls if kind == "fetch"]
    assert any("<=>" in sql for sql in fetches)
    assert any("word_similarity" in sql for sql in fetches)


@pytest.mark.asyncio
async def test_search_filters_kinds_and_model():
    db = FakeDb([node(1, "a")])
    await Retriever(db, Embedder(), Reranker()).search("q", Tenant(user_id=USER), kinds=["source"])
    for kind, sql, args in db.calls:
        if kind == "fetch":
            assert "embedding_model = $4" in sql
            assert args[3] == "BAAI/bge-m3"
            assert "source_type = ANY($5" in sql
            assert args[4] == ["source"]


@pytest.mark.asyncio
async def test_rag_engine_flag_keeps_legacy_path(monkeypatch):
    calls = []

    async def legacy(svc, state, seen):
        calls.append("legacy")
        return "legacy"

    async def llama(svc, state, seen):
        calls.append("llamaindex")
        return "llama"

    monkeypatch.setattr(framework_rag, "_legacy", legacy)
    monkeypatch.setattr(framework_rag, "_llamaindex", llama)
    monkeypatch.delenv("RAG_ENGINE", raising=False)
    monkeypatch.delenv("AI_FRAMEWORK", raising=False)
    assert rag_engine() == "legacy"
    assert await framework_rag.collect_evidence(None, {}, set()) == "legacy"
    monkeypatch.setenv("RAG_ENGINE", "llamaindex")
    assert await framework_rag.collect_evidence(None, {}, set()) == "llama"
    monkeypatch.setenv("RAG_ENGINE", "bogus")
    assert rag_engine() == "legacy"
    assert calls == ["legacy", "llamaindex"]


@pytest.mark.asyncio
async def test_llamaindex_section_uses_the_user_tenant(monkeypatch):
    seen_tenants = []

    class Stub:
        async def search(self, query, tenant, k=5, *, kinds=None):
            seen_tenants.append(tenant)
            from app.rag.retriever import Hit
            return [Hit("근거 문장", uuid4(), None, 0.9, "source:x:0", "source")]

    monkeypatch.setattr(framework_rag, "_retriever", lambda svc: Stub())
    section = await framework_rag._llamaindex(object(), {"user_id": USER, "text": "질문"}, set())
    assert seen_tenants == [Tenant(user_id=USER)]
    assert "근거 문장" in section
    assert section.startswith("[관련 근거]")


@pytest.mark.asyncio
async def test_hybrid_sql_on_pgvector_keeps_tenants_apart():
    url = os.environ.get("RAG_PG_URL")
    if not url:
        pytest.skip("RAG_PG_URL not set")
    asyncpg = pytest.importorskip("asyncpg")
    from app.db import DB, _init_conn
    from app.rag.store import RagNodeStore

    pool = await asyncpg.create_pool(url, init=_init_conn, min_size=0, max_size=2)
    mine, theirs = uuid4(), uuid4()
    try:
        for user in (mine, theirs):
            await pool.execute(
                "INSERT INTO users (id, provider, provider_subject, display_name) VALUES ($1, 'email', $2, 'a')",
                user, str(user))
        store = RagNodeStore(DB(pool))
        for user, text in ((mine, "결제 서버 장애 대응 시간을 줄였습니다"), (theirs, "결제 서버 장애 대응 비밀 문서")):
            source = uuid4()
            await store.replace("link", source, "BAAI/bge-m3", [{
                "id": uuid4(), "user_id": user, "company_id": None, "source_type": "link",
                "source_id": source, "document_id": None, "plan": None, "seq": 0, "text": text,
                "metadata": {}, "embedding": [0.1] * 1024}])

        class Flat:
            model = "BAAI/bge-m3"
            dim = 1024

            async def embed(self, texts):
                return [[0.1] * 1024 for _ in texts]

        hits = await Retriever(DB(pool), Flat(), Reranker()).search("장애 대응", Tenant(user_id=mine), kinds=["link"])
        assert [h.text for h in hits] == ["결제 서버 장애 대응 시간을 줄였습니다"]
        assert await Retriever(DB(pool), Flat(), Reranker()).search("장애", Tenant(user_id=mine), kinds=["source"]) == []
    finally:
        await pool.execute("DELETE FROM users WHERE id = ANY($1::uuid[])", [mine, theirs])
        await pool.close()
