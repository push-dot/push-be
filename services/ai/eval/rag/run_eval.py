"""Retrieval quality on the synthetic set in fixtures/.

    cd services/ai
    python eval/rag/run_eval.py

Runs in memory on the llamaindex chunker. No database writes. Prints one
JSON line with recall@k, MRR and grounded_rate (share of queries whose
top-k text contains an expected answer term). The fixtures are made up;
never add real user data.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "src"))

FIXTURES = Path(__file__).resolve().parent / "fixtures"


def load(fixtures: Path = FIXTURES) -> tuple[list[dict], list[dict]]:
    docs = json.loads((fixtures / "docs.json").read_text())
    queries = json.loads((fixtures / "queries.json").read_text())
    return docs, queries


def recall_at_k(ranked: list[str], relevant: list[str], k: int) -> float:
    return len(set(ranked[:k]) & set(relevant)) / len(relevant)


def reciprocal_rank(ranked: list[str], relevant: list[str]) -> float:
    for rank, doc_id in enumerate(ranked, 1):
        if doc_id in relevant:
            return 1 / rank
    return 0.0


def grounded(texts: list[str], terms: list[str]) -> bool:
    return any(term in text for text in texts for term in terms)


def _cosine(a: list[float], b: list[float]) -> float:
    norm = math.sqrt(sum(x * x for x in a)) * math.sqrt(sum(y * y for y in b))
    return sum(x * y for x, y in zip(a, b)) / norm if norm else 0.0


def _trigrams(text: str) -> set[str]:
    padded = "  " + text.lower() + " "
    return {padded[i:i + 3] for i in range(len(padded) - 2)}


def word_similarity(query: str, text: str) -> float:
    q = _trigrams(query)
    return len(q & _trigrams(text)) / len(q) if q else 0.0


def llamaindex_chunks(text: str) -> list[str]:
    from app.rag.pipeline import split_nodes
    return [n.get_content() for n in split_nodes(text, {})]


class Engine:
    def __init__(self, embedder, reranker):
        self.embedder = embedder
        self.reranker = reranker
        self.chunks: list[dict] = []

    async def index(self, docs: list[dict]) -> None:
        for doc in docs:
            texts = llamaindex_chunks(doc["text"])
            vectors = await self.embedder.embed(texts) if texts else []
            self.chunks.extend(
                {"doc": doc["id"], "tenant": doc["tenant"], "text": t, "vector": v}
                for t, v in zip(texts, vectors))

    async def search(self, query: str, tenant: str, k: int) -> list[dict]:
        pool = [c for c in self.chunks if c["tenant"] == tenant]
        vector = (await self.embedder.embed([query]))[0]
        dense = sorted(pool, key=lambda c: _cosine(vector, c["vector"]), reverse=True)
        keyword = sorted(pool, key=lambda c: word_similarity(query, c["text"]), reverse=True)
        keyword = [c for c in keyword if word_similarity(query, c["text"]) >= 0.3]
        merged = list({id(c): c for c in [*dense[:30], *keyword[:30]]}.values())
        if not merged:
            return []
        scores = await self.reranker.rerank(query, [c["text"] for c in merged])
        return [c for _, c in sorted(zip(scores, merged), key=lambda p: p[0], reverse=True)][:k]


async def evaluate(engine: Engine, docs: list[dict], queries: list[dict], k: int = 5) -> dict:
    await engine.index(docs)
    recall = rr = hits = 0.0
    for q in queries:
        top = await engine.search(q["query"], q["tenant"], k)
        ranked = list(dict.fromkeys(c["doc"] for c in top))
        recall += recall_at_k(ranked, q["relevant"], k)
        rr += reciprocal_rank(ranked, q["relevant"])
        hits += grounded([c["text"] for c in top], q["answerTerms"])
    n = len(queries)
    return {
        "engine": "llamaindex",
        "queries": n,
        f"recall@{k}": round(recall / n, 4),
        "mrr": round(rr / n, 4),
        "grounded_rate": round(hits / n, 4),
    }


async def main() -> None:
    import httpx

    from app.embedding.factory import get_embedder, get_reranker

    parser = argparse.ArgumentParser()
    parser.add_argument("--k", type=int, default=5)
    args = parser.parse_args()
    docs, queries = load()
    async with httpx.AsyncClient(timeout=120) as client:
        engine = Engine(get_embedder(client), get_reranker(client))
        print(json.dumps(await evaluate(engine, docs, queries, args.k)))


if __name__ == "__main__":
    asyncio.run(main())
