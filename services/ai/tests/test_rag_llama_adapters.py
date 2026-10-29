import json

import httpx
import pytest
from fakeredis.aioredis import FakeRedis
from llama_index.core.schema import NodeWithScore, TextNode

from app.embedding.cache import CachedEmbedder
from app.embedding.tei import TeiEmbedder, TeiReranker
from app.rag.llama_adapters import TeiEmbedding, TeiRerank


def client_for(handler):
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def embed_handler(request):
    body = json.loads(request.content)
    return httpx.Response(200, json=[[float(len(text)), 0.0] for text in body["inputs"]])


@pytest.mark.asyncio
async def test_adapter_returns_the_same_vectors_as_the_tei_embedder():
    async with client_for(embed_handler) as client:
        embedder = TeiEmbedder("http://embed", client)
        adapter = TeiEmbedding(embedder)
        texts = ["가", "나다라"]
        assert embedder.model == "BAAI/bge-m3"
        assert embedder.dim == 1024
        assert adapter.model_name == embedder.model
        assert await adapter.aget_text_embedding_batch(texts) == await embedder.embed(texts)
        assert await adapter.aget_query_embedding("abcd") == (await embedder.embed(["abcd"]))[0]


@pytest.mark.asyncio
async def test_adapter_reuses_the_redis_embedding_cache():
    calls = []

    def handler(request):
        body = json.loads(request.content)
        calls.append(list(body["inputs"]))
        return httpx.Response(200, json=[[1.0, float(len(text))] for text in body["inputs"]])

    async with client_for(handler) as client:
        cached = CachedEmbedder(
            TeiEmbedder("http://embed", client), FakeRedis(decode_responses=True))
        adapter = TeiEmbedding(cached)
        first = await adapter.aget_text_embedding_batch(["aa", "b"])
        second = await adapter.aget_text_embedding_batch(["b", "aa"])
    assert calls == [["aa", "b"]]
    assert first == [[1.0, 2.0], [1.0, 1.0]]
    assert second == [[1.0, 1.0], [1.0, 2.0]]


@pytest.mark.asyncio
async def test_reranker_reorders_by_tei_score_and_keeps_metadata():
    def handler(request):
        body = json.loads(request.content)
        scores = {"약한 문장": 0.1, "정확한 문장": 0.9, "버림": 0.05}
        ranked = [{"index": i, "score": scores[text]} for i, text in enumerate(body["texts"])]
        return httpx.Response(200, json=sorted(ranked, key=lambda hit: -hit["score"]))

    kept = {"user_id": "33333333-3333-4333-8333-333333333333", "kind": "job", "source_id": "s"}
    nodes = [
        NodeWithScore(node=TextNode(text="약한 문장", metadata=dict(kept)), score=0.2),
        NodeWithScore(node=TextNode(text="버림", metadata={"kind": "drop"}), score=0.8),
        NodeWithScore(
            node=TextNode(text="정확한 문장", metadata=dict(kept, rank="keyword")), score=0.3),
    ]
    async with client_for(handler) as client:
        ranked = await TeiRerank(TeiReranker("http://rerank", client), top_n=2).apostprocess_nodes(
            nodes, query_str="정확한 문장")
    assert [item.node.get_content() for item in ranked] == ["정확한 문장", "약한 문장"]
    assert [item.score for item in ranked] == [0.9, 0.1]
    assert ranked[0].node.metadata == {**kept, "rank": "keyword"}
    assert ranked[1].node.metadata == kept
