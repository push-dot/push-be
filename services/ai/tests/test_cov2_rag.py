"""framework/rag.py: splitter selection and retriever cache."""
from __future__ import annotations

import sys
import types
from types import SimpleNamespace

import app.framework.rag as rag


def test_split_text_uses_llamaindex_sentence_splitter_when_installed(monkeypatch):
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
    import redis.asyncio as redis_asyncio

    import app.embedding.factory as factory
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


