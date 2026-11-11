"""Shared request counters.

The in-isolate limiter counted separately on every Workers isolate, so a
user could pass 600/min once per isolate. Cloudflare's Rate Limiting
binding is counted per colo, is not part of the Workers Free feature
list, and is not callable from the Python worker. Durable Objects with
the SQLite backend are on the free plan, but each check would spend the
free request quota and the Python worker would need another binding.

Neon is already connected from both workers. One upsert is visible to
every isolate and colo. The window is the UTC minute, so a burst at the
minute boundary can be allowed twice. When ``rate_limits`` is not there
yet, the call falls back to the in-isolate limiter for that request and
tries Neon again on the next one.

A request that is already at the limit does not increment the row. The
``ON CONFLICT`` update runs only while ``hits`` is still below the
limit, and an empty ``RETURNING`` means the bucket is full.

Known-full buckets are cached in-process so repeated denials skip the
shared store (deny-only; allowance always goes through Redis or Postgres).

On the Hostinger VPS (``QUEUE_BACKEND=redis``, compose Redis), counters
live in Redis; Neon ``rate_limits`` and in-process memory are fallbacks.
"""

from __future__ import annotations

import logging
import os
import time
from collections import deque
from typing import TYPE_CHECKING

from app.jobs import queue_backend

if TYPE_CHECKING:
    from redis.asyncio import Redis

logger = logging.getLogger(__name__)

# One upsert. The row lock on conflict serializes this +1 with the front
# Worker's lease. The front stops at 90% of the same bucket so a read
# burst leaves the last 10% for this path.
CONSUME_SQL = (
    "INSERT INTO rate_limits (bucket, hits, expires_at) "
    "VALUES ($1, 1, to_timestamp($2::double precision)) "
    "ON CONFLICT (bucket) DO UPDATE SET hits = rate_limits.hits + 1 "
    "WHERE rate_limits.hits < $3 "
    "RETURNING hits"
)

CONSUME_LUA = """
local hits = redis.call('INCR', KEYS[1])
if hits == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[2])
end
if hits > tonumber(ARGV[1]) then
  redis.call('DECR', KEYS[1])
  return 0
end
return hits
"""


class SlidingWindow:
    """In-process hit log per key over one window, bounded to ``max_keys``.

    Keys are kept in last-use order. Past ``max_keys`` the least recently
    used key is dropped in O(1), so a flood of new keys never costs a sweep.
    """

    __slots__ = ("window_s", "max_keys", "_hits")

    def __init__(self, window_s: float = 60.0, max_keys: int = 10_000) -> None:
        self.window_s = window_s
        self.max_keys = max_keys
        self._hits: dict[str, deque[float]] = {}

    def __len__(self) -> int:
        return len(self._hits)

    def clear(self) -> None:
        self._hits.clear()

    def allow(self, key: str, limit: int, now: float) -> bool:
        hits = self._hits.pop(key, None) or deque()
        cutoff = now - self.window_s
        while hits and hits[0] <= cutoff:
            hits.popleft()
        allowed = len(hits) < limit
        if allowed:
            hits.append(now)
        self._hits[key] = hits
        if len(self._hits) > self.max_keys:
            del self._hits[next(iter(self._hits))]
        return allowed


_warned_missing = False
_memory = SlidingWindow()
# Buckets this process has seen filled; further requests are rejected here.
_known_hits: dict[str, int] = {}
_known_window = -1
_redis: Redis | None = None
_redis_checked = False


def reset_for_tests() -> None:
    global _warned_missing, _redis, _redis_checked, _known_window
    _warned_missing = False
    _known_window = -1
    _known_hits.clear()
    _memory.clear()
    _redis = None
    _redis_checked = False


def _missing_table(exc: BaseException) -> bool:
    state = getattr(exc, "sqlstate", "") or ""
    text = str(exc).lower()
    return state == "42P01" or (
        "rate_limits" in text and "does not exist" in text)


def _sync_known_window(window: int) -> None:
    global _known_window
    if window != _known_window:
        _known_hits.clear()
        _known_window = window


def _remember_hits(bucket: str, hits: int | None, limit: int) -> None:
    if hits is None:
        _known_hits[bucket] = limit
        return
    _known_hits[bucket] = int(hits)


def _redis_url() -> str | None:
    if queue_backend() != "redis":
        return None
    url = os.environ.get("REDIS_URL", "").strip()
    return url or None


def _redis_client() -> Redis | None:
    global _redis, _redis_checked
    if _redis_checked:
        return _redis
    _redis_checked = True
    url = _redis_url()
    if url is None:
        return None
    try:
        from redis.asyncio import Redis

        _redis = Redis.from_url(url, decode_responses=True)
    except Exception:
        logger.warning("rate limit redis client unavailable; using postgres")
        _redis = None
    return _redis


async def _consume_redis(bucket: str, limit: int, ttl_s: int) -> int | None:
    client = _redis_client()
    if client is None:
        raise RuntimeError("redis not configured")
    key = f"rl:{bucket}"
    hits = await client.eval(CONSUME_LUA, 1, key, str(limit), str(ttl_s))
    if hits in (0, "0", None):
        return None
    return int(hits)


async def allow(pool, kind: str, key: str, limit: int,
                now: float | None = None) -> bool:
    """Return whether this key may proceed.

    Allowed requests increment the shared counter. A full bucket returns
    no row and is left unchanged.
    """
    global _warned_missing
    moment = time.time() if now is None else now
    window = int(moment) // 60
    ident = key or "unknown"
    bucket = f"{kind}:{ident}:{window}"
    _sync_known_window(window)
    known = _known_hits.get(bucket)
    if known is not None and known >= limit:
        return False

    ttl_s = window * 60 + 120 - int(moment)
    if ttl_s < 60:
        ttl_s = 120

    if _redis_url() is not None:
        try:
            hits = await _consume_redis(bucket, limit, ttl_s)
            if hits is None:
                _remember_hits(bucket, None, limit)
                return False
            _remember_hits(bucket, hits, limit)
            return hits <= limit
        except Exception:
            logger.warning("rate limit redis failed; falling back to postgres")

    if pool is None:
        return _memory.allow(bucket, limit, moment)
    try:
        hits = await pool.fetchval(
            CONSUME_SQL, bucket, window * 60 + 120, limit)
        if hits is None:
            _remember_hits(bucket, None, limit)
            return False
        _remember_hits(bucket, int(hits), limit)
        return int(hits) <= limit
    except Exception as exc:
        if _missing_table(exc):
            if not _warned_missing:
                _warned_missing = True
                logger.warning(
                    "rate_limits table is missing; using the in-isolate "
                    "limiter until migration 0015 is applied")
        else:
            logger.warning("rate limit query failed; using in-isolate limiter")
        return _memory.allow(bucket, limit, moment)


async def sweep(pool) -> None:
    """Drop expired minute buckets. Called from the existing cron."""
    if pool is None:
        return
    try:
        await pool.execute("DELETE FROM rate_limits WHERE expires_at < now()")
    except Exception:
        return
