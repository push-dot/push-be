from uuid import UUID

import pytest
from llama_index.core.vector_stores.types import (
    FilterOperator,
    MetadataFilter,
    MetadataFilters,
    VectorStoreQuery,
)

from app.rag.retriever import Retriever
from app.rag.tenant import Tenant
from app.rag.vector_store import RagNodesStore

USER = UUID("33333333-3333-4333-8333-333333333333")
OTHER = UUID("44444444-4444-4444-8444-444444444444")
COMPANY = UUID("77777777-7777-4777-8777-777777777777")
OTHER_COMPANY = UUID("88888888-8888-4888-8888-888888888888")


def row(text, *, user_id=USER, company_id=None, dense=None, keyword=None, seq=0):
    return {
        "id": UUID(int=seq + 1),
        "user_id": user_id,
        "company_id": company_id,
        "source_type": "job",
        "source_id": UUID(int=100 + seq),
        "document_id": None,
        "seq": seq,
        "text": text,
        "metadata": {},
        "dense_similarity": dense,
        "keyword_similarity": keyword,
    }


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
        if "user_id = $2" not in sql or "company_id = $3" not in sql:
            return list(self.rows)
        user_id, company_id = args[1], args[2]
        visible = [
            item for item in self.rows
            if (user_id is not None and item["user_id"] == user_id)
            or (company_id is not None and item["company_id"] == company_id)]
        if "<=>" in sql:
            return [{**item, "similarity": item["dense_similarity"]}
                    for item in visible if item["dense_similarity"] is not None]
        if "word_similarity" in sql:
            return [{**item, "similarity": item["keyword_similarity"]}
                    for item in visible if item["keyword_similarity"] is not None]
        return visible


def filters_for(*, user_id=None, company_id=None, model="BAAI/bge-m3", kinds=None):
    items = []
    if user_id is not None:
        items.append(MetadataFilter(key="user_id", value=str(user_id)))
    if company_id is not None:
        items.append(MetadataFilter(key="company_id", value=str(company_id)))
    if model is not None:
        items.append(MetadataFilter(key="embedding_model", value=model))
    if kinds is not None:
        items.append(MetadataFilter(key="source_type", value=kinds, operator=FilterOperator.IN))
    return MetadataFilters(filters=items)


class Embedder:
    model = "BAAI/bge-m3"
    dim = 1024

    async def embed(self, texts):
        return [[0.2, 0.0] for _ in texts]


class FlatReranker:
    async def rerank(self, query, texts):
        return [0.0 for _ in texts]


@pytest.mark.asyncio
async def test_query_raises_without_a_user_or_company_filter():
    db = FakeDb([
        row("내 문서", dense=0.9),
        row("남의 비밀", user_id=OTHER, dense=0.99, seq=1),
    ])
    store = RagNodesStore(db)
    with pytest.raises(ValueError, match="user or company"):
        await store.aquery(VectorStoreQuery(
            query_embedding=[0.1, 0.0], query_str="비밀", similarity_top_k=5))
    with pytest.raises(ValueError, match="user or company"):
        await store.aquery(VectorStoreQuery(
            query_embedding=[0.1, 0.0],
            filters=MetadataFilters(filters=[]),
            similarity_top_k=5,
        ))
    with pytest.raises(ValueError, match="user or company"):
        await store.aquery(VectorStoreQuery(
            query_embedding=[0.1, 0.0],
            filters=MetadataFilters(filters=[MetadataFilter(key="source_type", value="job")]),
            similarity_top_k=5,
        ))
    assert db.calls == []


@pytest.mark.asyncio
async def test_query_never_returns_another_tenants_nodes():
    db = FakeDb([
        row("내 문서", dense=0.4, keyword=0.2),
        row("남의 비밀 결제 장애", user_id=OTHER, company_id=OTHER_COMPANY, dense=0.99, keyword=1.0, seq=1),
        row("우리 회사 공고", user_id=None, company_id=COMPANY, dense=0.5, seq=2),
    ])
    store = RagNodesStore(db)
    user_result = await store.aquery(VectorStoreQuery(
        query_embedding=[0.1, 0.0],
        query_str="결제 장애",
        filters=filters_for(user_id=USER),
        similarity_top_k=5,
    ))
    user_texts = [node.get_content() for node in user_result.nodes or []]
    assert user_texts == ["내 문서"]
    company_result = await store.aquery(VectorStoreQuery(
        query_embedding=[0.1, 0.0],
        filters=filters_for(company_id=COMPANY),
        similarity_top_k=5,
    ))
    company_texts = [node.get_content() for node in company_result.nodes or []]
    assert company_texts == ["우리 회사 공고"]
    for kind, sql, args in db.calls:
        if kind != "fetch":
            continue
        assert "user_id = $2" in sql and "company_id = $3" in sql
        assert args[1] in (USER, None)
        assert args[2] in (COMPANY, None)
        assert OTHER not in args and OTHER_COMPANY not in args


@pytest.mark.asyncio
async def test_hybrid_fusion_ranks_exact_korean_keyword_above_weak_vector():
    db = FakeDb([
        row("벡터만 가까운 문장", dense=0.05, seq=0),
        row("결제 장애", keyword=1.0, seq=1),
    ])
    hits = await Retriever(db, Embedder(), FlatReranker()).search(
        "결제 장애", Tenant(user_id=USER), k=2)
    assert [hit.text for hit in hits] == ["결제 장애", "벡터만 가까운 문장"]
    assert hits[0].citation_id == f"job:{UUID(int=101)}:1"
    fetches = [sql for kind, sql, _ in db.calls if kind == "fetch"]
    assert any("<=>" in sql for sql in fetches)
    assert any("word_similarity" in sql for sql in fetches)
