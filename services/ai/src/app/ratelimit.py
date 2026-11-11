"""Shared request counters.

Workers (gateway, core-api) use Neon ``rate_limits``. The VPS AI API uses
in-process ``SlidingWindow`` counters when Redis is off, and Redis when
``QUEUE_BACKEND=redis`` (no Postgres on the request path). ``allow()`` with
a pool is for non-request callers (cron sweep shares the same table).
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

REDIS_BREAKER_S = 30.0
REDIS_SOCKET_TIMEOUT_S = 0.5

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
# Buckets known full in Redis or Postgres paths; short-circuits repeat denials.
_known_hits: dict[str, int] = {}
_known_window = -1
_redis: Redis | None = None
_redis_checked = False
_redis_down_until = 0.0


def reset_for_tests() -> None:
    global _warned_missing, _redis, _redis_checked, _known_window
    global _redis_down_until
    _warned_missing = False
    _known_window = -1
    _known_hits.clear()
    _memory.clear()
    _redis = None
    _redis_checked = False
    _redis_down_until = 0.0


def redis_configured() -> bool:
    if queue_backend() != "redis":
        return False
    return bool(os.environ.get("REDIS_URL", "").strip())


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


def _trip_redis_breaker(moment: float | None = None) -> None:
    global _redis_down_until
    now = time.time() if moment is None else moment
    _redis_down_until = now + REDIS_BREAKER_S


def _redis_client() -> Redis | None:
    global _redis, _redis_checked
    if _redis_checked:
        return _redis
    _redis_checked = True
    url = os.environ.get("REDIS_URL", "").strip()
    if not url or queue_backend() != "redis":
        return None
    try:
        from redis.asyncio import Redis

        _redis = Redis.from_url(
            url,
            decode_responses=True,
            socket_connect_timeout=REDIS_SOCKET_TIMEOUT_S,
            socket_timeout=REDIS_SOCKET_TIMEOUT_S,
        )
    except Exception:
        logger.warning("rate limit redis client unavailable")
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


def _bucket(kind: str, key: str, moment: float) -> tuple[str, int]:
    window = int(moment) // 60
    ident = key or "unknown"
    return f"{kind}:{ident}:{window}", window


async def allow_redis(kind: str, key: str, limit: int,
                      memory: SlidingWindow,
                      now: float | None = None) -> bool:
    """VPS AI request path: Redis with in-process fallback, no Postgres."""
    moment = time.time() if now is None else now
    bucket, window = _bucket(kind, key, moment)
    _sync_known_window(window)
    known = _known_hits.get(bucket)
    if known is not None and known >= limit:
        return False

    ident = key or "unknown"
    if moment < _redis_down_until:
        return memory.allow(ident, limit, moment)

    ttl_s = window * 60 + 120 - int(moment)
    if ttl_s < 60:
        ttl_s = 120

    try:
        hits = await _consume_redis(bucket, limit, ttl_s)
    except Exception:
        _trip_redis_breaker(moment)
        logger.warning("rate limit redis failed; using in-process window")
        return memory.allow(ident, limit, moment)

    if hits is None:
        _remember_hits(bucket, None, limit)
        return False
    _remember_hits(bucket, hits, limit)
    return hits <= limit


async def allow(pool, kind: str, key: str, limit: int,
                now: float | None = None) -> bool:
    """Postgres shared counter (Workers parity tests, non-request callers)."""
    global _warned_missing
    moment = time.time() if now is None else now
    bucket, window = _bucket(kind, key, moment)
    _sync_known_window(window)
    known = _known_hits.get(bucket)
    if known is not None and known >= limit:
        return False

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
