import pytest

pytest.importorskip("langgraph.checkpoint.postgres")  # local extra; CI installs the Workers set

import sys
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import langgraph.checkpoint.postgres.aio  # noqa: F401  (import before patching psycopg_pool)
import pytest

from app import db as dbmod
from app.claimctx import LostClaim
from app.db import (
    DB, ConflictError, NotFoundError, _init_conn, create_pool, database_driver,
    migrations_dir, open_chat_checkpointer, pg_transport, run_migrations,
    unique_violation,
)
from app.domain.errors import DomainError, internal
from tests.cov_fakes import USER, FakeConn


class _CodecConn:
    def __init__(self, transport=None):
        self.codecs = []
        if transport is not None:
            self._transport = transport

    async def set_type_codec(self, name, **kw):
        self.codecs.append((name, kw["schema"]))


async def test_init_conn_without_transport_only_sets_codecs():
    c = _CodecConn()
    await _init_conn(c)
    assert c.codecs == [("json", "pg_catalog"), ("jsonb", "pg_catalog")]


async def test_init_conn_without_socket_returns():
    await _init_conn(_CodecConn(SimpleNamespace(get_extra_info=lambda n: None)))


async def test_init_conn_ignores_setsockopt_error():
    class Sock:
        def setsockopt(self, *a):
            raise OSError("closed")
    await _init_conn(_CodecConn(SimpleNamespace(get_extra_info=lambda n: Sock())))


@pytest.mark.parametrize("env,url,want", [
    ("asyncpg", "postgres://h.neon.tech/db", "asyncpg"),
    ("neon", "postgres://localhost/db", "neon"),
    (" PG ", "postgres://localhost/db", "neon"),
    ("", "postgres://ep-x.us-east-2.aws.neon.tech/db", "neon"),
    ("", "postgres://localhost/db", "asyncpg"),
    ("bogus", "postgres://localhost/db", "asyncpg"),
    ("", "postgres://[bad", "asyncpg"),
])
def test_database_driver(monkeypatch, env, url, want):
    monkeypatch.setenv("DB_DRIVER", env)
    monkeypatch.delenv("CF_WORKER", raising=False)
    assert database_driver(url) == want


def test_database_driver_ignores_cf_worker(monkeypatch):
    monkeypatch.delenv("DB_DRIVER", raising=False)
    monkeypatch.setenv("CF_WORKER", "1")
    assert database_driver("postgres://localhost/db") == "asyncpg"


@pytest.mark.parametrize("explicit,worker,want", [
    ("TCP", "1", "tcp"), ("websocket", "", "websocket"), ("", "1", "tcp"),
    ("", "", "tcp"), ("udp", "", "tcp"),
])
def test_pg_transport(monkeypatch, explicit, worker, want):
    monkeypatch.setenv("PG_TRANSPORT", explicit)
    monkeypatch.setenv("CF_WORKER", worker)
    assert pg_transport() == want


async def test_create_pool_neon_uses_wire_client(monkeypatch):
    monkeypatch.setenv("DB_DRIVER", "neon")
    monkeypatch.setenv("PG_TRANSPORT", "websocket")
    pool = await create_pool("postgres://u:p@ep-x.neon.tech/db?sslmode=require")
    from app.pgproto import PgPool
    assert isinstance(pool, PgPool) and pool.transport == "websocket"


async def test_create_pool_strips_sslmode_disable(monkeypatch):
    seen = {}

    async def fake_create_pool(url, **kw):
        seen["url"] = url
        seen["init"] = kw["init"]
        return "pool"

    monkeypatch.setitem(sys.modules, "asyncpg", SimpleNamespace(create_pool=fake_create_pool))
    monkeypatch.setenv("DB_DRIVER", "asyncpg")
    assert await create_pool("postgres://h/db?sslmode=disable") == "pool"
    assert seen["url"] == "postgres://h/db" and seen["init"] is _init_conn
    await create_pool("postgres://h/db?x=1&sslmode=disable")
    assert seen["url"] == "postgres://h/db?x=1"


async def test_db_q_uses_tx_inside_do():
    conn = FakeConn()
    db = DB(conn)
    assert db.q() is conn
    seen = []

    async def fn():
        seen.append(db.q())
        return 5

    assert await db.do(fn) == 5
    assert seen == [conn] and db.q() is conn


async def test_db_run_passes_domain_errors_and_wraps_others():
    db = DB(FakeConn())

    async def raise_(e):
        raise e

    err = internal()
    with pytest.raises(DomainError) as e:
        await db.run(lambda: raise_(err))
    assert e.value is err
    with pytest.raises(LostClaim):
        await db.run(lambda: raise_(LostClaim()))
    with pytest.raises(DomainError) as e:
        await db.run(lambda: raise_(RuntimeError("x")))
    assert e.value.status == 500


async def test_revision_guard():
    id_ = uuid4()
    conn = FakeConn(None, {"revision": 3})
    db = DB(conn)
    with pytest.raises(NotFoundError):
        await db.revision_guard("jobs", id_, USER)
    assert conn.last[2] == (id_, USER)
    with pytest.raises(ConflictError) as e:
        await db.revision_guard("jobs", id_, USER)
    assert e.value.current == 3


def test_unique_violation():
    from app.pgproto import UniqueViolationError

    class Named(Exception):
        pass
    Named.__name__ = "UniqueViolationError"

    class State(Exception):
        sqlstate = "23505"

    assert unique_violation(UniqueViolationError("XX000", "dup"))
    assert unique_violation(Named())
    assert unique_violation(State())
    assert not unique_violation(RuntimeError())


class _MigConn(FakeConn):
    def __init__(self, applied, simple=True):
        super().__init__()
        self.applied = set(applied)
        self.scripts = []
        if simple:
            self.simple = self._simple

    async def _simple(self, sql):
        self.scripts.append(("simple", sql))

    async def execute(self, sql, *args):
        if not sql.startswith(("SELECT pg_advisory", "CREATE TABLE IF NOT", "INSERT INTO schema")):
            self.scripts.append(("execute", sql))
        return await super().execute(sql, *args)

    async def fetchval(self, sql, *args):
        self.calls.append(("fetchval", sql, args))
        return args[0] in self.applied


@pytest.mark.parametrize("simple", [True, False])
async def test_run_migrations_applies_pending_in_order_under_lock(tmp_path, simple):
    (tmp_path / "0002_b.sql").write_text("B;")
    (tmp_path / "0001_a.sql").write_text("A;")
    (tmp_path / "0003_c.sql").write_text("C;")
    (tmp_path / "notes.txt").write_text("skip")
    (tmp_path / "dir.sql").mkdir()
    conn = _MigConn({"0001_a.sql"}, simple=simple)
    await run_migrations(conn, str(tmp_path))
    kind = "simple" if simple else "execute"
    assert conn.scripts == [(kind, "B;"), (kind, "C;")]
    sqls = [c[1] for c in conn.calls]
    assert sqls[0] == "SELECT pg_advisory_lock($1)"
    assert sqls[-1] == "SELECT pg_advisory_unlock($1)"
    inserted = [c[2] for c in conn.calls if c[1].startswith("INSERT INTO schema_migrations")]
    assert inserted == [("0002_b.sql",), ("0003_c.sql",)]


async def test_run_migrations_unlocks_on_failure(tmp_path):
    (tmp_path / "0001_a.sql").write_text("A;")
    conn = _MigConn(set())

    async def boom(sql):
        raise RuntimeError("bad sql")
    conn.simple = boom
    with pytest.raises(RuntimeError):
        await run_migrations(conn, str(tmp_path))
    assert conn.calls[-1][1] == "SELECT pg_advisory_unlock($1)"


def test_migrations_dir_finds_repo_migrations():
    d = migrations_dir()
    assert (d / "0001_init.sql").is_file()


def test_migrations_dir_falls_back_when_absent(monkeypatch, tmp_path):
    fake = tmp_path / "a" / "app" / "db.py"
    monkeypatch.setattr(dbmod, "__file__", str(fake))
    assert migrations_dir() == Path(fake).parents[1] / "migrations"


class _Pool:
    instances = []

    def __init__(self, url, **kw):
        self.url, self.kw, self.closed, self.opened = url, kw, False, False
        _Pool.instances.append(self)

    async def open(self):
        self.opened = True

    async def close(self):
        self.closed = True


async def test_open_chat_checkpointer_sets_up_saver(monkeypatch):
    class Saver:
        def __init__(self, conn):
            self.conn = conn

        async def setup(self):
            pass

    monkeypatch.setattr("psycopg_pool.AsyncConnectionPool", _Pool)
    monkeypatch.setattr("langgraph.checkpoint.postgres.aio.AsyncPostgresSaver", Saver)
    saver, pool = await open_chat_checkpointer("postgres://h/db")
    assert saver.conn is pool and pool.opened and not pool.closed
    assert pool.kw["open"] is False and pool.kw["max_size"] == 4
    assert pool.kw["kwargs"]["row_factory"] is not None
    assert pool.kw["kwargs"]["prepare_threshold"] == 0


async def test_open_chat_checkpointer_closes_pool_when_setup_fails(monkeypatch):
    class Saver:
        def __init__(self, conn):
            pass

        async def setup(self):
            raise RuntimeError("no db")

    monkeypatch.setattr("psycopg_pool.AsyncConnectionPool", _Pool)
    monkeypatch.setattr("langgraph.checkpoint.postgres.aio.AsyncPostgresSaver", Saver)
    with pytest.raises(RuntimeError):
        await open_chat_checkpointer("postgres://h/db")
    assert _Pool.instances[-1].closed
