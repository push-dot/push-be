from __future__ import annotations
import asyncio
import contextvars
import json
import logging
import os
import socket
from pathlib import Path
from typing import Any, Awaitable, Callable

logger = logging.getLogger(__name__)

_tx: contextvars.ContextVar[Any | None] = contextvars.ContextVar("tx", default=None)


class NotFoundError(Exception):
    pass


class ConflictError(Exception):
    def __init__(self, current: int):
        super().__init__("revision conflict")
        self.current = current


POOL_MIN_SIZE = 0
POOL_MAX_SIZE = 10
POOL_IDLE_S = 30.0
APP_NAME = "push-ai"
CHECKPOINTER_IDLE_S = 60.0
CHECKPOINTER_MAX_SIZE = 4


async def _init_conn(conn) -> None:
    for t in ("json", "jsonb"):
        await conn.set_type_codec(
            t, encoder=json.dumps, decoder=json.loads, schema="pg_catalog")
    transport = getattr(conn, "_transport", None)
    get_extra = getattr(transport, "get_extra_info", None)
    sock = get_extra("socket") if get_extra is not None else None
    if sock is None:
        return
    try:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 0)
    except OSError:
        return


def checkpointer_pool_config() -> dict:
    return {
        "min_size": 0,
        "max_size": CHECKPOINTER_MAX_SIZE,
        "max_idle": CHECKPOINTER_IDLE_S,
        "kwargs": {
            "autocommit": True,
            "prepare_threshold": 0,
            "keepalives": 0,
            "application_name": APP_NAME,
        },
    }


async def open_chat_checkpointer(database_url: str):
    from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
    from psycopg.rows import dict_row
    from psycopg_pool import AsyncConnectionPool

    cfg = checkpointer_pool_config()
    kwargs = dict(cfg["kwargs"])
    kwargs["row_factory"] = dict_row
    pool = AsyncConnectionPool(
        database_url,
        min_size=cfg["min_size"],
        max_size=cfg["max_size"],
        max_idle=cfg["max_idle"],
        open=False,
        kwargs=kwargs,
    )
    await pool.open()
    try:
        saver = AsyncPostgresSaver(conn=pool)
        await saver.setup()
    except Exception:
        await pool.close()
        raise
    return saver, pool


class DB:
    def __init__(self, pool):
        self.pool = pool

    def q(self):
        tx = _tx.get()
        return tx if tx is not None else self.pool

    async def do(self, fn: Callable[[], Awaitable[Any]]) -> Any:
        async with self.pool.acquire() as conn:
            async with conn.transaction():
                token = _tx.set(conn)
                try:
                    return await fn()
                finally:
                    _tx.reset(token)

    async def run(self, fn: Callable[[], Awaitable[Any]]) -> Any:
        from app.claimctx import LostClaim
        from app.domain.errors import DomainError, internal
        try:
            return await self.do(fn)
        except (DomainError, LostClaim):
            raise
        except Exception:
            logger.exception("transaction failed")
            raise internal()

    async def revision_guard(self, table: str, id_, user_id) -> None:
        row = await self.q().fetchrow(
            f"SELECT revision FROM {table} WHERE id = $1 AND user_id = $2", id_, user_id)
        if row is None:
            raise NotFoundError()
        raise ConflictError(row["revision"])


def unique_violation(err: Exception) -> bool:
    from app.pgproto import UniqueViolationError
    if isinstance(err, UniqueViolationError):
        return True
    name = type(err).__name__
    return name == "UniqueViolationError" or getattr(err, "sqlstate", None) == "23505"


_MIGRATION_LOCK_KEY = 0x707573685F6D6967


async def run_migrations(pool, dir_: str) -> None:
    async with pool.acquire() as lock_conn:
        await lock_conn.execute(
            "SELECT pg_advisory_lock($1)", _MIGRATION_LOCK_KEY)
        try:
            await lock_conn.execute(
                "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())")
            names = sorted(p.name for p in Path(dir_).iterdir()
                           if p.suffix == ".sql" and p.is_file())
            for name in names:
                applied = await lock_conn.fetchval(
                    "SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE name=$1)",
                    name)
                if applied:
                    continue
                sql = (Path(dir_) / name).read_text()
                script = getattr(lock_conn, "simple", None)
                async with lock_conn.transaction():
                    if script is not None:
                        await lock_conn.simple(sql)
                    else:
                        await lock_conn.execute(sql)
                    await lock_conn.execute(
                        "INSERT INTO schema_migrations (name) VALUES ($1)", name)
        finally:
            await lock_conn.execute(
                "SELECT pg_advisory_unlock($1)", _MIGRATION_LOCK_KEY)


def migrations_dir() -> Path:
    """Directory of ``NNNN_*.sql`` files.

    Walks parents of this module so ``db/migrations`` at the repo root is
    found from a laptop checkout. The Worker upload is only ``src/``, so
    the directory is absent there and ``RUN_MIGRATIONS=0`` skips the apply.
    """
    here = Path(__file__).resolve()
    for parent in here.parents:
        candidate = parent / "db" / "migrations"
        if (candidate / "0001_init.sql").is_file():
            return candidate
    return here.parents[1] / "migrations"


def database_driver(database_url: str) -> str:
    explicit = os.environ.get("DB_DRIVER", "").strip().lower()
    if explicit in ("asyncpg", "neon", "pg"):
        return "asyncpg" if explicit == "asyncpg" else "neon"
    host = ""
    try:
        from urllib.parse import urlparse
        host = urlparse(database_url).hostname or ""
    except Exception:
        host = ""
    if host.endswith(".neon.tech") or os.environ.get("CF_WORKER") == "1":
        return "neon"
    return "asyncpg"


def pg_transport() -> str:
    explicit = os.environ.get("PG_TRANSPORT", "").strip().lower()
    if explicit in ("tcp", "websocket"):
        return explicit
    if os.environ.get("CF_WORKER") == "1":
        return "websocket"
    return "tcp"


async def create_pool(database_url: str):
    driver = database_driver(database_url)
    if driver == "neon":
        from app.pgproto import PgPool
        return PgPool(database_url, transport=pg_transport())
    import asyncpg
    url = database_url.replace("?sslmode=disable", "").replace("&sslmode=disable", "")
    return await asyncpg.create_pool(
        url,
        init=_init_conn,
        min_size=POOL_MIN_SIZE,
        max_size=POOL_MAX_SIZE,
        max_inactive_connection_lifetime=POOL_IDLE_S,
        server_settings={"application_name": APP_NAME},
    )
