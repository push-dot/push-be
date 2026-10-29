"""App bootstrap, lifespan and shutdown with a fake pool. No network, no DB."""
import asyncio

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import app.db
import app.main as main
from app.config import Config
from app.domain.services.conversation import ConversationService
from tests.cov_fakes import FakeConn


class Pool(FakeConn):
    closed = False

    async def close(self):
        self.closed = True


@pytest.fixture
def boot(monkeypatch, tmp_path):
    env = {"migrated": [], "workers": []}
    pool = Pool()
    env["pool"] = pool

    async def create_pool(url):
        env["url"] = url
        return pool

    async def run_migrations(p, d):
        env["migrated"].append((p, d))

    async def start(self):
        env["workers"].append("start")

    async def stop(self):
        env["workers"].append("stop")

    monkeypatch.setattr(main, "create_pool", create_pool)
    monkeypatch.setattr(main, "run_migrations", run_migrations)
    monkeypatch.setattr(main, "migrations_dir", lambda: tmp_path)
    monkeypatch.setattr(ConversationService, "start_worker", start)
    monkeypatch.setattr(ConversationService, "stop_worker", stop)
    monkeypatch.delenv("CF_WORKER", raising=False)
    monkeypatch.delenv("RUN_MIGRATIONS", raising=False)
    monkeypatch.delenv("CHECKPOINTER", raising=False)
    env["tmp"] = tmp_path
    return env


async def test_bootstrap_dev_seeds_user_migrates_and_starts_local_worker(boot, monkeypatch):
    monkeypatch.setattr(main, "external_jobs", lambda: False)
    monkeypatch.setattr(main, "runs_local_chat_worker", lambda: True)
    monkeypatch.setenv("CHECKPOINTER", "memory")
    cfg = Config(database_url="postgres://db", app_env="development",
                 dev_auth_token="dev", managed_ai_key="k",
                 stripe_secret="s", experiments=[{"key": "exp", "variants": ["a", "b"]}])
    fa = FastAPI()
    await main._bootstrap(fa, cfg)
    pool = boot["pool"]
    assert boot["url"] == "postgres://db"
    assert boot["migrated"] == [(pool, str(boot["tmp"]))]
    sqls = [c[1] for c in pool.calls]
    assert any("FROM users WHERE id = $1" in s for s in sqls)
    assert any("VALUES ($1,'dev','dev','Dev User'" in s for s in sqls)
    assert any(s.startswith("INSERT INTO experiments") for s in sqls)
    deps = fa.state.deps
    assert deps.cfg.managed_ai and deps.cfg.stripe_configured
    assert not deps.cfg.google_configured and not deps.cfg.managed_go
    assert fa.state.db.pool is pool
    assert deps.conversations._checkpointer is not None
    assert boot["workers"] == ["start"]

    await main._shutdown(fa)
    assert boot["workers"] == ["start", "stop"] and pool.closed
    assert fa.state.exit_stack is None
    await main._shutdown(fa)


async def test_bootstrap_external_jobs_skips_migrations_dev_seed_and_saver(boot, monkeypatch):
    monkeypatch.setattr(main, "external_jobs", lambda: True)
    monkeypatch.setattr(main, "runs_local_chat_worker", lambda: False)
    monkeypatch.setenv("RUN_MIGRATIONS", "0")
    cfg = Config(database_url="postgres://db", app_env="production", dev_auth_token="dev")
    fa = FastAPI()
    await main._bootstrap(fa, cfg)
    assert boot["migrated"] == [] and boot["pool"].calls == []
    assert fa.state.deps.conversations._checkpointer is None
    await main._shutdown(fa)
    assert boot["workers"] == [] and boot["pool"].closed


async def test_bootstrap_existing_dev_user_is_not_reseeded(boot, monkeypatch):
    from tests.cov_fakes import row
    from app.domain.entities import User
    from app.infrastructure.store_auth import _USER_COLS
    boot["pool"].results.append(row(_USER_COLS, User))
    monkeypatch.setattr(main, "external_jobs", lambda: True)
    monkeypatch.setattr(main, "runs_local_chat_worker", lambda: False)
    await main._bootstrap(FastAPI(), Config(
        database_url="d", app_env="development", dev_auth_token="dev"))
    assert len(boot["pool"].calls) == 1


async def test_bootstrap_opens_postgres_checkpointer_and_exits_it(boot, monkeypatch):
    exited = []

    class SaverPool:
        async def close(self):
            exited.append("closed")

    async def open_saver(url):
        return "saver", SaverPool()

    monkeypatch.setattr(main, "external_jobs", lambda: False)
    monkeypatch.setattr(main, "runs_local_chat_worker", lambda: False)
    monkeypatch.setattr(app.db, "open_chat_checkpointer", open_saver)
    fa = FastAPI()
    await main._bootstrap(fa, Config(database_url="d"))
    assert fa.state.deps.conversations._checkpointer == "saver"
    await main._shutdown(fa)
    assert exited == ["closed"]


async def test_failed_bootstrap_closes_what_it_opened(boot, monkeypatch):
    # A migration error used to leave the pool and HTTP clients open.
    closed = []

    async def failing_migrations(p, d):
        raise RuntimeError("migration 0027 failed")

    async def aclose(self):
        closed.append(type(self).__name__)

    monkeypatch.setattr(main, "run_migrations", failing_migrations)
    for client in (main.OAuthClient, main.OpenAIClient, main.GoogleClient, main.StripeClient):
        monkeypatch.setattr(client, "aclose", aclose)
    fa = FastAPI()
    with pytest.raises(RuntimeError):
        await main._bootstrap(fa, Config(database_url="d"))
    assert boot["pool"].closed
    assert getattr(fa.state, "deps", None) is None


async def test_failed_seed_after_clients_closes_clients_and_pool(boot, monkeypatch):
    closed = []

    async def aclose(self):
        closed.append(type(self).__name__)

    async def seed(self, experiments):
        raise RuntimeError("seed failed")

    monkeypatch.setenv("RUN_MIGRATIONS", "0")
    monkeypatch.setattr(main.ExperimentService, "seed", seed)
    for client in (main.OAuthClient, main.OpenAIClient, main.GoogleClient, main.StripeClient):
        monkeypatch.setattr(client, "aclose", aclose)
    with pytest.raises(RuntimeError):
        await main._bootstrap(FastAPI(), Config(database_url="d"))
    assert sorted(closed) == sorted(
        ["OAuthClient", "OpenAIClient", "OpenAIClient", "GoogleClient", "StripeClient"])
    assert boot["pool"].closed


async def test_ensure_ready_bootstraps_once(monkeypatch):
    calls = []

    async def bootstrap(a, cfg):
        calls.append(cfg)
        await asyncio.sleep(0)
        a.state.deps = object()

    loaded = Config(database_url="loaded")
    monkeypatch.setattr(main, "_bootstrap", bootstrap)
    monkeypatch.setattr(main, "load_config", lambda: loaded)
    fa = FastAPI()
    await asyncio.gather(main.ensure_ready(fa), main.ensure_ready(fa))
    assert calls == [loaded]
    await main.ensure_ready(fa)
    assert len(calls) == 1


@pytest.mark.parametrize("worker,shut", [("", 1), ("1", 1)])
def test_lifespan_and_healthz(monkeypatch, worker, shut):
    seen = {"ready": 0, "shut": 0}

    async def ready(a, cfg):
        seen["ready"] += 1

    async def shutdown(a):
        seen["shut"] += 1

    monkeypatch.setattr(main, "ensure_ready", ready)
    monkeypatch.setattr(main, "_shutdown", shutdown)
    monkeypatch.setenv("CF_WORKER", worker)
    monkeypatch.delenv("AI_SHARED_SECRET", raising=False)
    with TestClient(main.create_app(Config())) as c:
        for path in ("/healthz", "/api/v1/healthz"):
            r = c.get(path)
            assert r.status_code == 200 and r.json() == {"data": {"status": "ok"}}
            assert r.headers["x-request-id"].startswith("req_")
    assert seen == {"ready": 1, "shut": shut}
