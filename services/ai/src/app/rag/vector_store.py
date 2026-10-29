from typing import Any
from uuid import UUID

from llama_index.core.bridge.pydantic import PrivateAttr
from llama_index.core.schema import TextNode
from llama_index.core.vector_stores.types import (
    BasePydanticVectorStore,
    FilterOperator,
    MetadataFilters,
    VectorStoreQuery,
    VectorStoreQueryResult,
)

from app.rag.store import vector_literal

_TENANT = (
    "(($2::uuid IS NOT NULL AND user_id = $2) OR ($3::uuid IS NOT NULL AND company_id = $3)) "
    "AND ($4::text IS NULL OR embedding_model = $4) "
    "AND ($5::text[] IS NULL OR source_type = ANY($5::text[]))")

_COLS = "id, user_id, company_id, source_type, source_id, document_id, seq, text, metadata"

_DENSE = (
    f"SELECT {_COLS}, 1 - (embedding <=> $1::vector) AS similarity FROM rag_nodes "
    f"WHERE {_TENANT} ORDER BY embedding <=> $1::vector LIMIT $6")

_TRIGRAM = (
    f"SELECT {_COLS}, word_similarity($1, text) AS similarity FROM rag_nodes "
    f"WHERE {_TENANT} AND $1 <% text ORDER BY word_similarity($1, text) DESC LIMIT $6")


def _filters_of(filters: MetadataFilters | None):
    if filters is None:
        return
    for item in filters.filters:
        if isinstance(item, MetadataFilters):
            yield from _filters_of(item)
        else:
            yield item


def _uuid(value) -> UUID | None:
    if value in (None, ""):
        return None
    return UUID(str(value))


def require_tenant(filters: MetadataFilters | None):
    users: list[UUID] = []
    companies: list[UUID] = []
    model = None
    kinds = None
    for item in _filters_of(filters):
        if item.key == "user_id" and item.operator == FilterOperator.EQ:
            parsed = _uuid(item.value)
            if parsed is not None:
                users.append(parsed)
        elif item.key == "company_id" and item.operator == FilterOperator.EQ:
            parsed = _uuid(item.value)
            if parsed is not None:
                companies.append(parsed)
        elif item.key == "embedding_model" and item.operator == FilterOperator.EQ and item.value:
            model = str(item.value)
        elif item.key == "source_type" and item.operator == FilterOperator.IN and item.value:
            kinds = [str(value) for value in item.value]
        elif item.key == "source_type" and item.operator == FilterOperator.EQ and item.value:
            kinds = [str(item.value)]
    if not users and not companies or len(users) > 1 or len(companies) > 1:
        raise ValueError("query requires a user or company filter")
    return (users[0] if users else None, companies[0] if companies else None, model, kinds)


def _node(row: dict) -> tuple[TextNode, float]:
    metadata: dict[str, Any] = {
        "source_type": row["source_type"],
        "source_id": str(row["source_id"]),
        "seq": int(row["seq"]),
    }
    if row["user_id"] is not None:
        metadata["user_id"] = str(row["user_id"])
    if row["company_id"] is not None:
        metadata["company_id"] = str(row["company_id"])
    if row["document_id"] is not None:
        metadata["document_id"] = str(row["document_id"])
    node = TextNode(id_=str(row["id"]), text=row["text"], metadata=metadata)
    return node, float(row["similarity"])


def _fuse(dense: list[dict], keyword: list[dict]) -> list[tuple[TextNode, float]]:
    best: dict[str, tuple[TextNode, float]] = {}
    for batch in (dense, keyword):
        for row in batch:
            node, score = _node(row)
            current = best.get(node.node_id)
            if current is None or score > current[1]:
                best[node.node_id] = (node, score)
    return sorted(best.values(), key=lambda item: item[1], reverse=True)


class RagNodesStore(BasePydanticVectorStore):
    stores_text: bool = True
    _db: Any = PrivateAttr()

    def __init__(self, db: Any, **kwargs: Any) -> None:
        super().__init__(stores_text=True, **kwargs)
        self._db = db

    @property
    def client(self) -> Any:
        return self._db

    def add(self, nodes, **kwargs) -> list[str]:
        raise NotImplementedError

    def delete(self, ref_doc_id: str, **delete_kwargs: Any) -> None:
        raise NotImplementedError

    def query(self, query: VectorStoreQuery, **kwargs: Any) -> VectorStoreQueryResult:
        raise NotImplementedError

    async def aquery(self, query: VectorStoreQuery, **kwargs: Any) -> VectorStoreQueryResult:
        user_id, company_id, model, kinds = require_tenant(query.filters)
        limit = query.similarity_top_k

        async def work():
            q = self._db.q()
            dense: list[dict] = []
            keyword: list[dict] = []
            if query.query_embedding:
                dense = await q.fetch(
                    _DENSE, vector_literal(list(query.query_embedding)),
                    user_id, company_id, model, kinds, limit)
            if query.query_str:
                await q.execute("SET LOCAL pg_trgm.word_similarity_threshold = 0.3")
                keyword = await q.fetch(
                    _TRIGRAM, query.query_str[:200], user_id, company_id, model, kinds, limit)
            return dense, keyword

        dense, keyword = await self._db.run(work)
        ranked = _fuse(list(dense), list(keyword))[:limit]
        nodes = [node for node, _score in ranked]
        return VectorStoreQueryResult(
            nodes=nodes,
            similarities=[score for _node, score in ranked],
            ids=[node.node_id for node in nodes],
        )
