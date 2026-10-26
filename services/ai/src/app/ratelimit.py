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
"""

from __future__ import annotations

import logging
import time
from collections import deque

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


def reset_for_tests() -> None:
    global _warned_missing
    _warned_missing = False
    _memory.clear()


def _missing_table(exc: BaseException) -> bool:
    state = getattr(exc, "sqlstate", "") or ""
    text = str(exc).lower()
    return state == "42P01" or (
        "rate_limits" in text and "does not exist" in text)


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
    if pool is None:
        return _memory.allow(bucket, limit, moment)
    try:
        hits = await pool.fetchval(
            CONSUME_SQL, bucket, window * 60 + 120, limit)
        if hits is None:
            return False
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
