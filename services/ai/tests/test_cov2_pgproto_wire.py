"""Wire-level tests for app.pgproto driven by a scripted in-memory server."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import math
import struct
from datetime import date, datetime, timedelta, timezone
from uuid import UUID

import pytest

from app import pgproto
from app.pgproto import (
    ByteStream, PgConnection, PgError, UniqueViolationError, _bind_param,
    _decode_text, _parse_array, _parse_ts,
)

U1 = UUID("11111111-1111-1111-1111-111111111111")
U2 = UUID("22222222-2222-2222-2222-222222222222")


def msg(kind: bytes, payload: bytes = b"") -> bytes:
    return kind + struct.pack("!i", len(payload) + 4) + payload


def auth(code: int, extra: bytes = b"") -> bytes:
    return msg(b"R", struct.pack("!i", code) + extra)


READY = msg(b"Z", b"I")


def err(state: str, text: str, kind: bytes = b"E") -> bytes:
    body = b"SERROR\x00C" + state.encode() + b"\x00M" + text.encode() + b"\x00\x00"
    return msg(kind, body)


def rowdesc(*cols: tuple[str, int]) -> bytes:
    body = struct.pack("!H", len(cols))
    for name, oid in cols:
        body += name.encode() + b"\x00" + struct.pack("!ihIhih", 0, 0, oid, -1, -1, 0)
    return msg(b"T", body)


def datarow(*vals) -> bytes:
    body = struct.pack("!H", len(vals))
    for v in vals:
        body += struct.pack("!i", -1) if v is None else struct.pack("!i", len(v)) + v
    return msg(b"D", body)


def complete(tag: str) -> bytes:
    return msg(b"C", tag.encode() + b"\x00")


class FakeStream(ByteStream):
    def __init__(self, *chunks: bytes, responder=None):
        self.inbox = bytearray(b"".join(chunks))
        self.writes: list[bytes] = []
        self.responder = responder
        self.closed = False

    async def readexactly(self, n: int) -> bytes:
        if len(self.inbox) < n:
            raise asyncio.IncompleteReadError(bytes(self.inbox), n)
        out = bytes(self.inbox[:n])
        del self.inbox[:n]
        return out

    async def write(self, data: bytes) -> None:
        self.writes.append(data)
        if self.responder is not None:
            self.inbox += self.responder(data)

    async def close(self) -> None:
        self.closed = True


def conn(*chunks: bytes, user="u", password="pw") -> PgConnection:
    return PgConnection(FakeStream(*chunks), user, password, "db")


# --- startup / auth ------------------------------------------------------

async def test_startup_packet_and_trust_auth_skips_status_messages():
    c = conn(auth(0), msg(b"S", b"a\x00b\x00"), msg(b"K", b"\x00" * 8),
             err("01000", "hi", kind=b"N"), READY)
    await c.start()
    params = (b"user\x00u\x00database\x00db\x00DateStyle\x00ISO\x00"
              b"extra_float_digits\x002\x00\x00")
    body = struct.pack("!i", 196608) + params
    assert c.stream.writes == [struct.pack("!i", len(body) + 4) + body]


async def test_cleartext_password():
    c = conn(auth(3), auth(0), READY)
    await c.start()
    assert c.stream.writes[1] == b"p" + struct.pack("!i", 7) + b"pw\x00"


async def test_md5_password():
    salt = b"\x01\x02\x03\x04"
    c = conn(auth(5, salt), auth(0), READY)
    await c.start()
    inner = hashlib.md5(b"pwu").hexdigest().encode()
    want = b"md5" + hashlib.md5(inner + salt).hexdigest().encode() + b"\x00"
    assert c.stream.writes[1] == b"p" + struct.pack("!i", len(want) + 4) + want


async def test_stray_sasl_codes_are_ignored_at_top_level():
    c = conn(auth(11), auth(12), auth(0), READY)
    await c.start()


@pytest.mark.parametrize("chunks,state", [
    ((auth(7),), "28000"),
    ((err("28P01", "bad password"),), "28P01"),
    ((msg(b"D", b""),), "08006"),
])
async def test_startup_failures(chunks, state):
    with pytest.raises(PgError) as info:
        await conn(*chunks).start()
    assert info.value.sqlstate == state


def _split(data: bytes) -> tuple[bytes, bytes]:
    return data[:1], data[5:]


class ScramServer:
    """Minimal RFC 5802 server that verifies the client proof."""

    def __init__(self, password: str, *, salt=b"NaCl-salt", iters=4096,
                 bad_sig=False, final=None, first=None, nonce_suffix="srv"):
        self.salted = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, iters)
        self.salt, self.iters = salt, iters
        self.bad_sig, self.final, self.first = bad_sig, final, first
        self.nonce_suffix = nonce_suffix
        self.step = 0
        self.proof_ok = None
        self.client_first = None

    def __call__(self, data: bytes) -> bytes:
        self.step += 1
        if self.step == 1:
            return auth(10, b"SCRAM-SHA-256\x00SCRAM-SHA-256-PLUS\x00\x00")
        kind, body = _split(data)
        assert kind == b"p"
        if self.step == 2:
            mech, _, rest = body.partition(b"\x00")
            assert mech == b"SCRAM-SHA-256"
            n = struct.unpack("!i", rest[:4])[0]
            self.client_first = rest[4:4 + n].decode()
            assert self.client_first.startswith("n,,")
            self.bare = self.client_first[3:]
            cnonce = self.bare.split(",r=", 1)[1]
            self.server_first = (
                f"r={cnonce}{self.nonce_suffix},"
                f"s={base64.b64encode(self.salt).decode()},i={self.iters}")
            if self.first is not None:
                return self.first
            return auth(11, self.server_first.encode())
        final = body.decode()
        final_wo, _, proof_b64 = final.rpartition(",p=")
        auth_msg = f"{self.bare},{self.server_first},{final_wo}".encode()
        client_key = hmac.new(self.salted, b"Client Key", hashlib.sha256).digest()
        stored = hashlib.sha256(client_key).digest()
        client_sig = hmac.new(stored, auth_msg, hashlib.sha256).digest()
        recovered = bytes(a ^ b for a, b in zip(base64.b64decode(proof_b64), client_sig))
        self.proof_ok = hashlib.sha256(recovered).digest() == stored
        server_key = hmac.new(self.salted, b"Server Key", hashlib.sha256).digest()
        sig = hmac.new(server_key, auth_msg, hashlib.sha256).digest()
        if self.bad_sig:
            sig = bytes(32)
        if self.final is not None:
            return self.final
        return auth(12, b"v=" + base64.b64encode(sig)) + auth(0) + READY


async def test_scram_handshake_proves_password_and_escapes_user():
    server = ScramServer("pencil")
    c = PgConnection(FakeStream(responder=server), "a=b,c", "pencil", "db")
    await c.start()
    assert server.proof_ok is True
    assert server.bare.startswith("n=a=3Db=2Cc,r=")


async def test_scram_wrong_password_fails_proof_and_server_signature():
    server = ScramServer("pencil")
    c = PgConnection(FakeStream(responder=server), "u", "eraser", "db")
    with pytest.raises(PgError, match="server signature mismatch"):
        await c.start()
    assert server.proof_ok is False


async def test_scram_rejects_bad_server_signature():
    server = ScramServer("pw", bad_sig=True)
    c = PgConnection(FakeStream(responder=server), "u", "pw", "db")
    with pytest.raises(PgError, match="server signature mismatch"):
        await c.start()


async def test_scram_final_without_r0_pushes_back_next_message():
    # Server skips AuthenticationOk and goes straight to ReadyForQuery.
    server = ScramServer("pw", final=auth(12, b"v=") + READY)
    c = PgConnection(FakeStream(responder=server), "u", "pw", "db")
    await c.start()
    assert c._pushback is None


@pytest.mark.parametrize("kwargs,match", [
    ({"first": err("28P01", "no")}, "28P01"),
    ({"first": auth(0)}, "expected SASL continue"),
    ({"first": msg(b"S", b"x\x00y\x00")}, "expected SASL continue"),
    ({"final": err("28P01", "bad proof")}, "28P01"),
    ({"final": auth(5, b"salt")}, "unexpected SASL auth code 5"),
])
async def test_scram_protocol_errors(kwargs, match):
    server = ScramServer("pw", **kwargs)
    c = PgConnection(FakeStream(responder=server), "u", "pw", "db")
    with pytest.raises(PgError, match=match):
        await c.start()


async def test_scram_nonce_must_extend_client_nonce():
    server = ScramServer("pw")
    orig = server.__call__

    def tamper(data):
        out = orig(data)
        if server.step == 2:
            server.server_first = "r=evil,s=c2FsdA==,i=1"
            return auth(11, server.server_first.encode())
        return out

    c = PgConnection(FakeStream(responder=tamper), "u", "pw", "db")
    with pytest.raises(PgError, match="nonce mismatch"):
        await c.start()


async def test_scram_requires_sha256_mechanism():
    c = conn(auth(10, b"SCRAM-SHA-1\x00\x00"))
    with pytest.raises(PgError, match="did not offer SCRAM-SHA-256"):
        await c.start()


# --- simple query --------------------------------------------------------

async def test_simple_query_returns_tag_and_ignores_rows_and_notices():
    c = conn(rowdesc(("x", 23)), datarow(b"1"), err("01000", "n", kind=b"N"),
             msg(b"S", b"a\x00b\x00"), msg(b"I"), msg(b"n"), msg(b"?"),
             complete("BEGIN"), READY)
    assert await c.simple("BEGIN") == "BEGIN"
    assert c.stream.writes == [b"Q" + struct.pack("!i", 10) + b"BEGIN\x00"]


async def test_simple_query_raises_error_after_ready():
    c = conn(err("42601", "syntax"), READY)
    with pytest.raises(PgError) as info:
        await c.simple("BOGUS")
    assert info.value.sqlstate == "42601"
    assert info.value.message == "syntax"
    assert not c.stream.inbox


# --- extended query ------------------------------------------------------

async def test_execute_writes_parse_bind_describe_execute_sync():
    c = conn(msg(b"1"), msg(b"2"), msg(b"n"), complete("INSERT 0 1"), READY)
    tag = await c.execute("INSERT $1 $2", None, True)
    assert tag == "INSERT 0 1"
    parse = b"\x00INSERT $1 $2\x00" + struct.pack("!hii", 2, 0, 16)
    bind = (b"\x00\x00" + struct.pack("!hh", 0, 2) + struct.pack("!i", -1)
            + struct.pack("!i", 4) + b"true" + struct.pack("!h", 0))
    want = (msg(b"P", parse) + msg(b"B", bind) + msg(b"D", b"P\x00")
            + msg(b"E", b"\x00" + struct.pack("!i", 0)) + msg(b"S"))
    assert c.stream.writes == [want]


async def test_fetch_decodes_typed_columns():
    cols = [("id", 2950), ("n", 23), ("flag", 16), ("note", 3802), ("blob", 17),
            ("at", 1184), ("ids", 2951), ("null", 25), ("missing", 25)]
    c = conn(msg(b"1"), msg(b"2"), rowdesc(*cols),
             datarow(str(U1).encode(), b"7", b"t", b'{"a": 1}', b"\\x00ff",
                     b"2026-10-17 12:30:00+00", ("{%s,%s}" % (U1, U2)).encode(), None),
             complete("SELECT 1"), READY)
    row = await c.fetchrow("SELECT ...")
    assert dict(row) == {
        "id": U1, "n": 7, "flag": True, "note": {"a": 1}, "blob": b"\x00\xff",
        "at": datetime(2026, 10, 17, 12, 30, tzinfo=timezone.utc),
        "ids": [U1, U2], "null": None, "missing": None,
    }


async def test_fetchval_and_fetchrow_with_no_rows():
    c = conn(rowdesc(("x", 23)), complete("SELECT 0"), READY,
             rowdesc(("x", 23)), complete("SELECT 0"), READY)
    assert await c.fetchval("SELECT 1") is None
    assert await c.fetchrow("SELECT 1") is None


async def test_extended_unique_violation_after_sync():
    c = conn(err("23505", "dup"), READY)
    with pytest.raises(UniqueViolationError):
        await c.execute("INSERT")


async def test_executemany_runs_each_parameter_set():
    c = conn(complete("INSERT 0 1"), READY, complete("INSERT 0 1"), READY)
    await c.executemany("INSERT $1", [(1,), (2,)])
    assert len(c.stream.writes) == 2
    assert b"\x00\x00\x00\x011" in c.stream.writes[0]
    assert b"\x00\x00\x00\x012" in c.stream.writes[1]


def _param_desc(*oids: int) -> bytes:
    return msg(b"t", struct.pack("!h", len(oids)) + b"".join(struct.pack("!i", o) for o in oids))


async def test_list_param_into_jsonb_is_sent_as_json():
    c = conn(msg(b"1"), _param_desc(3802, 23), msg(b"n"), READY,
             complete("UPDATE 1"), READY)
    await c.execute("UPDATE t SET a=$1 WHERE n=$2", [], 5)
    describe = c.stream.writes[0]
    assert describe.startswith(msg(b"P", b"\x00UPDATE t SET a=$1 WHERE n=$2\x00"
                                   + struct.pack("!hii", 2, 0, 0)))
    assert describe.endswith(msg(b"D", b"S\x00") + msg(b"S"))
    bind_part = c.stream.writes[1]
    assert struct.pack("!hii", 2, 3802, 0) in bind_part
    assert struct.pack("!i", 2) + b"[]" in bind_part


async def test_list_param_takes_inferred_array_oid_or_keeps_guess():
    # int4[] inferred for $1; describe returns fewer oids than params -> keep $2.
    c = conn(_param_desc(1007), READY, complete("SELECT 1"), READY)
    await c.execute("SELECT $1, $2", [1, 2], [U1])
    assert struct.pack("!hii", 2, 1007, 2951) in c.stream.writes[1]


async def test_list_param_with_unknown_inferred_oid_keeps_guess():
    c = conn(_param_desc(0), READY, complete("SELECT 1"), READY)
    await c.execute("SELECT $1", ["a"])
    assert struct.pack("!hi", 1, 1009) in c.stream.writes[1]


async def test_describe_error_is_raised():
    c = conn(err("42P01", "no table"), READY)
    with pytest.raises(PgError, match="42P01"):
        await c.execute("SELECT * FROM nope WHERE id = ANY($1)", [U1])


# --- close / transaction -------------------------------------------------

async def test_close_sends_terminate_once():
    c = conn()
    await c.close()
    await c.close()
    assert c.stream.writes == [b"X\x00\x00\x00\x04"]
    assert c.stream.closed


async def test_close_ignores_write_failure():
    class Broken(FakeStream):
        async def write(self, data):
            raise ConnectionError("gone")

    c = PgConnection(Broken(), "u", "p", "db")
    await c.close()
    assert c.closed and c.stream.closed


async def test_transaction_commits():
    c = conn(complete("BEGIN"), READY, complete("COMMIT"), READY)
    async with c.transaction() as tx:
        assert tx is c
    assert [w[5:-1] for w in c.stream.writes] == [b"BEGIN", b"COMMIT"]


async def test_transaction_rolls_back_on_error():
    c = conn(complete("BEGIN"), READY, complete("ROLLBACK"), READY)
    with pytest.raises(KeyError):
        async with c.transaction():
            raise KeyError("x")
    assert c.stream.writes[-1][5:-1] == b"ROLLBACK"
    assert c.closed is False


async def test_failed_rollback_marks_connection_closed():
    c = conn(complete("BEGIN"), READY)  # stream ends before ROLLBACK reply
    with pytest.raises(KeyError):
        async with c.transaction():
            raise KeyError("x")
    assert c.closed is True


# --- codecs --------------------------------------------------------------

@pytest.mark.parametrize("oid,text,want", [
    (16, None, None),
    (16, "f", False),
    (16, "true", True),
    (21, "-3", -3),
    (20, "9007199254740993", 9007199254740993),
    (700, "1.5", 1.5),
    (701, "-2.25", -2.25),
    (1700, "12", 12),
    (1700, "12.50", 12.5),
    (114, "[1, 2]", [1, 2]),
    (1082, "2026-10-17", date(2026, 10, 17)),
    (1114, "2026-10-17 12:30:00", datetime(2026, 10, 17, 12, 30, tzinfo=timezone.utc)),
    (17, "\\x6869", b"hi"),
    (17, "zz", b"zz"),
    (1009, '{a,"b,c","d\\"e",""}', ["a", "b,c", 'd"e', ""]),
    (3807, "{}", []),
    (1007, "{1,2,3}", [1, 2, 3]),
    (1016, "", []),
    (25, "plain", "plain"),
])
def test_decode_text(oid, text, want):
    assert _decode_text(oid, text) == want


@pytest.mark.parametrize("text,offset", [
    ("2026-10-17 12:30:00Z", timedelta(0)),
    ("2026-10-17 12:30:00+09", timedelta(hours=9)),
    ("2026-10-17 12:30:00-0530", timedelta(hours=-5, minutes=-30)),
    ("2026-10-17 12:30:00.123456+05:30", timedelta(hours=5, minutes=30)),
])
def test_parse_ts_offsets(text, offset):
    assert _parse_ts(text).utcoffset() == offset


def test_parse_array_without_braces_and_trailing_backslash():
    assert _parse_array("a,b") == ["a", "b"]
    assert _parse_array('"x\\') == ["x"]


class _Custom:
    def __str__(self):
        return "custom"


@pytest.mark.parametrize("value,want", [
    (None, (0, None)),
    (False, (16, b"false")),
    (42, (0, b"42")),
    (0.1, (0, b"0.1")),
    (U1, (0, str(U1).encode())),
    (datetime(2026, 1, 2, 3, 4, 5), (0, b"2026-01-02T03:04:05+00:00")),
    (datetime(2026, 1, 2, tzinfo=timezone(timedelta(hours=9))),
     (0, b"2026-01-02T00:00:00+09:00")),
    (bytearray(b"\x00\xff"), (17, b"\\x00ff")),
    ({"k": U1}, (3802, ('{"k": "%s"}' % U1).encode())),
    ([], (2951, b"{}")),
    ((U1, U2), (2951, ("{%s,%s}" % (U1, U2)).encode())),
    ([1, True, 3], (1016, b"{1,1,3}")),
    (["a", 'b"c', 1], (1009, b'{"a","b\\"c","1"}')),
    (_Custom(), (0, b"custom")),
])
def test_bind_param(value, want):
    assert _bind_param(value) == want


def test_parse_dsn_defaults_and_postgres_scheme():
    dsn = pgproto.parse_dsn("postgres://host.example")
    assert dsn == {"user": "", "password": "", "host": "host.example",
                   "port": 5432, "database": "postgres", "sslmode": "prefer"}


def test_error_fields_default_when_missing():
    e = pgproto._pg_error(pgproto._parse_error_fields(b"\x00"))
    assert (e.sqlstate, e.message) == ("XX000", "postgres error")
    assert str(e) == "XX000: postgres error"


@pytest.mark.xfail(strict=True, reason=(
    "BUG: text[] params are escaped with json.dumps (ensure_ascii, \\n, \\uXXXX); "
    "Postgres array literals only treat backslash as 'take next char literally', "
    "so non-ASCII/control characters are corrupted (pgproto.py:255)"))
def test_bind_text_array_preserves_non_ascii():
    assert _bind_param(["é", "a\nb"]) == (1009, '{"é","a\nb"}'.encode())


@pytest.mark.xfail(strict=True, reason=(
    "BUG: numeric 'NaN' (valid Postgres numeric) is fed to int() and raises "
    "ValueError (pgproto.py:202)"))
def test_decode_numeric_nan():
    assert math.isnan(_decode_text(1700, "NaN"))
