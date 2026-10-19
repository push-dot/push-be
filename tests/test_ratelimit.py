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
