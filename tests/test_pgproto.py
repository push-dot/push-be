from __future__ import annotations

import base64
import os
from datetime import datetime, timezone
from uuid import uuid4

import pytest

from app.pgproto import (
    PgPool, UniqueViolationError, parse_dsn, scram_client_proof,
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
            "blob bytea, at timestamptz, ids uuid[])")
        uid = uuid4()
        other = uuid4()
        when = datetime(2026, 10, 17, 12, 30, tzinfo=timezone.utc)
        async with pool.acquire() as conn:
            async with conn.transaction():
                await conn.execute(
                    f"INSERT INTO {name} (id, n, flag, note, blob, at, ids) "
                    "VALUES ($1,$2,$3,$4,$5,$6,$7)",
                    uid, 7, True, {"a": 1}, b"\x00\xff", when, [uid, other])
                row = await conn.fetchrow(
                    f"SELECT id, n, flag, note, blob, at, ids FROM {name} WHERE id=$1",
                    uid)
        assert row["id"] == uid
        assert row["n"] == 7
        assert row["flag"] is True
        assert row["note"] == {"a": 1}
        assert row["blob"] == b"\x00\xff"
        assert row["at"] == when
        assert row["ids"] == [uid, other]
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
