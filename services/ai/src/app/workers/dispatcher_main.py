import asyncio
import os

from redis.asyncio import Redis

from app.queue.dispatcher import Dispatcher, PgJobs
from app.queue.streams import StreamQueue


async def open_db():
    import asyncpg
    conn = await asyncpg.connect(os.environ["DATABASE_URL"])
    return PgJobs(conn)


async def main() -> None:
    redis = Redis.from_url(os.environ["REDIS_URL"], decode_responses=True)
    dispatcher = Dispatcher(StreamQueue(redis), open_db, os.environ.get("DISPATCH_SECRET", ""))
    try:
        await dispatcher.run_forever()
    finally:
        await redis.aclose()


if __name__ == "__main__":
    asyncio.run(main())
