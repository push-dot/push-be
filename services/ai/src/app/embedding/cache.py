import hashlib
import json

from app.embedding.port import EmbeddingPort

TTL_S = 30 * 24 * 3600


def cache_key(model: str, text: str) -> str:
    return "emb:" + hashlib.sha256((model + "\n" + text).encode()).hexdigest()


class CachedEmbedder:
    def __init__(self, inner: EmbeddingPort, redis, ttl_s: int = TTL_S):
        self.inner = inner
        self.redis = redis
        self.ttl_s = ttl_s
        self.model = inner.model
        self.dim = inner.dim

    async def embed(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []
        keys = [cache_key(self.model, t) for t in texts]
        hits = await self.redis.mget(keys)
        missing = sorted({t for t, hit in zip(texts, hits) if hit is None}, key=texts.index)
        fresh = dict(zip(missing, await self.inner.embed(missing))) if missing else {}
        for text, vector in fresh.items():
            await self.redis.set(cache_key(self.model, text), json.dumps(vector), ex=self.ttl_s)
        return [json.loads(hit) if hit is not None else fresh[t] for t, hit in zip(texts, hits)]
