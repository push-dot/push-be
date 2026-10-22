from __future__ import annotations

import os

from app.framework.flag import use_langchain

_DIST = 0.6


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
    from app.graphs.chat import _chunk_text
    return _chunk_text(text)


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


def _row_text(kind: str, row: dict) -> tuple[str, str]:
    if kind == "job":
        title = ((row.get("company") or "") + " " + (row.get("title") or "")).strip()
        return title or "job", row.get("source_text") or ""
    if kind == "posting":
        title = ((row.get("company") or "") + " " + (row.get("title") or "")).strip()
        return title or "posting", row.get("description") or ""
    if kind == "link":
        title = row.get("title") or row.get("url") or "link"
        return title, (title + "\n" + (row.get("url") or "")).strip()
    return row.get("title") or "resume", ""


async def _load_text(svc, user_id, kind: str, row: dict) -> tuple[str, str]:
    title, text = _row_text(kind, row)
    if kind == "resume":
        loader = getattr(svc.evidence, "_source_text", None)
        if loader is None:
            return title, ""
        text = await loader(user_id, row["id"])
    return title, text or ""


async def _index_evidence(svc, state) -> None:
    user_id = state["user_id"]
    try:
        missing = await svc.chunks.evidence_ids_missing(user_id, limit=10)
    except Exception:
        return
    for evidence_id in missing:
        try:
            evidence = await svc.evidence.get(user_id, evidence_id)
            texts = split_text(evidence.source_text)
            if not texts:
                continue
            vectors = await svc.ai.embed(
                texts, user_id=user_id, job_id=state.get("job_id"))
            if len(vectors) == len(texts):
                await svc.chunks.replace_chunks(
                    user_id, evidence_id, list(zip(texts, vectors)))
        except Exception:
            continue


async def _index_extra(svc, state, store) -> None:
    user_id = state["user_id"]
    for kind in ("resume", "job", "posting", "link"):
        try:
            rows = await store.missing(kind, user_id, 5)
        except Exception:
            continue
        for row in rows:
            try:
                title, text = await _load_text(svc, user_id, kind, row)
                texts = split_text(text)
                if not texts:
                    continue
                vectors = await svc.ai.embed(
                    texts, user_id=user_id, job_id=state.get("job_id"))
                if len(vectors) != len(texts):
                    continue
                await store.replace(
                    user_id, kind, row["id"], title, list(zip(texts, vectors)))
            except Exception:
                continue


async def _search_section(svc, store, state, seen: set) -> str:
    query = (state.get("text") or "")[:2000]
    vectors = await svc.ai.embed(
        [query], user_id=state["user_id"], job_id=state.get("job_id"))
    if not vectors:
        return ""
    hits = await store.search(state["user_id"], vectors[0], 6)
    return format_section(accepted_hits(hits, seen))


async def _legacy(svc, state, seen: set) -> str:
    await _index_evidence(svc, state)
    return await _search_section(svc, svc.chunks, state, seen)


async def _langchain(svc, state, seen: set) -> str:
    from app.framework import tools as tools_mod
    await _index_evidence(svc, state)
    store = getattr(svc, "rag", None)
    if store is None:
        from app.infrastructure.store_rag import RagStore
        store = RagStore(svc.db)
    await _index_extra(svc, state, store)

    async def search(query: str) -> str:
        vectors = await svc.ai.embed(
            [query[:2000]], user_id=state["user_id"],
            job_id=state.get("job_id"))
        if not vectors:
            return ""
        hits = await store.search(state["user_id"], vectors[0], 6)
        return format_section(accepted_hits(hits, seen))

    tool = tools_mod.build_search_tool(search, source_preview="")
    return await tools_mod.invoke_tool(tool, (state.get("text") or "")[:2000])


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
        _shared["retriever"] = Retriever(svc.db, get_embedder(client, redis), get_reranker(client))
    return _shared["retriever"]


async def _llamaindex(svc, state, seen: set) -> str:
    from app.rag.tenant import Tenant

    hits = await _retriever(svc).search(
        (state.get("text") or "")[:2000], Tenant(user_id=state["user_id"]), 6)
    return format_section([
        {"title": hit.citation_id, "text": hit.text}
        for hit in hits if str(hit.source_id) not in seen])


async def collect_evidence(svc, state, seen: set) -> str:
    from app.rag.retriever import rag_engine

    if rag_engine() == "llamaindex":
        return await _llamaindex(svc, state, seen)
    if use_langchain():
        return await _langchain(svc, state, seen)
    return await _legacy(svc, state, seen)
