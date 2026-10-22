import asyncio
import logging
import os

from redis.asyncio import Redis

from app.queue.dispatcher import Dispatcher, PgJobs
from app.queue.streams import StreamQueue


async def open_db():
    import asyncpg

    from app.db import _init_conn
    conn = await asyncpg.connect(os.environ["DATABASE_URL"])
    await _init_conn(conn)
    return PgJobs(conn)


async def main() -> None:
    import httpx

    from app.queue.alerts import alerts_from_env

    logging.basicConfig(level=logging.INFO, format="%(message)s")
    redis = Redis.from_url(os.environ["REDIS_URL"], decode_responses=True)
    client = httpx.AsyncClient(timeout=10)
    dispatcher = Dispatcher(
        StreamQueue(redis), open_db, os.environ.get("DISPATCH_SECRET", ""),
        admin_token=os.environ.get("ADMIN_TOKEN", ""), alerts=alerts_from_env(client))
    try:
        await dispatcher.run_forever()
    finally:
        await client.aclose()
        await redis.aclose()


if __name__ == "__main__":
    asyncio.run(main())
