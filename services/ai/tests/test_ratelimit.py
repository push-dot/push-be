from app.pgproto import PgError
from app.ratelimit import allow, reset_for_tests, sweep


class _Pool:
    def __init__(self, hits=1, error=None):
        self.hits = hits
        self.error = error
        self.calls = []
        self.swept = False

    async def fetchval(self, sql, *args):
        self.calls.append((sql, args))
        if self.error is not None:
            raise self.error
        return self.hits

    async def execute(self, sql, *args):
        self.swept = True
        if self.error is not None:
            raise self.error


async def test_shared_counter_allows_until_limit():
    reset_for_tests()
    pool = _Pool(hits=2)
    assert await allow(pool, "user", "u1", 2, now=1_700_000_000.0) is True
    pool.hits = 3
    assert await allow(pool, "user", "u1", 2, now=1_700_000_000.0) is False
    bucket = pool.calls[0][1][0]
    assert bucket.startswith("user:u1:")
    assert "rate_limits" in pool.calls[0][0]
    assert "hits <" in pool.calls[0][0]
    assert pool.calls[0][1][2] == 2
    assert pool.calls[1][1][2] == 2


async def test_full_bucket_does_not_increment():
    reset_for_tests()
    pool = _Pool(hits=None)
    assert await allow(pool, "user", "u1", 2, now=1_700_000_000.0) is False
    assert pool.calls[0][1][2] == 2


async def test_missing_table_falls_back_to_memory_then_retries():
    reset_for_tests()
    missing = _Pool(error=PgError("42P01", 'relation "rate_limits" does not exist'))
    assert await allow(missing, "ip", "1.2.3.4", 1, now=1_700_000_000.0) is True
    assert await allow(missing, "ip", "1.2.3.4", 1, now=1_700_000_010.0) is False
    assert len(missing.calls) == 2
    ready = _Pool(hits=1)
    assert await allow(ready, "ip", "1.2.3.4", 1, now=1_700_000_020.0) is True


async def test_sweep_ignores_a_missing_table():
    reset_for_tests()
    pool = _Pool(error=PgError("42P01", 'relation "rate_limits" does not exist'))
    await sweep(pool)
    assert pool.swept is True


def test_sliding_window_counts_per_key_inside_the_window():
    from app.ratelimit import SlidingWindow
    rl = SlidingWindow(window_s=10)
    assert rl.allow("a", 2, 0) and rl.allow("a", 2, 1)
    assert not rl.allow("a", 2, 2)
    assert rl.allow("b", 2, 2)
    assert rl.allow("a", 2, 10.5)


def test_sliding_window_drops_the_least_recently_used_key_in_constant_time():
    # Past max_keys the old code rebuilt the whole dict on every request.
    from app.ratelimit import SlidingWindow
    rl = SlidingWindow(window_s=60, max_keys=3)
    for key in ("a", "b", "c"):
        assert rl.allow(key, 1, 0)
    assert not rl.allow("a", 1, 1)  # touching "a" makes "b" the oldest
    assert rl.allow("d", 1, 1)
    assert len(rl) == 3
    assert rl.allow("b", 1, 1)  # "b" was evicted, so its window restarted
    assert not rl.allow("a", 1, 1)
