"""Idle pools keep zero connections and close them when shut down."""

import socket
import sys
from types import SimpleNamespace

import pytest

from app.db import (
    POOL_IDLE_S,
    _init_conn,
    checkpointer_pool_config,
    create_pool,
)


@pytest.mark.asyncio
async def test_asyncpg_pool_is_empty_until_used_and_closes(monkeypatch):
    captured = {}

    class FakePool:
        async def close(self):
            captured["closed"] = True

    async def fake_create_pool(*args, **kwargs):
        captured["args"] = args
        captured["kwargs"] = kwargs
        return FakePool()

    monkeypatch.setitem(
        sys.modules, "asyncpg", SimpleNamespace(create_pool=fake_create_pool))
    monkeypatch.setenv("DB_DRIVER", "asyncpg")
    pool = await create_pool("postgres://push:push@127.0.0.1:5432/push")
    assert captured["kwargs"]["min_size"] == 0
    assert captured["kwargs"]["max_inactive_connection_lifetime"] <= 60
    assert captured["kwargs"]["max_inactive_connection_lifetime"] == POOL_IDLE_S
    assert captured["kwargs"]["server_settings"]["application_name"] == "push-ai"
    await pool.close()
    assert captured["closed"] is True


@pytest.mark.asyncio
async def test_init_conn_disables_tcp_keepalive():
    sets = {}

    class Sock:
        def setsockopt(self, level, opt, value):
            sets[(level, opt)] = value

    class Transport:
        def __init__(self, sock):
            self.sock = sock

        def get_extra_info(self, name):
            if name == "socket":
                return self.sock
            return None

    class Conn:
        def __init__(self, sock):
            self._transport = Transport(sock)

        async def set_type_codec(self, *args, **kwargs):
            return None

    sock = Sock()
    await _init_conn(Conn(sock))
    assert sets[(socket.SOL_SOCKET, socket.SO_KEEPALIVE)] == 0


def test_checkpointer_pool_holds_nothing_while_idle():
    cfg = checkpointer_pool_config()
    assert cfg["min_size"] == 0
    assert cfg["max_idle"] <= 60
    assert cfg["kwargs"]["keepalives"] == 0
    assert cfg["kwargs"]["application_name"] == "push-ai"


@pytest.mark.asyncio
async def test_shutdown_closes_the_checkpointer_pool():
    from app.main import _shutdown
    from fastapi import FastAPI

    closed = []

    class Conversations:
        async def stop_worker(self):
            closed.append("worker")

    class Saver:
        async def close(self):
            closed.append("checkpointer")

    class Client:
        async def aclose(self):
            closed.append("client")

    class Pool:
        async def close(self):
            closed.append("pool")

    app = FastAPI()
    app.state._closers = (
        Conversations(), Saver(),
        Client(), Client(), Client(), Client(), Client(),
        Pool(),
    )
    await _shutdown(app)
    assert closed[0] == "worker"
    assert "checkpointer" in closed
    assert closed[-1] == "pool"
    assert app.state._closers is None
