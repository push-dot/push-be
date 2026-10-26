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
        missing = list(dict.fromkeys(t for t, hit in zip(texts, hits) if hit is None))
        fresh: dict[str, list[float]] = {}
        if missing:
            vectors = await self.inner.embed(missing)
            if len(vectors) != len(missing):
                raise ValueError("embedder returned %d vectors for %d texts" % (len(vectors), len(missing)))
            fresh = dict(zip(missing, vectors))
            async with self.redis.pipeline(transaction=False) as pipe:
                for text, vector in fresh.items():
                    pipe.set(cache_key(self.model, text), json.dumps(vector), ex=self.ttl_s)
                await pipe.execute()
        return [json.loads(hit) if hit is not None else fresh[t] for t, hit in zip(texts, hits)]
