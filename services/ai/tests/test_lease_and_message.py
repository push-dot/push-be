"""Quota leases stay under the shared cap, and enqueue stores the user message."""

from __future__ import annotations

import asyncio
import os
import socket
from uuid import uuid4

import pytest

from app.pgproto import PgPool
from app.ratelimit import CONSUME_SQL

DSN = os.environ.get(
    "PGPROTO_DSN", "postgresql://push:push@127.0.0.1:5432/push?sslmode=disable")

LEASE_BATCH = 20
# Same grant as services/gateway/src/middleware/ratelimit.ts. $4 is the batch, $5 is unused hits
# being returned. The increment is stored as whole seconds on expires_at.
# Near the cap the grant shrinks to max(1, room / 16) and never past room.
_AFTER = "GREATEST(0, rate_limits.hits - GREATEST($5::int, 0))"
_ROOM = "GREATEST(0, $2::int - " + _AFTER + ")"
_SHRINK = "CASE WHEN " + _ROOM + " = 0 THEN 0 ELSE GREATEST(1, " + _ROOM + " / 16) END"
_INSERT = "LEAST($4::int, $2::int, CASE WHEN $2::int = 0 THEN 0 ELSE GREATEST(1, $2::int / 16) END)"
_UPDATE = "LEAST($4::int, " + _ROOM + ", " + _SHRINK + ")"
LEASE_SQL = (
    "WITH bumped AS ("
    "INSERT INTO rate_limits (bucket, hits, expires_at) "
    "VALUES ($1, " + _INSERT + ", "
    "to_timestamp($3::double precision) + " + _INSERT + " * interval '1 second') "
    "ON CONFLICT (bucket) DO UPDATE SET "
    "hits = " + _AFTER + " + " + _UPDATE + ", "
    "expires_at = to_timestamp($3::double precision) + " + _UPDATE + " * interval '1 second' "
    "WHERE $5::int > 0 OR rate_limits.hits < $2 "
    "RETURNING hits, "
    "(EXTRACT(EPOCH FROM expires_at) - $3::double precision)::bigint AS granted"
    ") SELECT hits, granted FROM bumped"
)


def _postgres_up() -> bool:
    try:
        with socket.create_connection(("127.0.0.1", 5432), timeout=1):
            return True
    except OSError:
        return False


class _Rec:
    def __init__(self):
        self.calls = []

    async def fetchrow(self, sql, *args):
        self.calls.append((sql, args))
        return None


class _DB:
    def __init__(self, conn):
        self.pool = conn

    def q(self):
        return self.pool


@pytest.mark.skipif(not _postgres_up(), reason="postgres not reachable")
@pytest.mark.asyncio
async def test_lease_claims_never_pass_the_limit():
    schema = "lease_" + uuid4().hex[:8]
    bucket = "user:" + str(uuid4()) + ":1"
    limit = 50
    pools = [PgPool(DSN, transport="tcp") for _ in range(4)]
    try:
        await pools[0].execute(f"CREATE SCHEMA {schema}")
        for pool in pools:
            await pool.execute(f"SET search_path TO {schema}")
        await pools[0].execute(
            "CREATE TABLE rate_limits ("
            "bucket text PRIMARY KEY, hits integer NOT NULL, "
            "expires_at timestamptz NOT NULL)")

        async def claim(pool: PgPool) -> int:
            row = await pool.fetchrow(LEASE_SQL, bucket, limit, 2_000_000_000, LEASE_BATCH, 0)
            if row is None or row["hits"] is None:
                return 0
            return int(row["granted"] or 0)

        async def plus_one(pool: PgPool) -> int:
            hits = await pool.fetchval(CONSUME_SQL, bucket, 2_000_000_000, limit)
            return 0 if hits is None else 1

        grants = []
        for _ in range(20):
            grants.extend(await asyncio.gather(
                claim(pools[0]), claim(pools[1]),
                plus_one(pools[2]), claim(pools[3]),
            ))
        hits = int(await pools[0].fetchval(
            "SELECT hits FROM rate_limits WHERE bucket = $1", bucket))
        assert hits <= limit
        assert hits == sum(grants)
        assert hits == limit
        assert "/ 16" in LEASE_SQL
        # Releasing 5 at a full bucket leaves room 5. 5/16 is 0, so the
        # grant is 1 and the row stays under the limit.
        returned = await pools[0].fetchrow(
            LEASE_SQL, bucket, limit, 2_000_000_000, LEASE_BATCH, 5)
        assert int(returned["granted"]) == 1
        assert int(returned["hits"]) == limit - 5 + 1
        assert int(returned["hits"]) <= limit
    finally:
        try:
            await pools[0].execute(f"DROP SCHEMA IF EXISTS {schema} CASCADE")
        finally:
            for pool in pools:
                await pool.close()
