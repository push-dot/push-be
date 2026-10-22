from typing import Protocol

BATCH = 32


class EmbeddingPort(Protocol):
    model: str
    dim: int

    async def embed(self, texts: list[str]) -> list[list[float]]: ...


class RerankPort(Protocol):
    async def rerank(self, query: str, texts: list[str]) -> list[float]: ...


def batches(texts: list[str], size: int = BATCH) -> list[list[str]]:
    return [texts[i:i + size] for i in range(0, len(texts), size)]
