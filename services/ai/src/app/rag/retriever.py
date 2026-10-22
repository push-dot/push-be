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
