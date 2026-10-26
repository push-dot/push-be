from typing import Final

# A slot not refreshed by a heartbeat for this long belongs to a dead worker.
SLOT_STALE_S: Final = 900


async def try_slot(redis, scope: str, limit: int, member: str, now: float) -> bool:
    """Take one of ``limit`` slots in ``scope``; slots of crashed workers age out."""
    async with redis.pipeline(transaction=True) as pipe:
        pipe.zremrangebyscore(scope, "-inf", now - SLOT_STALE_S)
        pipe.zadd(scope, {member: now})
        pipe.zcard(scope)
        pipe.expire(scope, SLOT_STALE_S)
        _, _, count, _ = await pipe.execute()
    if count > limit:
        await redis.zrem(scope, member)
        return False
    return True


async def refresh_slot(redis, scope: str, member: str, now: float) -> None:
    async with redis.pipeline(transaction=True) as pipe:
        pipe.zadd(scope, {member: now}, xx=True)
        pipe.expire(scope, SLOT_STALE_S)
        await pipe.execute()


async def release_slot(redis, scope: str, member: str) -> None:
    await redis.zrem(scope, member)
