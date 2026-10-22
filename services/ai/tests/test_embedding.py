import hashlib
import json

import httpx
import pytest
from fakeredis.aioredis import FakeRedis

from app.embedding.api import ApiEmbedder, SimilarityReranker
from app.embedding.cache import CachedEmbedder, cache_key
from app.embedding.factory import get_embedder, get_reranker
from app.embedding.tei import TeiEmbedder, TeiReranker


def client_for(handler):
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


@pytest.mark.asyncio
async def test_tei_embed_batches_by_32():
    batches = []

    def handler(request):
        body = json.loads(request.content)
        batches.append(len(body["inputs"]))
        assert str(request.url) == "http://embed/embed"
        return httpx.Response(200, json=[[float(len(t)), 0.0] for t in body["inputs"]])

    async with client_for(handler) as client:
        out = await TeiEmbedder("http://embed", client).embed(["x" * i for i in range(70)])
    assert batches == [32, 32, 6]
    assert [v[0] for v in out] == [float(i) for i in range(70)]


@pytest.mark.asyncio
async def test_cache_hits_skip_remote():
    calls = []

    class Inner:
        model = "BAAI/bge-m3"
        dim = 2

        async def embed(self, texts):
            calls.append(list(texts))
            return [[1.0, float(len(t))] for t in texts]

    redis = FakeRedis(decode_responses=True)
    cached = CachedEmbedder(Inner(), redis)
    first = await cached.embed(["a", "bb"])
    second = await cached.embed(["bb", "a", "ccc"])
    assert calls == [["a", "bb"], ["ccc"]]
    assert first == [[1.0, 1.0], [1.0, 2.0]]
    assert second == [[1.0, 2.0], [1.0, 1.0], [1.0, 3.0]]
    key = cache_key("BAAI/bge-m3", "a")
    assert key.endswith(hashlib.sha256("BAAI/bge-m3\na".encode()).hexdigest())
    assert 0 < await redis.ttl(key) <= 2_592_000


@pytest.mark.asyncio
async def test_factory_switches_to_api_provider(monkeypatch):
    monkeypatch.setenv("EMBEDDING_PROVIDER", "api")
    monkeypatch.setenv("EMBEDDING_API_KEY", "k")
    async with client_for(lambda r: httpx.Response(200, json={})) as client:
        embedder = get_embedder(client)
        reranker = get_reranker(client)
        assert isinstance(embedder, ApiEmbedder)
        assert embedder.dim == 1024
        assert isinstance(reranker, SimilarityReranker)
        monkeypatch.setenv("EMBEDDING_PROVIDER", "tei")
        assert isinstance(get_embedder(client), TeiEmbedder)
        assert isinstance(get_reranker(client), TeiReranker)
        cached = get_embedder(client, FakeRedis(decode_responses=True))
        assert isinstance(cached, CachedEmbedder)
        assert cached.model == "BAAI/bge-m3"


@pytest.mark.asyncio
async def test_api_embedder_asks_for_1024_dimensions():
    seen = []

    def handler(request):
        body = json.loads(request.content)
        seen.append((str(request.url), request.headers["authorization"], body["dimensions"]))
        data = [{"index": i, "embedding": [float(i)]} for i in reversed(range(len(body["input"])))]
        return httpx.Response(200, json={"data": data})

    async with client_for(handler) as client:
        out = await ApiEmbedder("https://api.example/v1", "k", "m", client).embed(["a", "b"])
    assert out == [[0.0], [1.0]]
    assert seen == [("https://api.example/v1/embeddings", "Bearer k", 1024)]


@pytest.mark.asyncio
async def test_rerank_returns_scores_in_input_order():
    def handler(request):
        body = json.loads(request.content)
        assert body["query"] == "q"
        ranked = [{"index": i, "score": float(i) / 10} for i in range(len(body["texts"]))]
        return httpx.Response(200, json=sorted(ranked, key=lambda r: -r["score"]))

    async with client_for(handler) as client:
        scores = await TeiReranker("http://rerank", client).rerank("q", [str(i) for i in range(40)])
    assert scores[:3] == [0.0, 0.1, 0.2]
    assert scores[32:34] == [0.0, 0.1]
    assert len(scores) == 40


@pytest.mark.asyncio
async def test_similarity_reranker_scores_by_cosine():
    class Fixed:
        model = "m"
        dim = 2

        async def embed(self, texts):
            table = {"q": [1.0, 0.0], "same": [2.0, 0.0], "other": [0.0, 1.0]}
            return [table[t] for t in texts]

    scores = await SimilarityReranker(Fixed()).rerank("q", ["other", "same"])
    assert scores == [0.0, 1.0]
