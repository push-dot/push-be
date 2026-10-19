from __future__ import annotations

import asyncio
import base64
import os
from datetime import datetime, timezone
from uuid import uuid4

import pytest

from app.pgproto import (
    PgPool, UniqueViolationError, begin_request_scope, parse_dsn,
    scram_client_proof,
)


def test_scram_rfc7677_vector():
    bare = "n=user,r=rOprNGfwEbeRWgbNEkqO"
    server = (
        "r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,"
        "s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096")
    final_wo = "c=biws,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0"
    proof, server_sig = scram_client_proof("pencil", bare, server, final_wo)
    assert proof == "dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ="
    assert base64.b64encode(server_sig).decode() == (
        "6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=")


def test_parse_dsn_neon_url():
    dsn = parse_dsn(
        "postgresql://user:p%40ss@ep-abc.eu-central-1.aws.neon.tech/neondb"
        "?sslmode=require")
    assert dsn["user"] == "user"
    assert dsn["password"] == "p@ss"
    assert dsn["host"] == "ep-abc.eu-central-1.aws.neon.tech"
    assert dsn["database"] == "neondb"
    assert dsn["sslmode"] == "require"


DSN = os.environ.get(
    "PGPROTO_DSN", "postgresql://push:push@127.0.0.1:5432/push?sslmode=disable")


def _postgres_up() -> bool:
    import socket
    try:
        with socket.create_connection(("127.0.0.1", 5432), timeout=1):
            return True
    except OSError:
        return False


pytestmark_pg = pytest.mark.skipif(not _postgres_up(), reason="postgres not reachable")


@pytest.mark.asyncio
@pytestmark_pg
async def test_roundtrip_types_transaction_and_unique():
    pool = PgPool(DSN, transport="tcp")
    name = "pgproto_" + uuid4().hex[:8]
    try:
        await pool.execute(
            f"CREATE TABLE {name} ("
            "id uuid PRIMARY KEY, n int, flag bool, note jsonb, "
            "blob bytea, at timestamptz, ids uuid[], tags jsonb)")
        uid = uuid4()
        other = uuid4()
        when = datetime(2026, 10, 17, 12, 30, tzinfo=timezone.utc)
        async with pool.acquire() as conn:
            async with conn.transaction():
                await conn.execute(
                    f"INSERT INTO {name} (id, n, flag, note, blob, at, ids, tags) "
                    "VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
                    uid, 7, True, {"a": 1}, b"\x00\xff", when, [uid, other], [])
                row = await conn.fetchrow(
                    f"SELECT id, n, flag, note, blob, at, ids, tags "
                    f"FROM {name} WHERE id=$1",
                    uid)
        assert row["id"] == uid
        assert row["n"] == 7
        assert row["flag"] is True
        assert row["note"] == {"a": 1}
        assert row["blob"] == b"\x00\xff"
        assert row["at"] == when
        assert row["ids"] == [uid, other]
        assert row["tags"] == []
        assert await pool.fetchval(f"SELECT count(*) FROM {name}") == 1

        with pytest.raises(RuntimeError):
            async with pool.acquire() as conn:
                async with conn.transaction():
                    await conn.execute(
                        f"INSERT INTO {name} (id, n, flag) VALUES ($1,$2,$3)",
                        uuid4(), 1, False)
                    raise RuntimeError("rollback")
        assert await pool.fetchval(f"SELECT count(*) FROM {name}") == 1

        with pytest.raises(UniqueViolationError):
            await pool.execute(
                f"INSERT INTO {name} (id, n, flag) VALUES ($1,$2,$3)",
                uid, 1, False)
        assert await pool.fetchval(
            f"SELECT n FROM {name} WHERE id = ANY($1)", [uid]) == 7
    finally:
        try:
            await pool.execute(f"DROP TABLE IF EXISTS {name}")
        finally:
            await pool.close()


class _FakeConn:
    def __init__(self, n: int, opened: list):
        self.n = n
        self.closed = False
        self.scope = None
        self.opened = opened

    async def fetchval(self, sql, *args):
        if self.closed:
            raise ConnectionError("closed")
        return self.n

    async def close(self):
        self.closed = True


def _patch_connect(monkeypatch):
    opened: list[_FakeConn] = []

    async def fake_connect(url, transport="tcp"):
        conn = _FakeConn(len(opened) + 1, opened)
        opened.append(conn)
        await asyncio.sleep(0)
        return conn

    monkeypatch.setattr("app.pgproto.connect", fake_connect)
    return opened


async def test_concurrent_requests_keep_separate_connections(monkeypatch):
    opened = _patch_connect(monkeypatch)
    pool = PgPool("postgresql://user:pass@localhost/db", transport="websocket")

    async def one():
        scope = begin_request_scope()
        try:
            first = await pool.fetchval("SELECT 1")
            await asyncio.sleep(0)
            second = await pool.fetchval("SELECT 1")
            return first, second
        finally:
            await pool.end_request_scope(scope)

    (a1, a2), (b1, b2) = await asyncio.gather(one(), one())
    assert a1 == a2
    assert b1 == b2
    assert a1 != b1
    assert len(opened) == 2
    assert all(conn.closed for conn in opened)


async def test_ending_one_request_does_not_close_the_other(monkeypatch):
    opened = _patch_connect(monkeypatch)
    pool = PgPool("postgresql://user:pass@localhost/db", transport="websocket")
    started = asyncio.Event()
    finish_a = asyncio.Event()

    async def request_a():
        scope = begin_request_scope()
        try:
            seen = await pool.fetchval("SELECT 1")
            started.set()
            await finish_a.wait()
            return seen
        finally:
            await pool.end_request_scope(scope)

    async def request_b():
        await started.wait()
        scope = begin_request_scope()
        try:
            first = await pool.fetchval("SELECT 1")
            finish_a.set()
            await asyncio.sleep(0)
            second = await pool.fetchval("SELECT 1")
            mine = next(conn for conn in opened if conn.n == first)
            assert mine.closed is False
            return first, second
        finally:
            await pool.end_request_scope(scope)

    a, (b1, b2) = await asyncio.gather(request_a(), request_b())
    assert a != b1
    assert b1 == b2
    assert len(opened) == 2


async def test_without_a_request_scope_one_connection_is_reused(monkeypatch):
    opened = _patch_connect(monkeypatch)
    pool = PgPool("postgresql://user:pass@localhost/db")
    assert await pool.fetchval("SELECT 1") == 1
    assert await pool.fetchval("SELECT 1") == 1
    assert len(opened) == 1
    await pool.close()
    assert opened[0].closed is True
