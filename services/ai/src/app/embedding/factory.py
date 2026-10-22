import os

import httpx

from app.embedding.api import ApiEmbedder, SimilarityReranker
from app.embedding.cache import CachedEmbedder
from app.embedding.tei import TeiEmbedder, TeiReranker


def _env(name: str, default: str) -> str:
    return os.environ.get(name, "").strip() or default


def _provider() -> str:
    return _env("EMBEDDING_PROVIDER", "tei").lower()


def _api(client: httpx.AsyncClient) -> ApiEmbedder:
    return ApiEmbedder(
        _env("EMBEDDING_API_BASE_URL", _env("AI_BASE_URL", "https://openrouter.ai/api/v1")),
        _env("EMBEDDING_API_KEY", os.environ.get("OPENROUTER_API_KEY", "")),
        _env("EMBEDDING_API_MODEL", "openai/text-embedding-3-small"),
        client)


def get_embedder(client: httpx.AsyncClient, redis=None):
    if _provider() == "api":
        inner = _api(client)
    else:
        inner = TeiEmbedder(_env("TEI_EMBED_URL", "http://embed:80"), client,
                            model=_env("TEI_EMBED_MODEL", "BAAI/bge-m3"))
    return CachedEmbedder(inner, redis) if redis is not None else inner


def get_reranker(client: httpx.AsyncClient):
    if _provider() == "api":
        return SimilarityReranker(_api(client))
    return TeiReranker(_env("TEI_RERANK_URL", "http://rerank:80"), client)
