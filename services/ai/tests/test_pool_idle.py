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
async def test_shutdown_stops_the_worker_first_and_closes_the_pool_last(monkeypatch):
    import app.db
    import app.main as main
    from app.config import Config
    from app.domain.services.conversation import ConversationService
    from fastapi import FastAPI
    from tests.cov_fakes import FakeConn

    closed = []

    class Pool(FakeConn):
        async def close(self):
            closed.append("pool")

    class SaverPool:
        async def close(self):
            closed.append("checkpointer")

    async def create_pool(url):
        return Pool()

    async def open_saver(url):
        return "saver", SaverPool()

    async def started(self):
        return None

    async def stopped(self):
        closed.append("worker")

    async def aclose(self):
        closed.append("client")

    monkeypatch.setenv("RUN_MIGRATIONS", "0")
    monkeypatch.delenv("CHECKPOINTER", raising=False)
    monkeypatch.setattr(main, "create_pool", create_pool)
    monkeypatch.setattr(main, "external_jobs", lambda: False)
    monkeypatch.setattr(main, "runs_local_chat_worker", lambda: True)
    monkeypatch.setattr(app.db, "open_chat_checkpointer", open_saver)
    monkeypatch.setattr(ConversationService, "start_worker", started)
    monkeypatch.setattr(ConversationService, "stop_worker", stopped)
    for client in (main.OAuthClient, main.OpenAIClient, main.GoogleClient, main.StripeClient):
        monkeypatch.setattr(client, "aclose", aclose)
    fa = FastAPI()
    await main._bootstrap(fa, Config(database_url="d"))
    await main._shutdown(fa)
    assert closed == ["worker", "checkpointer"] + ["client"] * 5 + ["pool"]
