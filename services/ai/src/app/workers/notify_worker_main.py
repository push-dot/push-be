import asyncio
import os

NOTIFY_QUEUES = ["q:notify"]


async def main() -> None:
    import httpx
    from redis.asyncio import Redis

    from app.db import DB, create_pool
    from app.infrastructure.store_chat_jobs import ChatJobStore, QueueJobs
    from app.queue.streams import StreamQueue
    from app.queue.worker import Worker
    from app.workers.handlers.notify import expo_push, make_notify

    pool = await create_pool(os.environ["DATABASE_URL"])
    db = DB(pool)
    redis = Redis.from_url(os.environ["REDIS_URL"], decode_responses=True)
    client = httpx.AsyncClient(timeout=10)
    push = expo_push(os.environ.get("EXPO_ACCESS_TOKEN", "").strip(), client)
    worker = Worker(
        StreamQueue(redis),
        QueueJobs(ChatJobStore(db)),
        os.environ.get("QUEUE_GROUP", "notify"),
        os.environ.get("QUEUE_CONSUMER", "notify-worker"),
        NOTIFY_QUEUES,
        {"notify": make_notify(db.q, push)},
        int(os.environ.get("QUEUE_CONCURRENCY", "4")),
    )
    try:
        await worker.run_forever()
    finally:
        await client.aclose()
        await redis.aclose()
        await pool.close()


if __name__ == "__main__":
    asyncio.run(main())
