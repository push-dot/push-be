import asyncio
import os

INGEST_QUEUES = ["q:ingest"]


async def main() -> None:
    import logging

    logging.basicConfig(level=logging.INFO, format="%(message)s")
    import httpx
    from redis.asyncio import Redis

    from app.db import DB, create_pool
    from app.embedding.factory import get_embedder
    from app.infrastructure.store_chat_jobs import ChatJobStore, QueueJobs
    from app.queue.streams import StreamQueue
    from app.queue.worker import Worker
    from app.workers.shutdown import stop_on_signals
    from app.rag.pipeline import Ingestor
    from app.rag.store import RagNodeStore
    from app.workers.handlers.ingest import make_ingest

    pool = await create_pool(os.environ["DATABASE_URL"])
    db = DB(pool)
    redis = Redis.from_url(os.environ["REDIS_URL"], decode_responses=True)
    client = httpx.AsyncClient(timeout=120)
    store = RagNodeStore(db)
    # No embedding cache here: bulk ingest vectors would evict TTL'd queue locks
    # under Redis volatile-lru. Query-time caching stays on the API path.
    ingestor = Ingestor(store, get_embedder(client))
    worker = Worker(
        StreamQueue(redis),
        QueueJobs(ChatJobStore(db)),
        os.environ.get("QUEUE_GROUP", "ingest"),
        os.environ.get("QUEUE_CONSUMER", "ingest-worker"),
        INGEST_QUEUES,
        {"ingest": make_ingest(db.q, store, ingestor, client)},
        int(os.environ.get("QUEUE_CONCURRENCY", "2")),
        min_idle_ms=600_000,
    )
    stop_on_signals(worker.stop)
    try:
        await worker.run_forever()
    finally:
        await client.aclose()
        await redis.aclose()
        await pool.close()


if __name__ == "__main__":
    asyncio.run(main())
