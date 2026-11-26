import asyncio
import os

NOTIFY_QUEUES = ["q:notify"]


async def main() -> None:
    import logging

    logging.basicConfig(level=logging.INFO, format="%(message)s")
    import httpx
    from redis.asyncio import Redis

    from app.db import DB, create_pool
    from app.infrastructure.store_chat_jobs import ChatJobStore, QueueJobs
    from app.queue.streams import StreamQueue
    from app.queue.worker import Worker
    from app.workers.shutdown import stop_on_signals
    from app.workers.handlers.notify import expo_push, make_notify, prune_devices, receipt_loop, remember_tickets

    pool = await create_pool(os.environ["DATABASE_URL"])
    db = DB(pool)
    redis = Redis.from_url(os.environ["REDIS_URL"], decode_responses=True)
    client = httpx.AsyncClient(timeout=10)
    expo_token = os.environ.get("EXPO_ACCESS_TOKEN", "").strip()
    push = expo_push(expo_token, client, prune_devices(db.q), remember_tickets(redis))
    receipts = asyncio.create_task(receipt_loop(expo_token, client, redis, prune_devices(db.q)))
    worker = Worker(
        StreamQueue(redis),
        QueueJobs(ChatJobStore(db)),
        os.environ.get("QUEUE_GROUP", "notify"),
        os.environ.get("QUEUE_CONSUMER", "notify-worker"),
        NOTIFY_QUEUES,
        {"notify": make_notify(db.q, push)},
        int(os.environ.get("QUEUE_CONCURRENCY", "4")),
    )
    stop_on_signals(worker.stop)
    try:
        await worker.run_forever()
    finally:
        receipts.cancel()
        await client.aclose()
        await redis.aclose()
        await pool.close()


if __name__ == "__main__":
    asyncio.run(main())
