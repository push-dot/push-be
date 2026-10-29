from __future__ import annotations

import os

from app.framework.flag import use_langchain

_DIST = 0.6


def chunk_text(text: str, size: int = 1200, overlap: int = 150) -> list[str]:
    text = (text or "").strip()
    if not text:
        return []
    if len(text) <= size:
        return [text]
    out = []
    start = 0
    while start < len(text):
        end = min(start + size, len(text))
        cut = text.rfind("\n\n", start, end)
        if cut > start + size // 2:
            end = cut
        out.append(text[start:end].strip())
        start = end if end == len(text) else max(end - overlap, start + 1)
    return [c for c in out if c]


def split_text(text: str, splitter=None) -> list[str]:
    text = (text or "").strip()
    if not text:
        return []
    if splitter is not None:
        return [part.strip() for part in splitter(text) if part and part.strip()]
    if use_langchain():
        try:
            from llama_index.core.node_parser import SentenceSplitter
            pieces = SentenceSplitter(
                chunk_size=512, chunk_overlap=64).split_text(text)
            return [part.strip() for part in pieces if part and part.strip()]
        except ImportError:
            pass
    return chunk_text(text)


def accepted_hits(hits: list[dict], seen: set) -> list[dict]:
    return [hit for hit in hits
            if str(hit.get("evidence_id")) not in seen
            and (hit.get("dist") or 0) < _DIST]


def format_section(hits: list[dict]) -> str:
    if not hits:
        return ""
    return "[관련 근거]\n" + "\n\n".join(
        "- " + hit["title"] + "\n" + hit["text"] for hit in hits)


def import_pgvector_store():
    """Import LlamaIndex's Postgres vector store without opening a connection."""
    from llama_index.vector_stores.postgres import PGVectorStore
    return PGVectorStore


async def _index_evidence(svc, state) -> None:
    try:
        user_id = state["user_id"]
        store = svc.nodes
        embedder = _retriever(svc).embedder
        missing = await store.evidence_ids_missing_for_user(
            user_id, embedder.model, limit=10)
    except Exception:
        return
    from app.rag.pipeline import Ingestor
    from app.rag.tenant import Tenant

    ingestor = Ingestor(store, embedder)
    for evidence_id in missing:
        try:
            evidence = await svc.evidence.get(user_id, evidence_id)
            text = (getattr(evidence, "source_text", "") or "").strip()
            if not text:
                continue
            await ingestor.ingest_text(
                Tenant(user_id=user_id), "evidence", evidence_id, text)
        except Exception:
            continue


_shared: dict = {}


def _retriever(svc):
    if "retriever" not in _shared:
        import httpx

        from app.embedding.factory import get_embedder, get_reranker
        from app.rag.retriever import Retriever

        client = httpx.AsyncClient(timeout=60)
        redis = None
        if os.environ.get("REDIS_URL"):
            from redis.asyncio import Redis
            redis = Redis.from_url(os.environ["REDIS_URL"], decode_responses=True)
        _shared["retriever"] = Retriever(svc.db, get_embedder(client, redis), get_reranker(client, redis))
    return _shared["retriever"]


async def search_career_context(svc, state, seen: set) -> str:
    from app.rag.tenant import Tenant

    await _index_evidence(svc, state)
    hits = await _retriever(svc)._search_llamaindex(
        (state.get("text") or "")[:2000], Tenant(user_id=state["user_id"]), 6, None)
    return format_section([
        {"title": hit.citation_id, "text": hit.text}
        for hit in hits if str(hit.source_id) not in seen])


async def collect_evidence(svc, state, seen: set) -> str:
    return await search_career_context(svc, state, seen)
