from __future__ import annotations

import asyncio
import base64
import os
import socket
import ssl
import struct
import subprocess
import threading
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

import pytest

from app.pgproto import (
    PgPool, UniqueViolationError, begin_request_scope, open_tcp_stream,
    parse_dsn, scram_client_proof, websocket_url,
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


def test_any_neon_region_uses_the_wire_client(monkeypatch):
    monkeypatch.delenv("DB_DRIVER", raising=False)
    monkeypatch.delenv("CF_WORKER", raising=False)
    from app.db import database_driver
    assert database_driver(
        "postgresql://u:p@ep.ap-southeast-1.aws.neon.tech/db") == "neon"
    assert database_driver(
        "postgresql://u:p@ep.ap-northeast-1.aws.neon.tech/neondb?sslmode=require") == "neon"
    assert database_driver("postgresql://u:p@127.0.0.1:5432/push") == "asyncpg"


def test_websocket_url_uses_the_url_host():
    dsn = parse_dsn(
        "postgresql://u:p@ep-tokyo.ap-northeast-1.aws.neon.tech/neondb?sslmode=require")
    assert websocket_url(dsn) == "wss://ep-tokyo.ap-northeast-1.aws.neon.tech/v2"


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


_SSL_REQUEST = struct.pack("!II", 8, 80877103)


def _recv_exact(sock: socket.socket, n: int) -> bytes:
    buf = b""
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            raise ConnectionError("closed")
        buf += chunk
    return buf


def _self_signed(tmp: Path) -> tuple[Path, Path]:
    cert, key = tmp / "cert.pem", tmp / "key.pem"
    subprocess.run(
        ["openssl", "req", "-x509", "-newkey", "rsa:2048",
         "-keyout", str(key), "-out", str(cert), "-days", "1", "-nodes",
         "-subj", "/CN=localhost"],
        check=True, capture_output=True)
    return cert, key


def _listen() -> socket.socket:
    sock = socket.create_server(("127.0.0.1", 0))
    sock.settimeout(10)
    return sock


async def test_tcp_tls_is_started_by_asyncio_not_a_prewrapped_socket(tmp_path, monkeypatch):
    openssl = subprocess.run(["openssl", "version"], capture_output=True)
    if openssl.returncode != 0:
        pytest.skip("openssl is not available")
    cert, key = _self_signed(tmp_path)
    server_ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    server_ctx.load_cert_chain(cert, key)
    gate = threading.Event()
    seen: dict = {}
    listener = _listen()
    port = listener.getsockname()[1]

    def serve():
        try:
            conn, _ = listener.accept()
            conn.settimeout(10)
            try:
                assert _recv_exact(conn, 8) == _SSL_REQUEST
                conn.sendall(b"S")
                tls = server_ctx.wrap_socket(conn, server_side=True)
                try:
                    seen["payload"] = _recv_exact(tls, 4)
                finally:
                    tls.close()
            finally:
                try:
                    conn.close()
                except OSError:
                    pass
        except Exception as exc:
            seen["error"] = exc
        finally:
            gate.set()
            listener.close()

    threading.Thread(target=serve, daemon=True).start()
    calls = []
    original = asyncio.open_connection

    async def spy(*args, **kwargs):
        sock = kwargs.get("sock")
        calls.append(kwargs)
        assert not isinstance(sock, ssl.SSLSocket)
        return await original(*args, **kwargs)

    monkeypatch.setattr(asyncio, "open_connection", spy)
    stream = await open_tcp_stream({
        "host": "127.0.0.1", "port": port, "sslmode": "require",
        "user": "u", "password": "p", "database": "db",
    })
    await stream.write(b"ping")
    await stream.close()
    assert gate.wait(10)
    assert "error" not in seen, seen.get("error")
    assert seen["payload"] == b"ping"
    assert calls[0]["ssl"] is not None
    assert calls[0]["server_hostname"] == "127.0.0.1"
    assert calls[0]["ssl"].verify_mode == ssl.CERT_NONE
    assert calls[0]["ssl"].check_hostname is False


async def test_prefer_stays_plaintext_when_the_server_refuses_ssl():
    gate = threading.Event()
    seen: dict = {}
    listener = _listen()
    port = listener.getsockname()[1]

    def serve():
        try:
            conn, _ = listener.accept()
            conn.settimeout(10)
            try:
                assert _recv_exact(conn, 8) == _SSL_REQUEST
                conn.sendall(b"N")
                seen["payload"] = _recv_exact(conn, 4)
            finally:
                conn.close()
        except Exception as exc:
            seen["error"] = exc
        finally:
            gate.set()
            listener.close()

    threading.Thread(target=serve, daemon=True).start()
    stream = await open_tcp_stream({
        "host": "127.0.0.1", "port": port, "sslmode": "prefer",
        "user": "u", "password": "p", "database": "db",
    })
    await stream.write(b"ping")
    await stream.close()
    assert gate.wait(10)
    assert "error" not in seen, seen.get("error")
    assert seen["payload"] == b"ping"


async def test_require_reports_a_server_that_refuses_ssl():
    listener = _listen()
    port = listener.getsockname()[1]

    def serve():
        try:
            conn, _ = listener.accept()
            conn.settimeout(10)
            try:
                _recv_exact(conn, 8)
                conn.sendall(b"N")
            finally:
                conn.close()
        finally:
            listener.close()

    threading.Thread(target=serve, daemon=True).start()
    with pytest.raises(ConnectionError, match="refused SSL"):
        await open_tcp_stream({
            "host": "127.0.0.1", "port": port, "sslmode": "require",
            "user": "u", "password": "p", "database": "db",
        })
