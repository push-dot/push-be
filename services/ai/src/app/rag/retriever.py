from dataclasses import dataclass
from uuid import UUID

from app.rag.tenant import Tenant

CANDIDATES = 30


@dataclass(frozen=True)
class Hit:
    text: str
    source_id: UUID
    document_id: UUID | None
    score: float
    citation_id: str
    source_type: str


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
        return await self._search_llamaindex(query, tenant, k, kinds)

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
