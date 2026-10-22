from contextlib import asynccontextmanager
from uuid import uuid4


class LockBusy(Exception):
    pass


async def acquire_lock(redis, key: str, ttl_s: int):
    token = str(uuid4())
    ok = await redis.set(key, token, nx=True, ex=ttl_s)
    if not ok:
        return None
    return token


async def release_lock(redis, key: str, token: str) -> None:
    current = await redis.get(key)
    if current == token:
        await redis.delete(key)


@asynccontextmanager
async def job_lock(redis, key: str, ttl_s: int):
    token = await acquire_lock(redis, key, ttl_s)
    if token is None:
        raise LockBusy()
    try:
        yield token
    finally:
        await release_lock(redis, key, token)
