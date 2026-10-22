import httpx

from app.embedding.port import batches


class TeiEmbedder:
    def __init__(self, base_url: str, client: httpx.AsyncClient,
                 model: str = "BAAI/bge-m3", dim: int = 1024):
        self.base_url = base_url.rstrip("/")
        self.client = client
        self.model = model
        self.dim = dim

    async def embed(self, texts: list[str]) -> list[list[float]]:
        out: list[list[float]] = []
        for chunk in batches(texts):
            resp = await self.client.post(
                self.base_url + "/embed", json={"inputs": chunk, "normalize": True, "truncate": True})
            resp.raise_for_status()
            out.extend(resp.json())
        return out


class TeiReranker:
    def __init__(self, base_url: str, client: httpx.AsyncClient):
        self.base_url = base_url.rstrip("/")
        self.client = client

    async def rerank(self, query: str, texts: list[str]) -> list[float]:
        scores: list[float] = []
        for chunk in batches(texts):
            resp = await self.client.post(
                self.base_url + "/rerank", json={"query": query, "texts": chunk, "truncate": True})
            resp.raise_for_status()
            part = [0.0] * len(chunk)
            for hit in resp.json():
                part[hit["index"]] = float(hit["score"])
            scores.extend(part)
        return scores
