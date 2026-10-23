"""Streams, WebSocket transports, connect() and PgPool scope handling."""

from __future__ import annotations

import asyncio
import sys
from types import ModuleType, SimpleNamespace

import pytest

from app import pgproto
from app.pgproto import (
    BufferedStream, ByteStream, PgError, PgPool, _request_state,
    begin_request_scope,
)
from tests.test_cov2_pgproto_wire import READY, FakeStream, auth, err


async def test_bytestream_base_methods():
    s = ByteStream()
    with pytest.raises(NotImplementedError):
        await s.readexactly(1)
    with pytest.raises(NotImplementedError):
        await s.write(b"x")
    assert await s.close() is None


async def test_buffered_stream_reassembles_frames():
    chunks = [b"ab", "cd", b"e", b""]
    sent, closed = [], []

    async def recv():
        return chunks.pop(0)

    async def send(data):
        sent.append(data)

    async def close():
        closed.append(True)

    s = BufferedStream(recv, send, close)
    assert await s.readexactly(3) == b"abc"
    assert await s.readexactly(2) == b"de"
    with pytest.raises(ConnectionError, match="closed"):
        await s.readexactly(1)
    await s.write(b"hi")
    await s.close()
    assert sent == [b"hi"] and closed == [True]


# --- WebSocket transports ------------------------------------------------

async def test_python_websocket_transport(monkeypatch):
    monkeypatch.delenv("CF_WORKER", raising=False)
    calls = {}

    class WS:
        def __init__(self):
            self.sent, self.closed = [], False

        async def recv(self):
            return b"xyz"

        async def send(self, data):
            self.sent.append(data)

        async def close(self):
            self.closed = True

    ws = WS()

    async def fake_connect(url, **kw):
        calls.update(url=url, **kw)
        return ws

    monkeypatch.setitem(sys.modules, "websockets", SimpleNamespace(connect=fake_connect))
    stream = await pgproto.open_websocket_stream({"host": "ep.neon.tech"})
    assert calls == {"url": "wss://ep.neon.tech/v2", "max_size": None, "open_timeout": 20}
    assert await stream.readexactly(3) == b"xyz"
    await stream.write(b"q")
    await stream.close()
    assert ws.sent == [b"q"] and ws.closed


class _Proxy:
    def __init__(self, fn):
        self.fn = fn
        self.destroyed = False

    def destroy(self):
        self.destroyed = True


class _Uint8:
    def __init__(self, n):
        self.n, self.data = n, None

    @classmethod
    def new(cls, n):
        return cls(n)

    def assign(self, data):
        self.data = bytes(data)


class _WorkerWS:
    def __init__(self, *, reject_binary_type=False, close_raises=False):
        self.reject = reject_binary_type
        self.close_raises = close_raises
        self.listeners = {}
        self.sent = []
        self.accepted = False

    def __setattr__(self, name, value):
        if name == "binaryType" and self.reject:
            raise AttributeError("read-only")
        object.__setattr__(self, name, value)

    def accept(self):
        self.accepted = True

    def addEventListener(self, name, proxy):
        self.listeners[name] = proxy

    def send(self, buf):
        self.sent.append(buf.data)

    def close(self):
        if self.close_raises:
            raise RuntimeError("already closed")


def _install_workers(monkeypatch, ws):
    seen = {}

    async def fetch(url, opts):
        seen["url"], seen["opts"] = url, opts
        return SimpleNamespace(webSocket=ws)

    ffi = ModuleType("pyodide.ffi")
    ffi.create_proxy = _Proxy
    ffi.to_js = lambda obj, dict_converter=None: obj
    pyodide = ModuleType("pyodide")
    pyodide.ffi = ffi
    js = ModuleType("js")
    js.Object = SimpleNamespace(fromEntries=dict)
    js.Uint8Array = _Uint8
    js.fetch = fetch
    monkeypatch.setitem(sys.modules, "pyodide", pyodide)
    monkeypatch.setitem(sys.modules, "pyodide.ffi", ffi)
    monkeypatch.setitem(sys.modules, "js", js)
    monkeypatch.setenv("CF_WORKER", "1")
    return seen


async def test_workers_websocket_transport(monkeypatch):
    ws = _WorkerWS()
    seen = _install_workers(monkeypatch, ws)
    stream = await pgproto.open_websocket_stream({"host": "ep.neon.tech"})
    assert seen["url"] == "https://ep.neon.tech/v2"
    assert seen["opts"] == {"headers": {"Upgrade": "websocket"}}
    assert ws.binaryType == "arraybuffer" and ws.accepted
    on_message = ws.listeners["message"].fn

    class ToBytes:
        def to_bytes(self):
            return b"a"

    class ToPy:
        def to_py(self):
            return memoryview(b"b")

    on_message(SimpleNamespace(data=ToBytes()))
    on_message(SimpleNamespace(data=ToPy()))
    on_message(SimpleNamespace(data=b"c"))
    on_message(SimpleNamespace(data=[100]))      # bytes([100]) == b"d"
    on_message(SimpleNamespace(data="e"))        # bytes("e") fails -> str encode
    on_message(SimpleNamespace())                # no data attribute -> b""
    assert await stream.readexactly(5) == b"abcde"
    ws.listeners["close"].fn(None)
    with pytest.raises(ConnectionError):
        await stream.readexactly(1)
    await stream.write(b"\x01\x02")
    assert ws.sent == [b"\x01\x02"]
    await stream.close()
    assert all(p.destroyed for p in ws.listeners.values())
    assert set(ws.listeners) == {"message", "close", "error"}


async def test_workers_websocket_tolerates_runtime_quirks(monkeypatch):
    ws = _WorkerWS(reject_binary_type=True, close_raises=True)
    _install_workers(monkeypatch, ws)
    stream = await pgproto._open_workers_websocket("https://already-http/v2")
    ws.listeners["error"].fn(None)
    with pytest.raises(ConnectionError):
        await stream.readexactly(1)
    await stream.close()


async def test_workers_websocket_upgrade_failure(monkeypatch):
    _install_workers(monkeypatch, None)
    with pytest.raises(ConnectionError, match="upgrade failed"):
        await pgproto.open_websocket_stream({"host": "h"})


# --- connect() -----------------------------------------------------------

async def test_connect_over_websocket_runs_startup(monkeypatch):
    stream = FakeStream(auth(0), READY)

    async def fake_open(dsn):
        assert dsn["host"] == "h" and dsn["user"] == "u"
        return stream

    monkeypatch.setattr(pgproto, "open_websocket_stream", fake_open)
    conn = await pgproto.connect("postgresql://u:p@h/db", transport="websocket")
    assert (conn.user, conn.password, conn.database) == ("u", "p", "db")
    assert not stream.closed


async def test_connect_closes_stream_when_startup_fails(monkeypatch):
    stream = FakeStream(err("28P01", "bad password"))

    async def fake_open(dsn):
        return stream

    monkeypatch.setattr(pgproto, "open_tcp_stream", fake_open)
    with pytest.raises(PgError, match="28P01"):
        await pgproto.connect("postgresql://u:p@h/db")
    assert stream.closed


# --- PgPool --------------------------------------------------------------

class _Conn:
    def __init__(self, n, fail=None):
        self.n, self.fail = n, fail
        self.closed = False
        self.calls = []

    async def _do(self, name, *a):
        self.calls.append((name, *a))
        if self.fail is not None:
            exc, self.fail = self.fail, None
            raise exc
        return name

    async def execute(self, sql, *a):
        return await self._do("execute", sql, *a)

    async def executemany(self, sql, seq):
        return await self._do("executemany", sql, seq)

    async def fetch(self, sql, *a):
        return await self._do("fetch", sql, *a)

    async def fetchrow(self, sql, *a):
        return await self._do("fetchrow", sql, *a)

    async def fetchval(self, sql, *a):
        return await self._do("fetchval", sql, *a)

    async def close(self):
        self.closed = True


def _patch(monkeypatch, *fails):
    opened = []
    fails = list(fails)

    async def fake_connect(url, transport="tcp"):
        if fails and isinstance(fails[0], BaseException) and fails[0].args == ("connect",):
            raise fails.pop(0)
        conn = _Conn(len(opened) + 1, fails.pop(0) if fails else None)
        opened.append(conn)
        return conn

    monkeypatch.setattr(pgproto, "connect", fake_connect)
    return opened


async def test_pool_methods_share_the_local_connection(monkeypatch):
    opened = _patch(monkeypatch)
    pool = PgPool("postgresql://u:p@h/db")
    assert await pool.executemany("I", [(1,)]) == None  # noqa: E711
    assert await pool.fetch("F", 1) == "fetch"
    assert await pool.fetchrow("R", 2) == "fetchrow"
    assert await pool.execute("E") == "execute"
    assert len(opened) == 1
    assert [c[0] for c in opened[0].calls] == ["executemany", "fetch", "fetchrow", "execute"]


async def test_pool_execute_drops_connection_on_transport_error(monkeypatch):
    opened = _patch(monkeypatch, ConnectionError("reset"))
    pool = PgPool("postgresql://u:p@h/db")
    with pytest.raises(ConnectionError):
        await pool.execute("E")
    assert opened[0].closed
    assert await pool.execute("E") == "execute"
    assert len(opened) == 2


async def test_pool_reconnects_after_connection_marked_closed(monkeypatch):
    opened = _patch(monkeypatch)
    pool = PgPool("postgresql://u:p@h/db")
    await pool.fetchval("V")
    opened[0].closed = True  # e.g. a failed ROLLBACK
    await pool.fetchval("V")
    assert len(opened) == 2


@pytest.mark.xfail(strict=True, reason=(
    "BUG: only PgPool.execute drops the connection on ConnectionError/OSError "
    "(pgproto.py:843); fetch/fetchrow/fetchval/executemany keep the dead "
    "connection, so every later read on that scope fails"))
async def test_pool_fetch_drops_connection_on_transport_error(monkeypatch):
    opened = _patch(monkeypatch, asyncio.IncompleteReadError(b"", 5))
    pool = PgPool("postgresql://u:p@h/db")
    with pytest.raises(asyncio.IncompleteReadError):
        await pool.fetch("F")
    assert opened[0].closed


async def test_acquire_releases_lock_when_connect_fails(monkeypatch):
    _patch(monkeypatch, OSError("connect"))
    pool = PgPool("postgresql://u:p@h/db")
    with pytest.raises(OSError):
        async with pool.acquire():
            pass
    assert not pool._local.lock.locked()


async def test_acquire_keeps_connection_on_pg_error_and_drops_on_other(monkeypatch):
    opened = _patch(monkeypatch)
    pool = PgPool("postgresql://u:p@h/db")
    with pytest.raises(PgError):
        async with pool.acquire():
            raise PgError("23505", "dup")
    assert not opened[0].closed
    with pytest.raises(RuntimeError):
        async with pool.acquire():
            raise RuntimeError("boom")
    assert opened[0].closed
    assert not pool._local.lock.locked()


async def test_end_request_scope_ignores_foreign_objects():
    pool = PgPool("postgresql://u:p@h/db")
    await pool.end_request_scope(object())


async def test_end_request_scope_from_another_context_clears_var(monkeypatch):
    opened = _patch(monkeypatch)
    pool = PgPool("postgresql://u:p@h/db")
    scope = begin_request_scope()
    try:
        await pool.fetchval("V")

        async def in_child():
            # Task context is a copy: the var still points at scope but the
            # token belongs to the parent context, so reset() raises.
            await pool.end_request_scope(scope)
            return _request_state.get()

        assert await asyncio.create_task(in_child()) is None
        assert opened[0].closed and scope.token is None
    finally:
        _request_state.set(None)


async def test_pool_close_drops_local_and_request_connections(monkeypatch):
    opened = _patch(monkeypatch)
    pool = PgPool("postgresql://u:p@h/db")
    await pool.fetchval("local")
    scope = begin_request_scope()
    try:
        await pool.fetchval("scoped")
        assert len(opened) == 2
        await pool.close()
        assert all(c.closed for c in opened)
        assert scope.conn is None and pool._local.conn is None
    finally:
        await pool.end_request_scope(scope)
    assert _request_state.get() is None
