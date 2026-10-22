"""Measure embedding throughput against the configured provider.

    cd services/ai
    TEI_EMBED_URL=http://embed:80 python scripts/bench_embed.py

Prints sentences per second and the time a typical upload would take
(BENCH_CHUNKS chunks, default 60, about a 10-page resume at 512 tokens).
The target is under 30 seconds per upload. Uses no cache.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

import httpx

from app.embedding.factory import get_embedder

SENTENCE = "저는 5년 동안 결제 시스템 백엔드를 운영하며 장애 대응 시간을 40% 줄였습니다. "


async def main() -> None:
    total = int(os.environ.get("BENCH_SENTENCES", "256"))
    chunks = int(os.environ.get("BENCH_CHUNKS", "60"))
    texts = [f"{i} {SENTENCE * 8}" for i in range(total)]
    async with httpx.AsyncClient(timeout=300) as client:
        embedder = get_embedder(client)
        await embedder.embed(texts[:2])
        started = time.perf_counter()
        await embedder.embed(texts)
        elapsed = time.perf_counter() - started
    rate = total / elapsed
    print(json.dumps({
        "model": embedder.model,
        "sentences": total,
        "seconds": round(elapsed, 2),
        "sentencesPerSec": round(rate, 2),
        "uploadSeconds": round(chunks / rate, 2),
        "meetsTarget": chunks / rate <= 30,
    }))


if __name__ == "__main__":
    asyncio.run(main())
