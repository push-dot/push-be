"""Process entrypoints (infra/vps/compose.yaml) wired with fakes: no Redis, Postgres or network."""
from datetime import datetime, timezone
from types import SimpleNamespace
from uuid import UUID

import httpx
import pytest
import redis.asyncio

import app.db
import app.embedding.factory
import app.queue.worker
from app.infrastructure.store_chat_jobs import ChatJobStore, QueueJobs
from app.queue.streams import StreamQueue
from app.queue.worker import JobFailed
from app.workers import ai_worker_main, dispatcher_main, ingest_worker_main, notify_worker_main
from app.workers.handlers import chat as chat_mod

JOB = UUID("99999999-9999-4999-8999-999999999999")
NOW = datetime(2026, 5, 1, tzinfo=timezone.utc)


class FakeRedis:
    def __init__(self, url):
        self.url = url
        self.closed = False

    @classmethod
    def from_url(cls, url, decode_responses=False):
        assert decode_responses is True
        made = cls(url)
        Env.made["redis"] = made
        return made

    async def aclose(self):
        self.closed = True


class FakeClient:
    def __init__(self, timeout=None):
        self.timeout = timeout
        self.closed = False
        Env.made.setdefault("clients", []).append(self)

    async def aclose(self):
        self.closed = True


class FakePool:
    def __init__(self):
        self.closed = False

    async def close(self):
        self.closed = True


class FakeWorker:
    fail = None

    def __init__(self, queue, db, group, consumer, queues, handlers, concurrency, **kwargs):
        self.__dict__.update(queue=queue, db=db, group=group, consumer=consumer, queues=queues,
                             handlers=handlers, concurrency=concurrency, kwargs=kwargs, stopped=False)
        Env.made["worker"] = self

    async def run_forever(self):
        if FakeWorker.fail:
            raise FakeWorker.fail

    def stop(self):
        self.stopped = True


class Env:
    made: dict = {}


@pytest.fixture
def env(monkeypatch):
    Env.made = {}
    FakeWorker.fail = None
    pool = FakePool()

    async def create_pool(url):
        Env.made["db_url"] = url
        return pool

    monkeypatch.setattr(redis.asyncio, "Redis", FakeRedis)
    monkeypatch.setattr(dispatcher_main, "Redis", FakeRedis)
    monkeypatch.setattr(httpx, "AsyncClient", FakeClient)
    monkeypatch.setattr(app.db, "create_pool", create_pool)
    monkeypatch.setattr(app.queue.worker, "Worker", FakeWorker)
    monkeypatch.setenv("REDIS_URL", "redis://fake:6379/0")
    monkeypatch.setenv("DATABASE_URL", "postgresql://fake/db")
    for name in ("QUEUE_GROUP", "QUEUE_CONSUMER", "QUEUE_CONCURRENCY", "SERVE_API", "EXPO_ACCESS_TOKEN",
                 "DISPATCH_SECRET", "ADMIN_TOKEN", "DISCORD_ALERT_WEBHOOK_URL", "ALERT_EMAIL_TO"):
        monkeypatch.delenv(name, raising=False)
    Env.made["pool"] = pool
    return Env.made


def assert_closed(made):
    assert made["redis"].closed
    assert all(c.closed for c in made.get("clients", []))


# --- ingest worker -------------------------------------------------------------

async def test_ingest_worker_wires_queue_handler_and_long_lease(env, monkeypatch):
    embedders = []

    def get_embedder(client, redis_conn=None):
        embedders.append((client, redis_conn))
        return SimpleNamespace(model="BAAI/bge-m3")

    monkeypatch.setattr(app.embedding.factory, "get_embedder", get_embedder)
    await ingest_worker_main.main()
    w = env["worker"]
    assert env["db_url"] == "postgresql://fake/db"
    assert env["redis"].url == "redis://fake:6379/0"
    assert isinstance(w.queue, StreamQueue) and w.queue.redis is env["redis"]
    assert isinstance(w.db, QueueJobs) and isinstance(w.db.store, ChatJobStore)
    assert (w.group, w.consumer, w.queues, w.concurrency) == ("ingest", "ingest-worker", ["q:ingest"], 2)
    assert w.kwargs == {"min_idle_ms": 600_000}
    assert list(w.handlers) == ["ingest"]
    client = env["clients"][0]
    assert client.timeout == 120
    # Ingest vectors bypass the Redis cache so they cannot evict queue locks.
    assert embedders == [(client, None)]
    with pytest.raises(JobFailed) as err:
        await w.handlers["ingest"](SimpleNamespace(job={"user_id": str(JOB), "payload": {}}, heartbeat=None))
    assert err.value.error["code"] == "VALIDATION_ERROR"
    assert_closed(env)
    assert env["pool"].closed


async def test_ingest_worker_reads_overrides_and_cleans_up_on_crash(env, monkeypatch):
    monkeypatch.setattr(app.embedding.factory, "get_embedder", lambda c, r=None: SimpleNamespace(model="m"))
    monkeypatch.setenv("QUEUE_GROUP", "g")
    monkeypatch.setenv("QUEUE_CONSUMER", "c-1")
    monkeypatch.setenv("QUEUE_CONCURRENCY", "7")
    FakeWorker.fail = RuntimeError("redis gone")
    with pytest.raises(RuntimeError, match="redis gone"):
        await ingest_worker_main.main()
    w = env["worker"]
    assert (w.group, w.consumer, w.concurrency) == ("g", "c-1", 7)
    assert_closed(env)
    assert env["pool"].closed


# --- notify worker -------------------------------------------------------------

async def test_notify_worker_wires_queue_and_handler(env):
    await notify_worker_main.main()
    w = env["worker"]
    assert (w.group, w.consumer, w.queues, w.concurrency) == ("notify", "notify-worker", ["q:notify"], 4)
    assert w.kwargs == {}
    assert isinstance(w.db, QueueJobs)
    assert env["clients"][0].timeout == 10
    assert list(w.handlers) == ["notify"]
    assert_closed(env)
    assert env["pool"].closed


async def test_notify_worker_cleans_up_on_crash_and_honours_env(env, monkeypatch):
    monkeypatch.setenv("QUEUE_CONCURRENCY", "1")
    monkeypatch.setenv("EXPO_ACCESS_TOKEN", "  ")
    FakeWorker.fail = RuntimeError("stop")
    with pytest.raises(RuntimeError):
        await notify_worker_main.main()
    assert env["worker"].concurrency == 1
    assert_closed(env)
    assert env["pool"].closed


# --- dispatcher ----------------------------------------------------------------

class FakeDispatcher:
    fail = None

    def __init__(self, queue, open_db, secret, *, admin_token="", alerts=None):
        Env.made["dispatcher"] = SimpleNamespace(
            queue=queue, open_db=open_db, secret=secret, admin_token=admin_token, alerts=alerts)

    async def run_forever(self):
        if FakeDispatcher.fail:
            raise FakeDispatcher.fail


@pytest.fixture
def dispatcher_env(env, monkeypatch):
    FakeDispatcher.fail = None
    monkeypatch.setattr(dispatcher_main, "Dispatcher", FakeDispatcher)
    return env


async def test_dispatcher_defaults_to_empty_secrets_and_no_alerts(dispatcher_env):
    await dispatcher_main.main()
    d = dispatcher_env["dispatcher"]
    assert isinstance(d.queue, StreamQueue) and d.queue.redis is dispatcher_env["redis"]
    assert (d.secret, d.admin_token, d.alerts) == ("", "", None)
    assert d.open_db is dispatcher_main.open_db
    assert dispatcher_env["clients"][0].timeout == 10
    assert_closed(dispatcher_env)


async def test_dispatcher_passes_secrets_and_alerts_and_cleans_up_on_crash(dispatcher_env, monkeypatch):
    monkeypatch.setenv("DISPATCH_SECRET", "s3cret")
    monkeypatch.setenv("ADMIN_TOKEN", "adm")
    monkeypatch.setenv("DISCORD_ALERT_WEBHOOK_URL", "https://discord.invalid/hook")
    FakeDispatcher.fail = RuntimeError("down")
    with pytest.raises(RuntimeError):
        await dispatcher_main.main()
    d = dispatcher_env["dispatcher"]
    assert (d.secret, d.admin_token) == ("s3cret", "adm")
    assert d.alerts is not None and d.alerts.client is dispatcher_env["clients"][0]
    assert_closed(dispatcher_env)


async def test_open_db_connects_with_codecs_and_wraps_in_pg_jobs(monkeypatch):
    asyncpg = pytest.importorskip("asyncpg")
    conn = object()
    seen = []

    async def connect(url):
        seen.append(("connect", url))
        return conn

    async def init_conn(c):
        seen.append(("init", c))

    monkeypatch.setattr(asyncpg, "connect", connect)
    monkeypatch.setattr(app.db, "_init_conn", init_conn)
    monkeypatch.setenv("DATABASE_URL", "postgresql://fake/db")
    jobs = await dispatcher_main.open_db()
    assert isinstance(jobs, dispatcher_main.PgJobs) and jobs.conn is conn
    assert seen == [("connect", "postgresql://fake/db"), ("init", conn)]


# --- ai worker -----------------------------------------------------------------

class Jobs:
    def __init__(self, status="RUNNING", job=None):
        self.status = status
        self.job = job
        self.calls = []

    async def worker_status(self, job_id):
        self.calls.append(("status", job_id))
        return self.status

    async def worker_set_state(self, job_id, state):
        self.calls.append(("set_state", job_id, state))

    async def get(self, job_id):
        self.calls.append(("get", job_id))
        return self.job


class Svc:
    def __init__(self, job=None, status="RUNNING"):
        self.jobs = Jobs(status, job)


@pytest.fixture
def chat_globals(monkeypatch):
    monkeypatch.setattr(chat_mod, "_harness", chat_mod._harness)
    return chat_mod


async def configured(svc, monkeypatch, chat_globals):
    turns = []

    async def run_queue_turn(s, ctx, cancelled):
        turns.append((s, ctx, cancelled))
        return {"handled": True}

    import app.harness.jobs
    monkeypatch.setattr(app.harness.jobs, "run_queue_turn", run_queue_turn)
    await ai_worker_main.build_chat(svc)
    return turns


async def test_build_chat_wires_the_harness(monkeypatch, chat_globals):
    svc = Svc(status="CANCELLED")
    turns = await configured(svc, monkeypatch, chat_globals)
    ctx = SimpleNamespace(job={"id": JOB})
    assert await chat_mod._harness(ctx) == {"handled": True}
    (s, c, cancelled), = turns
    assert s is svc and c is ctx
    assert await cancelled(JOB) is True
    svc.jobs.status = "RUNNING"
    assert await cancelled(JOB) is False


async def test_serve_api_binds_port_and_stops_worker_even_if_server_crashes(monkeypatch):
    uvicorn = pytest.importorskip("uvicorn")
    configs = []

    class Server:
        def __init__(self, config):
            configs.append(config)

        async def serve(self):
            raise OSError("port in use")

    monkeypatch.setattr(uvicorn, "Server", Server)
    monkeypatch.delenv("PORT", raising=False)
    worker = FakeWorker(None, None, "", "", [], {}, 1)
    with pytest.raises(OSError):
        await ai_worker_main.serve_api(object(), worker)
    assert worker.stopped
    assert (configs[0].host, configs[0].port) == ("0.0.0.0", 8080)


@pytest.fixture
def ai_env(env, monkeypatch):
    import app.clock
    import app.main
    import app.queue.credits

    svc = Svc()
    pool = object()
    state = SimpleNamespace(deps=SimpleNamespace(conversations=svc, documents=object()),
                            db=SimpleNamespace(pool=pool, q=lambda: None))
    fake_app = SimpleNamespace(state=state)
    calls = []

    async def ensure_ready(a):
        calls.append(("ready", a))

    async def build_chat(s):
        calls.append(("build_chat", s))

    async def settle_job(p, job_id, now):
        calls.append(("settle", p, job_id, now))

    async def release_job(p, job_id, now):
        calls.append(("release", p, job_id, now))

    async def serve_api(a, worker):
        calls.append(("serve_api", a, worker))

    monkeypatch.setattr(app.main, "app", fake_app)
    monkeypatch.setattr(app.main, "ensure_ready", ensure_ready)
    monkeypatch.setattr(ai_worker_main, "build_chat", build_chat)
    monkeypatch.setattr(ai_worker_main, "serve_api", serve_api)
    monkeypatch.setattr(app.queue.credits, "settle_job", settle_job)
    monkeypatch.setattr(app.queue.credits, "release_job", release_job)
    monkeypatch.setattr(app.clock, "utcnow", lambda: NOW)
    env.update(app=fake_app, svc=svc, db_pool=pool, calls=calls)
    return env


async def test_ai_worker_boots_app_then_runs_chat_and_document_queues(ai_env):
    await ai_worker_main.main()
    w, calls = ai_env["worker"], ai_env["calls"]
    assert calls[:2] == [("ready", ai_env["app"]), ("build_chat", ai_env["svc"])]
    assert (w.group, w.consumer, w.concurrency) == ("ai", "ai-worker", 4)
    assert w.queues == ["q:chat:priority", "q:chat", "q:document"] == ai_worker_main.AI_WORKER_QUEUES
    assert set(w.handlers) == {"chat", "employer_ai", "document", "fit"}
    assert w.handlers["chat"] is w.handlers["employer_ai"] is chat_mod.chat
    assert isinstance(w.db, QueueJobs) and w.db.store is ai_env["svc"].jobs
    assert not any(c[0] == "serve_api" for c in calls)
    await w.kwargs["settle"](w.db, JOB)
    await w.kwargs["release"](w.db, JOB)
    assert calls[-2:] == [("settle", ai_env["db_pool"], JOB, NOW), ("release", ai_env["db_pool"], JOB, NOW)]
    assert ai_env["redis"].closed


async def test_ai_worker_serves_api_when_asked_and_closes_redis_on_crash(ai_env, monkeypatch):
    monkeypatch.setenv("SERVE_API", "1")
    monkeypatch.setenv("QUEUE_CONCURRENCY", "2")
    await ai_worker_main.main()
    w = ai_env["worker"]
    assert ("serve_api", ai_env["app"], w) in ai_env["calls"]
    assert w.concurrency == 2
    FakeWorker.fail = RuntimeError("boom")
    ai_env["redis"].closed = False
    with pytest.raises(RuntimeError):
        await ai_worker_main.main()
    assert ai_env["redis"].closed


async def test_stop_on_signals_routes_sigterm_to_graceful_stop():
    import asyncio
    import os
    import signal

    from app.workers.shutdown import stop_on_signals

    stopped = asyncio.Event()
    stop_on_signals(stopped.set)
    try:
        os.kill(os.getpid(), signal.SIGTERM)
        await asyncio.wait_for(stopped.wait(), 2)
    finally:
        loop = asyncio.get_running_loop()
        loop.remove_signal_handler(signal.SIGTERM)
        loop.remove_signal_handler(signal.SIGINT)
