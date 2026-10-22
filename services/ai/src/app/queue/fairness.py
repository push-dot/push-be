async def try_slot(redis, scope: str, limit: int) -> bool:
    count = int(await redis.incr(scope))
    if count > limit:
        await redis.decr(scope)
        return False
    return True


async def release_slot(redis, scope: str) -> None:
    count = int(await redis.decr(scope))
    if count < 0:
        await redis.set(scope, "0")
