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
"""

from __future__ import annotations

import logging
import time

logger = logging.getLogger(__name__)

CONSUME_SQL = (
    "INSERT INTO rate_limits (bucket, hits, expires_at) "
    "VALUES ($1, 1, to_timestamp($2::double precision)) "
    "ON CONFLICT (bucket) DO UPDATE SET hits = rate_limits.hits + 1 "
    "RETURNING hits"
)

_warned_missing = False
_memory: dict[str, list[float]] = {}


def reset_for_tests() -> None:
    global _warned_missing
    _warned_missing = False
    _memory.clear()


def _memory_allow(key: str, limit: int, now: float) -> bool:
    hits = _memory.setdefault(key, [])
    cutoff = now - 60
    while hits and hits[0] <= cutoff:
        hits.pop(0)
    if len(hits) >= limit:
        return False
    hits.append(now)
    if len(_memory) > 10000:
        stale = [k for k, v in _memory.items() if not v or v[-1] <= cutoff]
        for k in stale:
            _memory.pop(k, None)
    return True


def _missing_table(exc: BaseException) -> bool:
    state = getattr(exc, "sqlstate", "") or ""
    text = str(exc).lower()
    return state == "42P01" or (
        "rate_limits" in text and "does not exist" in text)


async def allow(pool, kind: str, key: str, limit: int,
                now: float | None = None) -> bool:
    """Return whether this key may proceed. Increments the shared counter."""
    global _warned_missing
    moment = time.time() if now is None else now
    window = int(moment) // 60
    ident = key or "unknown"
    bucket = f"{kind}:{ident}:{window}"
    if pool is None:
        return _memory_allow(bucket, limit, moment)
    try:
        hits = await pool.fetchval(CONSUME_SQL, bucket, window * 60 + 120)
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
        return _memory_allow(bucket, limit, moment)


async def sweep(pool) -> None:
    """Drop expired minute buckets. Called from the existing cron."""
    if pool is None:
        return
    try:
        await pool.execute("DELETE FROM rate_limits WHERE expires_at < now()")
    except Exception:
        return
