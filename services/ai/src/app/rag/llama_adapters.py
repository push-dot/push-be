import asyncio
from typing import Any

from llama_index.core.base.embeddings.base import BaseEmbedding
from llama_index.core.bridge.pydantic import Field, PrivateAttr
from llama_index.core.postprocessor.types import BaseNodePostprocessor
from llama_index.core.schema import NodeWithScore, QueryBundle

from app.embedding.port import BATCH


class TeiEmbedding(BaseEmbedding):
    _embedder: Any = PrivateAttr()

    def __init__(self, embedder: Any, **kwargs: Any) -> None:
        super().__init__(model_name=embedder.model, embed_batch_size=BATCH, **kwargs)
        self._embedder = embedder

    def _vectors(self, texts: list[str]) -> list[list[float]]:
        return asyncio.run(self._embedder.embed(texts))

    def _get_query_embedding(self, query: str) -> list[float]:
        return self._vectors([query])[0]

    async def _aget_query_embedding(self, query: str) -> list[float]:
        return (await self._embedder.embed([query]))[0]

    def _get_text_embedding(self, text: str) -> list[float]:
        return self._vectors([text])[0]

    async def _aget_text_embeddings(self, texts: list[str]) -> list[list[float]]:
        return await self._embedder.embed(list(texts))


class TeiRerank(BaseNodePostprocessor):
    top_n: int = Field(default=5, gt=0)
    _reranker: Any = PrivateAttr()

    def __init__(self, reranker: Any, top_n: int = 5, **kwargs: Any) -> None:
        super().__init__(top_n=top_n, **kwargs)
        self._reranker = reranker

    def _postprocess_nodes(
        self, nodes: list[NodeWithScore], query_bundle: QueryBundle | None = None,
    ) -> list[NodeWithScore]:
        return asyncio.run(self._apostprocess_nodes(nodes, query_bundle))

    async def _apostprocess_nodes(
        self, nodes: list[NodeWithScore], query_bundle: QueryBundle | None = None,
    ) -> list[NodeWithScore]:
        if not nodes:
            return []
        query = query_bundle.query_str if query_bundle is not None else ""
        texts = [item.node.get_content() for item in nodes]
        scores = await self._reranker.rerank(query, texts)
        if len(scores) != len(nodes):
            raise ValueError(
                "reranker returned %d scores for %d nodes" % (len(scores), len(nodes)))
        order = sorted(
            range(len(nodes)), key=lambda index: scores[index], reverse=True)[: self.top_n]
        return [
            NodeWithScore(node=nodes[index].node, score=float(scores[index])) for index in order]
