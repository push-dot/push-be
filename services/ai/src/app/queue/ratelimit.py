import asyncio
import time

sleep = asyncio.sleep
monotonic = time.monotonic


async def acquire_token(redis, bucket: str, rate: float, burst: int) -> None:
    while True:
        now = monotonic()
        raw = await redis.get(bucket)
        if raw:
            tokens_s, ts_s = str(raw).split("|", 1)
            tokens = min(float(burst), float(tokens_s) + (now - float(ts_s)) * rate)
        else:
            tokens = float(burst)
        if tokens >= 1:
            await redis.set(bucket, f"{tokens - 1}|{now}")
            return
        await sleep((1 - tokens) / rate if rate else 0.01)
