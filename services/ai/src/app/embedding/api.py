import math

import httpx

from app.embedding.port import EmbeddingPort, batches


class ApiEmbedder:
    def __init__(self, base_url: str, api_key: str, model: str,
                 client: httpx.AsyncClient, dim: int = 1024):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.model = model
        self.client = client
        self.dim = dim

    async def embed(self, texts: list[str]) -> list[list[float]]:
        out: list[list[float]] = []
        for chunk in batches(texts):
            resp = await self.client.post(
                self.base_url + "/embeddings",
                json={"model": self.model, "input": chunk, "dimensions": self.dim},
                headers={"authorization": "Bearer " + self.api_key})
            resp.raise_for_status()
            data = sorted(resp.json().get("data") or [], key=lambda d: d["index"])
            out.extend(d["embedding"] for d in data)
        return out


def _cosine(a: list[float], b: list[float]) -> float:
    norm = math.sqrt(sum(x * x for x in a)) * math.sqrt(sum(y * y for y in b))
    return sum(x * y for x, y in zip(a, b)) / norm if norm else 0.0


class SimilarityReranker:
    def __init__(self, embedder: EmbeddingPort):
        self.embedder = embedder

    async def rerank(self, query: str, texts: list[str]) -> list[float]:
        vectors = await self.embedder.embed([query, *texts])
        return [_cosine(vectors[0], v) for v in vectors[1:]]
