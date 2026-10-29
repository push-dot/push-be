from pathlib import Path

import pytest

from app.jobs import get_job_scheduler, queue_backend, schedule_chat_job, set_job_scheduler


@pytest.mark.asyncio
async def test_redis_backend_does_not_schedule_workflow(monkeypatch):
    monkeypatch.setenv("QUEUE_BACKEND", "redis")
    seen = []

    async def sched(*args):
        seen.append(args)

    prev = get_job_scheduler()
    set_job_scheduler(sched)
    try:
        await schedule_chat_job("job-1")
        assert queue_backend() == "redis"
        assert seen == []
    finally:
        set_job_scheduler(prev)


@pytest.mark.asyncio
async def test_postgres_backend_still_schedules_workflow(monkeypatch):
    monkeypatch.delenv("QUEUE_BACKEND", raising=False)
    seen = []

    async def sched(*args):
        seen.append(args)

    prev = get_job_scheduler()
    set_job_scheduler(sched)
    try:
        await schedule_chat_job("job-1")
        assert seen
        assert seen[0][0] == "job-1"
    finally:
        set_job_scheduler(prev)


def test_python_wrangler_config_is_gone():
    assert not Path(__file__).resolve().parents[1].joinpath("wrangler.jsonc").exists()


def test_postgres_chat_poller_is_off_when_redis_runs_chat(monkeypatch):
    from app.jobs import runs_local_chat_worker
    monkeypatch.delenv("CHAT_EXECUTOR", raising=False)
    monkeypatch.setenv("QUEUE_BACKEND", "redis")
    assert runs_local_chat_worker() is False
    monkeypatch.setenv("QUEUE_BACKEND", "postgres")
    assert runs_local_chat_worker() is True
    monkeypatch.setenv("CHAT_EXECUTOR", "workflow")
    assert runs_local_chat_worker() is True
    monkeypatch.setenv("CHAT_EXECUTOR", "external")
    assert runs_local_chat_worker() is False


@pytest.mark.asyncio
async def test_api_server_exit_stops_the_worker(monkeypatch):
    uvicorn = pytest.importorskip("uvicorn")  # local extra; CI installs the Workers set

    from app.workers.ai_worker_main import serve_api

    class Server:
        def __init__(self, config):
            self.config = config

        async def serve(self):
            return None

    class Worker:
        stopped = False

        def stop(self):
            Worker.stopped = True

    monkeypatch.setattr(uvicorn, "Server", Server)
    monkeypatch.setenv("PORT", "8099")
    await serve_api(object(), Worker())
    assert Worker.stopped is True
