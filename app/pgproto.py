"""Async Postgres wire client.

Workers cannot load asyncpg or psycopg. Neon accepts the same frontend/backend
protocol over ``wss://<endpoint>/v2`` (what ``@neondatabase/serverless`` speaks)
and over TCP from a machine that can open port 5432. This client implements
the subset the API uses: extended-query parameters, interactive transactions,
SCRAM-SHA-256 / md5 / cleartext auth, and text-format codecs for the column
types the stores read back.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import os
import socket
import ssl
import struct
import unicodedata
from datetime import datetime, timezone
from typing import Any, Optional
from urllib.parse import parse_qs, unquote, urlparse
from uuid import UUID


class PgError(Exception):
    def __init__(self, sqlstate: str, message: str):
        super().__init__(f"{sqlstate}: {message}")
        self.sqlstate = sqlstate
        self.message = message


class UniqueViolationError(PgError):
    pass


class Row(dict):
    """asyncpg.Record stand-in: mapping access plus ``dict(row)``."""


_BOOLOID = 16
_BYTEAOID = 17
_INT8OID = 20
_INT2OID = 21
_INT4OID = 23
_JSONOID = 114
_FLOAT4OID = 700
_FLOAT8OID = 701
_DATEOID = 1082
_TIMESTAMPOID = 1114
_TIMESTAMPTZOID = 1184
_NUMERICOID = 1700
_UUIDOID = 2950
_JSONBOID = 3802
_UUIDARRAY = 2951
_TEXTARRAY = 1009
_INT4ARRAY = 1007
_INT8ARRAY = 1016
_JSONBARRAY = 3807


def _i32(n: int) -> bytes:
    return struct.pack("!i", n)


def _i16(n: int) -> bytes:
    return struct.pack("!h", n)


def _cstr(s: str) -> bytes:
    return s.encode() + b"\x00"


def _frame(payload: bytes) -> bytes:
    return _i32(len(payload) + 4) + payload


def _sasl_user(user: str) -> str:
    return user.replace("=", "=3D").replace(",", "=2C")


def _parse_scram_attrs(raw: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for part in raw.split(","):
        key, _, val = part.partition("=")
        out[key] = val
    return out


def scram_client_proof(password: str, client_first_bare: str,
                       server_first: str, client_final_wo_proof: str) -> tuple[str, bytes]:
    """Return (base64 client proof, expected server signature)."""
    attrs = _parse_scram_attrs(server_first)
    salt = base64.b64decode(attrs["s"])
    iterations = int(attrs["i"])
    salted = hashlib.pbkdf2_hmac(
        "sha256", unicodedata.normalize("NFKC", password).encode(),
        salt, iterations)
    client_key = hmac.new(salted, b"Client Key", hashlib.sha256).digest()
    stored_key = hashlib.sha256(client_key).digest()
    auth = f"{client_first_bare},{server_first},{client_final_wo_proof}"
    client_sig = hmac.new(stored_key, auth.encode(), hashlib.sha256).digest()
    proof = bytes(a ^ b for a, b in zip(client_key, client_sig))
    server_key = hmac.new(salted, b"Server Key", hashlib.sha256).digest()
    server_sig = hmac.new(server_key, auth.encode(), hashlib.sha256).digest()
    return base64.b64encode(proof).decode(), server_sig


def parse_dsn(url: str) -> dict[str, Any]:
    raw = url.strip()
    if raw.startswith("postgres://"):
        raw = "postgresql://" + raw[len("postgres://"):]
    parsed = urlparse(raw)
    qs = parse_qs(parsed.query)
    sslmode = (qs.get("sslmode") or ["prefer"])[0]
    return {
        "user": unquote(parsed.username or ""),
        "password": unquote(parsed.password or ""),
        "host": parsed.hostname or "localhost",
        "port": parsed.port or 5432,
        "database": unquote((parsed.path or "/postgres").lstrip("/")) or "postgres",
        "sslmode": sslmode,
    }


def _pg_error(fields: dict[str, str]) -> PgError:
    state = fields.get("C", "XX000")
    message = fields.get("M", "postgres error")
    if state == "23505":
        return UniqueViolationError(state, message)
    return PgError(state, message)


def _parse_error_fields(payload: bytes) -> dict[str, str]:
    fields: dict[str, str] = {}
    i = 0
    while i < len(payload) and payload[i] != 0:
        code = chr(payload[i])
        i += 1
        end = payload.index(b"\x00", i)
        fields[code] = payload[i:end].decode(errors="replace")
        i = end + 1
    return fields


def _parse_ts(text: str) -> datetime:
    s = text.strip().replace(" ", "T", 1)
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    if len(s) >= 3 and s[-3] in "+-" and s[-2:].isdigit():
        s += ":00"
    if len(s) >= 5 and s[-5] in "+-" and s[-4:].isdigit():
        s = s[:-2] + ":" + s[-2:]
    dt = datetime.fromisoformat(s)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def _parse_array(text: str) -> list[str]:
    if text in ("{}", ""):
        return []
    inner = text[1:-1] if text.startswith("{") else text
    out: list[str] = []
    buf: list[str] = []
    quoted = False
    i = 0
    while i < len(inner):
        ch = inner[i]
        if ch == '"' and not quoted:
            quoted = True
        elif ch == '"' and quoted:
            quoted = False
        elif ch == "\\" and quoted:
            i += 1
            if i < len(inner):
                buf.append(inner[i])
        elif ch == "," and not quoted:
            out.append("".join(buf))
            buf = []
        else:
            buf.append(ch)
        i += 1
    out.append("".join(buf))
    return out


def _decode_text(oid: int, text: Optional[str]) -> Any:
    if text is None:
        return None
    if oid == _BOOLOID:
        return text in ("t", "true", "TRUE", "1")
    if oid in (_INT2OID, _INT4OID, _INT8OID):
        return int(text)
    if oid in (_FLOAT4OID, _FLOAT8OID):
        return float(text)
    if oid == _NUMERICOID:
        return float(text) if "." in text else int(text)
    if oid in (_JSONOID, _JSONBOID):
        return json.loads(text)
    if oid == _UUIDOID:
        return UUID(text)
    if oid in (_TIMESTAMPOID, _TIMESTAMPTZOID):
        return _parse_ts(text)
    if oid == _DATEOID:
        return _parse_ts(text + "T00:00:00+00:00").date()
    if oid == _BYTEAOID:
        raw = text[2:] if text.startswith("\\x") else text
        try:
            return bytes.fromhex(raw)
        except ValueError:
            return text.encode()
    if oid == _UUIDARRAY:
        return [UUID(x) for x in _parse_array(text)]
    if oid in (_TEXTARRAY, _JSONBARRAY):
        return _parse_array(text)
    if oid in (_INT4ARRAY, _INT8ARRAY):
        return [int(x) for x in _parse_array(text) if x]
    return text


def _bind_param(value: Any) -> tuple[int, Optional[bytes]]:
    """Return (type oid, text bytes or None for SQL NULL)."""
    if value is None:
        return 0, None
    if isinstance(value, bool):
        return _BOOLOID, b"true" if value else b"false"
    if isinstance(value, int) and not isinstance(value, bool):
        return 0, str(value).encode()
    if isinstance(value, float):
        return 0, repr(value).encode()
    if isinstance(value, UUID):
        return 0, str(value).encode()
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return 0, value.isoformat().encode()
    if isinstance(value, (bytes, bytearray)):
        return _BYTEAOID, b"\\x" + bytes(value).hex().encode()
    if isinstance(value, dict):
        return _JSONBOID, json.dumps(value, default=str).encode()
    if isinstance(value, (list, tuple)):
        if not value:
            return _UUIDARRAY, b"{}"
        if all(isinstance(v, UUID) for v in value):
            body = "{" + ",".join(str(v) for v in value) + "}"
            return _UUIDARRAY, body.encode()
        if all(isinstance(v, bool) or isinstance(v, int) for v in value):
            body = "{" + ",".join(str(int(v)) for v in value) + "}"
            return _INT8ARRAY, body.encode()
        body = "{" + ",".join(json.dumps(str(v)) for v in value) + "}"
        return _TEXTARRAY, body.encode()
    return 0, str(value).encode()


class ByteStream:
    async def readexactly(self, n: int) -> bytes:
        raise NotImplementedError

    async def write(self, data: bytes) -> None:
        raise NotImplementedError

    async def close(self) -> None:
        return None


class _ReaderStream(ByteStream):
    def __init__(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        self._reader = reader
        self._writer = writer

    async def readexactly(self, n: int) -> bytes:
        return await self._reader.readexactly(n)

    async def write(self, data: bytes) -> None:
        self._writer.write(data)
        await self._writer.drain()

    async def close(self) -> None:
        self._writer.close()
        try:
            await self._writer.wait_closed()
        except Exception:
            pass


class BufferedStream(ByteStream):
    """Byte stream over message-oriented sockets (Neon WebSocket frames)."""

    def __init__(self, recv, send, close):
        self._recv = recv
        self._send = send
        self._close = close
        self._buf = bytearray()

    async def readexactly(self, n: int) -> bytes:
        while len(self._buf) < n:
            chunk = await self._recv()
            if not chunk:
                raise ConnectionError("database connection closed")
            if isinstance(chunk, str):
                chunk = chunk.encode()
            self._buf += chunk
        out = bytes(self._buf[:n])
        del self._buf[:n]
        return out

    async def write(self, data: bytes) -> None:
        await self._send(data)

    async def close(self) -> None:
        await self._close()


def _tcp_socket(host: str, port: int, sslmode: str) -> socket.socket:
    sock = socket.create_connection((host, port), timeout=20)
    if sslmode == "disable":
        return sock
    sock.sendall(struct.pack("!II", 8, 80877103))
    resp = sock.recv(1)
    if resp != b"S":
        if sslmode == "prefer":
            return sock
        raise ConnectionError("server refused SSL")
    ctx = ssl.create_default_context()
    if sslmode == "require":
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
    return ctx.wrap_socket(sock, server_hostname=host)


async def open_tcp_stream(dsn: dict) -> ByteStream:
    sock = await asyncio.to_thread(
        _tcp_socket, dsn["host"], dsn["port"], dsn["sslmode"])
    reader, writer = await asyncio.open_connection(sock=sock)
    return _ReaderStream(reader, writer)


async def open_websocket_stream(dsn: dict) -> ByteStream:
    host = dsn["host"]
    url = f"wss://{host}/v2"
    if os.environ.get("CF_WORKER") == "1":
        return await _open_workers_websocket(url)
    return await _open_python_websocket(url)


async def _open_python_websocket(url: str) -> ByteStream:
    import websockets

    ws = await websockets.connect(url, max_size=None, open_timeout=20)

    async def recv():
        return await ws.recv()

    async def send(data: bytes):
        await ws.send(data)

    async def close():
        await ws.close()

    return BufferedStream(recv, send, close)


async def _open_workers_websocket(url: str) -> ByteStream:
    """Outbound WebSocket via the Workers fetch upgrade API."""
    from pyodide.ffi import create_proxy, to_js
    from js import Object, Uint8Array, fetch

    headers = to_js({"Upgrade": "websocket"}, dict_converter=Object.fromEntries)
    resp = await fetch(url, to_js({"headers": headers}, dict_converter=Object.fromEntries))
    ws = resp.webSocket
    if ws is None:
        raise ConnectionError("Neon WebSocket upgrade failed")
    ws.accept()
    queue: asyncio.Queue = asyncio.Queue()
    proxies = []

    def on_message(event):
        data = getattr(event, "data", b"")
        if hasattr(data, "to_py"):
            data = data.to_py()
        if isinstance(data, memoryview):
            data = data.tobytes()
        elif not isinstance(data, (bytes, bytearray)):
            try:
                data = bytes(data)
            except Exception:
                data = str(data).encode()
        queue.put_nowait(bytes(data))

    def on_done(_event):
        queue.put_nowait(b"")

    for name, fn in (("message", on_message), ("close", on_done), ("error", on_done)):
        proxy = create_proxy(fn)
        proxies.append(proxy)
        ws.addEventListener(name, proxy)

    async def recv():
        return await queue.get()

    async def send(data: bytes):
        ws.send(Uint8Array.new(data))

    async def close():
        for proxy in proxies:
            proxy.destroy()
        try:
            ws.close()
        except Exception:
            pass

    return BufferedStream(recv, send, close)


class PgConnection:
    def __init__(self, stream: ByteStream, user: str, password: str, database: str):
        self.stream = stream
        self.user = user
        self.password = password
        self.database = database
        self.closed = False
        self._pushback: Optional[tuple[bytes, bytes]] = None

    async def start(self) -> None:
        params = b"".join((
            _cstr("user"), _cstr(self.user),
            _cstr("database"), _cstr(self.database),
            _cstr("DateStyle"), _cstr("ISO"),
            _cstr("extra_float_digits"), _cstr("2"),
            b"\x00",
        ))
        body = _i32(196608) + params
        await self.stream.write(_i32(len(body) + 4) + body)
        await self._authenticate()

    async def _read(self) -> tuple[bytes, bytes]:
        if self._pushback is not None:
            msg = self._pushback
            self._pushback = None
            return msg
        kind = await self.stream.readexactly(1)
        ln = struct.unpack("!i", await self.stream.readexactly(4))[0]
        payload = await self.stream.readexactly(ln - 4) if ln > 4 else b""
        return kind, payload

    async def _authenticate(self) -> None:
        while True:
            kind, payload = await self._read()
            if kind == b"R":
                code = struct.unpack("!i", payload[:4])[0]
                if code == 0:
                    continue
                if code == 3:
                    await self._password_message(self.password)
                    continue
                if code == 5:
                    salt = payload[4:8]
                    inner = hashlib.md5(
                        (self.password + self.user).encode()).hexdigest().encode()
                    digest = "md5" + hashlib.md5(inner + salt).hexdigest()
                    await self._password_message(digest)
                    continue
                if code == 10:
                    await self._scram(payload[4:])
                    continue
                if code in (11, 12):
                    continue
                raise PgError("28000", f"unsupported auth code {code}")
            if kind == b"E":
                raise _pg_error(_parse_error_fields(payload))
            if kind in (b"S", b"K", b"N"):
                continue
            if kind == b"Z":
                return
            raise PgError("08006", f"unexpected startup message {kind!r}")

    async def _password_message(self, text: str) -> None:
        payload = _cstr(text)
        await self.stream.write(b"p" + _frame(payload))

    async def _scram(self, mech_payload: bytes) -> None:
        mechs = []
        i = 0
        while i < len(mech_payload) and mech_payload[i] != 0:
            end = mech_payload.index(b"\x00", i)
            mechs.append(mech_payload[i:end].decode())
            i = end + 1
        if "SCRAM-SHA-256" not in mechs:
            raise PgError("28000", "server did not offer SCRAM-SHA-256")
        nonce = base64.b64encode(os.urandom(18)).decode().rstrip("=")
        bare = f"n={_sasl_user(self.user)},r={nonce}"
        client_first = "n,," + bare
        initial = _cstr("SCRAM-SHA-256") + _i32(len(client_first)) + client_first.encode()
        await self.stream.write(b"p" + _frame(initial))
        kind, payload = await self._read()
        if kind == b"E":
            raise _pg_error(_parse_error_fields(payload))
        if kind != b"R" or struct.unpack("!i", payload[:4])[0] != 11:
            raise PgError("08006", "expected SASL continue")
        server_first = payload[4:].decode()
        attrs = _parse_scram_attrs(server_first)
        if not attrs.get("r", "").startswith(nonce):
            raise PgError("28000", "SCRAM nonce mismatch")
        final_wo = "c=biws,r=" + attrs["r"]
        proof, server_sig = scram_client_proof(
            self.password, bare, server_first, final_wo)
        client_final = final_wo + ",p=" + proof
        await self.stream.write(b"p" + _frame(client_final.encode()))
        while True:
            kind, payload = await self._read()
            if kind == b"E":
                raise _pg_error(_parse_error_fields(payload))
            if kind != b"R":
                self._pushback = (kind, payload)
                return
            code = struct.unpack("!i", payload[:4])[0]
            if code == 12:
                got = _parse_scram_attrs(payload[4:].decode()).get("v", "")
                expect = base64.b64encode(server_sig).decode()
                if got and not hmac.compare_digest(got, expect):
                    raise PgError("28000", "SCRAM server signature mismatch")
                continue
            if code == 0:
                return
            raise PgError("08006", f"unexpected SASL auth code {code}")

    async def simple(self, sql: str) -> str:
        payload = sql.encode() + b"\x00"
        await self.stream.write(b"Q" + _frame(payload))
        tag = ""
        err: Optional[PgError] = None
        while True:
            kind, payload = await self._read()
            if kind == b"Z":
                break
            if kind == b"C":
                tag = payload.split(b"\x00", 1)[0].decode()
            elif kind == b"E":
                err = _pg_error(_parse_error_fields(payload))
            elif kind in (b"T", b"D", b"N", b"S", b"n", b"I"):
                continue
        if err is not None:
            raise err
        return tag

    async def execute(self, sql: str, *args) -> str:
        _rows, tag = await self._extended(sql, args)
        return tag

    async def executemany(self, sql: str, seq) -> None:
        for params in seq:
            await self.execute(sql, *params)

    async def fetch(self, sql: str, *args) -> list[Row]:
        rows, _tag = await self._extended(sql, args)
        return rows

    async def fetchrow(self, sql: str, *args) -> Optional[Row]:
        rows = await self.fetch(sql, *args)
        return rows[0] if rows else None

    async def fetchval(self, sql: str, *args):
        row = await self.fetchrow(sql, *args)
        if row is None:
            return None
        return next(iter(row.values()))

    def transaction(self):
        return _Transaction(self)

    async def _extended(self, sql: str, args: tuple) -> tuple[list[Row], str]:
        bound = [_bind_param(a) for a in args]
        oids = b"".join(_i32(oid) for oid, _ in bound)
        parse = _cstr("") + _cstr(sql) + _i16(len(bound)) + oids
        values = b""
        for _oid, raw in bound:
            if raw is None:
                values += _i32(-1)
            else:
                values += _i32(len(raw)) + raw
        bind = (
            _cstr("") + _cstr("") + _i16(0) + _i16(len(bound)) + values + _i16(0)
        )
        describe = b"P" + _cstr("")
        execute = _cstr("") + _i32(0)
        packet = (
            b"P" + _frame(parse)
            + b"B" + _frame(bind)
            + b"D" + _frame(describe)
            + b"E" + _frame(execute)
            + b"S" + _frame(b"")
        )
        await self.stream.write(packet)
        rows: list[Row] = []
        cols: list[tuple[str, int]] = []
        tag = ""
        err: Optional[PgError] = None
        while True:
            kind, payload = await self._read()
            if kind == b"Z":
                break
            if kind == b"T":
                cols = _row_description(payload)
            elif kind == b"D":
                rows.append(_data_row(payload, cols))
            elif kind == b"C":
                tag = payload.split(b"\x00", 1)[0].decode()
            elif kind == b"E":
                err = _pg_error(_parse_error_fields(payload))
            elif kind in (b"1", b"2", b"n", b"N", b"S", b"I", b"t"):
                continue
        if err is not None:
            raise err
        return rows, tag

    async def close(self) -> None:
        if self.closed:
            return
        self.closed = True
        try:
            await self.stream.write(b"X" + _frame(b""))
        except Exception:
            pass
        await self.stream.close()


def _row_description(payload: bytes) -> list[tuple[str, int]]:
    count = struct.unpack("!H", payload[:2])[0]
    cols = []
    i = 2
    for _ in range(count):
        end = payload.index(b"\x00", i)
        name = payload[i:end].decode()
        i = end + 1
        i += 4 + 2
        oid = struct.unpack("!I", payload[i:i + 4])[0]
        i += 4 + 2 + 4 + 2
        cols.append((name, oid))
    return cols


def _data_row(payload: bytes, cols: list[tuple[str, int]]) -> Row:
    count = struct.unpack("!H", payload[:2])[0]
    i = 2
    values = []
    for _ in range(count):
        ln = struct.unpack("!i", payload[i:i + 4])[0]
        i += 4
        if ln < 0:
            values.append(None)
        else:
            values.append(payload[i:i + ln].decode())
            i += ln
    row = Row()
    for idx, (name, oid) in enumerate(cols):
        text = values[idx] if idx < len(values) else None
        row[name] = _decode_text(oid, text)
    return row


class _Transaction:
    def __init__(self, conn: PgConnection):
        self.conn = conn

    async def __aenter__(self):
        await self.conn.simple("BEGIN")
        return self.conn

    async def __aexit__(self, exc_type, exc, tb):
        if exc_type is None:
            await self.conn.simple("COMMIT")
        else:
            try:
                await self.conn.simple("ROLLBACK")
            except Exception:
                self.conn.closed = True
        return False


class PgPool:
    """Single-connection pool. Workers handle one request at a time per lock."""

    def __init__(self, database_url: str, transport: str = "tcp"):
        self.database_url = database_url
        self.transport = transport
        self.dsn = parse_dsn(database_url)
        self._conn: Optional[PgConnection] = None
        self._lock = asyncio.Lock()

    def acquire(self):
        return _Acquire(self)

    async def _ensure(self) -> PgConnection:
        if self._conn is None or self._conn.closed:
            self._conn = await connect(self.database_url, self.transport)
        return self._conn

    async def _drop(self) -> None:
        conn = self._conn
        self._conn = None
        if conn is not None:
            await conn.close()

    async def execute(self, sql: str, *args) -> str:
        async with self._lock:
            conn = await self._ensure()
            try:
                return await conn.execute(sql, *args)
            except (ConnectionError, asyncio.IncompleteReadError, OSError):
                await self._drop()
                raise

    async def executemany(self, sql: str, seq) -> None:
        async with self._lock:
            conn = await self._ensure()
            await conn.executemany(sql, seq)

    async def fetch(self, sql: str, *args):
        async with self._lock:
            conn = await self._ensure()
            return await conn.fetch(sql, *args)

    async def fetchrow(self, sql: str, *args):
        async with self._lock:
            conn = await self._ensure()
            return await conn.fetchrow(sql, *args)

    async def fetchval(self, sql: str, *args):
        async with self._lock:
            conn = await self._ensure()
            return await conn.fetchval(sql, *args)

    async def close(self) -> None:
        async with self._lock:
            await self._drop()


class _Acquire:
    def __init__(self, pool: PgPool):
        self.pool = pool
        self.conn: Optional[PgConnection] = None

    async def __aenter__(self) -> PgConnection:
        await self.pool._lock.acquire()
        try:
            self.conn = await self.pool._ensure()
            return self.conn
        except Exception:
            self.pool._lock.release()
            raise

    async def __aexit__(self, exc_type, exc, tb):
        try:
            if exc_type is not None and not isinstance(exc, PgError):
                await self.pool._drop()
        finally:
            self.pool._lock.release()
        return False


async def connect(database_url: str, transport: str = "tcp") -> PgConnection:
    dsn = parse_dsn(database_url)
    if transport == "websocket":
        stream = await open_websocket_stream(dsn)
    else:
        stream = await open_tcp_stream(dsn)
    conn = PgConnection(stream, dsn["user"], dsn["password"], dsn["database"])
    try:
        await conn.start()
    except Exception:
        await stream.close()
        raise
    return conn
