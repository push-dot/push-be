import os
from dataclasses import dataclass
from uuid import UUID

from app.rag.store import vector_literal
from app.rag.tenant import Tenant

CANDIDATES = 30

_FILTER = (
    "(($2::uuid IS NOT NULL AND user_id = $2) OR ($3::uuid IS NOT NULL AND company_id = $3)) "
    "AND embedding_model = $4 AND ($5::text[] IS NULL OR source_type = ANY($5::text[]))")

_COLS = "id, user_id, company_id, source_type, source_id, document_id, seq, text"

_DENSE = (
    f"SELECT {_COLS} FROM rag_nodes WHERE {_FILTER} "
    "ORDER BY embedding <=> $1::vector LIMIT $6")

_TRIGRAM = (
    f"SELECT {_COLS} FROM rag_nodes WHERE {_FILTER} AND $1 <% text "
    "ORDER BY word_similarity($1, text) DESC LIMIT $6")


@dataclass(frozen=True)
class Hit:
    text: str
    source_id: UUID
    document_id: UUID | None
    score: float
    citation_id: str
    source_type: str


def rag_engine() -> str:
    mode = (os.environ.get("RAG_ENGINE") or "legacy").strip().lower()
    return mode if mode in ("legacy", "llamaindex") else "legacy"


class Retriever:
    def __init__(self, db, embedder, reranker, candidates: int = CANDIDATES):
        self.db = db
        self.embedder = embedder
        self.reranker = reranker
        self.candidates = candidates

    async def search(self, query: str, tenant: Tenant | None, k: int = 5, *,
                     kinds: list[str] | None = None) -> list[Hit]:
        if not isinstance(tenant, Tenant):
            raise ValueError("search requires a tenant")
        if rag_engine() == "llamaindex":
            return await self._search_llamaindex(query, tenant, k, kinds)
        filters = (tenant.user_id, tenant.company_id, self.embedder.model, kinds, self.candidates)
        vector = (await self.embedder.embed([query[:2000]]))[0]

        async def work():
            q = self.db.q()
            dense = await q.fetch(_DENSE, vector_literal(vector), *filters)
            await q.execute("SET LOCAL pg_trgm.word_similarity_threshold = 0.3")
            trigram = await q.fetch(_TRIGRAM, query[:200], *filters)
            return dense, trigram

        dense, trigram = await self.db.run(work)
        merged = list({row["id"]: row for row in [*dense, *trigram]}.values())
        if not merged:
            return []
        scores = await self.reranker.rerank(query, [row["text"] for row in merged])
        ranked = sorted(zip(scores, merged), key=lambda pair: pair[0], reverse=True)[:k]
        return [Hit(
            text=row["text"],
            source_id=row["source_id"],
            document_id=row["document_id"],
            score=float(score),
            citation_id=f"{row['source_type']}:{row['source_id']}:{row['seq']}",
            source_type=row["source_type"],
        ) for score, row in ranked]

    async def _search_llamaindex(self, query: str, tenant: Tenant, k: int, kinds: list[str] | None):
        from llama_index.core import VectorStoreIndex
        from llama_index.core.vector_stores.types import (
            FilterOperator,
            MetadataFilter,
            MetadataFilters,
        )

        from app.rag.llama_adapters import TeiEmbedding, TeiRerank
        from app.rag.vector_store import RagNodesStore

        items = []
        if tenant.user_id is not None:
            items.append(MetadataFilter(key="user_id", value=str(tenant.user_id)))
        if tenant.company_id is not None:
            items.append(MetadataFilter(key="company_id", value=str(tenant.company_id)))
        items.append(MetadataFilter(key="embedding_model", value=self.embedder.model))
        if kinds:
            items.append(MetadataFilter(
                key="source_type", value=list(kinds), operator=FilterOperator.IN))
        index = VectorStoreIndex.from_vector_store(
            RagNodesStore(self.db), embed_model=TeiEmbedding(self.embedder))
        nodes = await index.as_retriever(
            filters=MetadataFilters(filters=items),
            similarity_top_k=self.candidates,
        ).aretrieve(query[:2000])
        reranked = await TeiRerank(self.reranker, top_n=k).apostprocess_nodes(
            nodes, query_str=query)
        return [_hit(item) for item in reranked]


def _hit(item) -> Hit:
    meta = item.node.metadata
    document_id = meta.get("document_id")
    return Hit(
        text=item.node.get_content(),
        source_id=UUID(str(meta["source_id"])),
        document_id=UUID(str(document_id)) if document_id else None,
        score=float(item.score or 0),
        citation_id="%s:%s:%s" % (meta["source_type"], meta["source_id"], meta["seq"]),
        source_type=str(meta["source_type"]),
    )
