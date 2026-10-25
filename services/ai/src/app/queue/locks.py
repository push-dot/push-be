from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from uuid import uuid4

from redis.exceptions import WatchError


class LockBusy(Exception):
    pass


async def acquire_lock(redis, key: str, ttl_s: int) -> str | None:
    token = str(uuid4())
    ok = await redis.set(key, token, nx=True, ex=ttl_s)
    return token if ok else None


async def _if_owner(redis, key: str, token: str, apply: Callable[[object], None]) -> bool:
    """Run ``apply`` in a MULTI only while ``key`` still holds ``token`` (WATCH, no Lua)."""
    async with redis.pipeline(transaction=True) as pipe:
        try:
            await pipe.watch(key)
            if await pipe.get(key) != token:
                await pipe.unwatch()
                return False
            pipe.multi()
            apply(pipe)
            await pipe.execute()
            return True
        except WatchError:
            return False


async def release_lock(redis, key: str, token: str) -> None:
    await _if_owner(redis, key, token, lambda pipe: pipe.delete(key))


async def extend_lock(redis, key: str, token: str, ttl_s: int) -> bool:
    return await _if_owner(redis, key, token, lambda pipe: pipe.expire(key, ttl_s))


@asynccontextmanager
async def job_lock(redis, key: str, ttl_s: int) -> AsyncIterator[Callable[[], Awaitable[bool]]]:
    """Hold ``key`` for the block; yields a callable that renews the TTL."""
    token = await acquire_lock(redis, key, ttl_s)
    if token is None:
        raise LockBusy()
    try:
        yield lambda: extend_lock(redis, key, token, ttl_s)
    finally:
        await release_lock(redis, key, token)
