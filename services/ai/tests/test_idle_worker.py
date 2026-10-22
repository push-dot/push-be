"""Idle chat worker backs off, wakes, and sweeps stale jobs rarely."""

import asyncio

import pytest

from app.domain.services.conversation import (
    IDLE_MAX_S,
    IDLE_MIN_S,
    STALE_SWEEP_S,
    ConversationService,
    _wait,
    next_idle_delay,
)
from app.jobs import get_job_scheduler, schedule_chat_job, set_job_scheduler


def test_idle_delay_doubles_until_the_cap():
    delay = IDLE_MIN_S
    seen = []
    for _ in range(8):
        seen.append(delay)
        delay = next_idle_delay(delay, reset=False)
    assert seen[0] == 1.0
    assert seen == [1.0, 2.0, 4.0, 8.0, 16.0, 32.0, 60.0, 60.0]
    assert delay == IDLE_MAX_S
    assert next_idle_delay(60.0, reset=True) == IDLE_MIN_S


@pytest.mark.asyncio
async def test_wait_returns_immediately_when_woken():
    event = asyncio.Event()
    event.set()
    started = asyncio.get_running_loop().time()
    woke = await _wait(event, 30)
    elapsed = asyncio.get_running_loop().time() - started
    assert woke is True
    assert elapsed < 1
    assert event.is_set() is False


def _service(jobs):
    svc = ConversationService.__new__(ConversationService)
    svc.jobs = jobs
    svc._inflight = set()
    svc._wake = asyncio.Event()
    return svc


@pytest.mark.asyncio
async def test_idle_loop_claims_only_on_the_backoff_schedule(monkeypatch):
    waits = []
    claims = []

    class Jobs:
        async def claim(self):
            claims.append(1)
            return None

        async def reset_stale(self, max_age_s=None):
            raise AssertionError("stale sweep ran during backoff")

    async def fake_wait(event, delay):
        waits.append(delay)
        if len(waits) >= 8:
            raise asyncio.CancelledError()
        return False

    monkeypatch.setattr(
        "app.domain.services.conversation._wait", fake_wait)
    monkeypatch.setattr(
        "app.domain.services.conversation.STALE_SWEEP_S", 10**9)
    svc = _service(Jobs())
    with pytest.raises(asyncio.CancelledError):
        await svc._worker_loop()
    assert waits == [1.0, 2.0, 4.0, 8.0, 16.0, 32.0, 60.0, 60.0]
    assert len(claims) == len(waits)


@pytest.mark.asyncio
async def test_wake_claims_again_at_the_minimum_delay(monkeypatch):
    waits = []
    claims = []

    class Jobs:
        async def claim(self):
            claims.append(len(claims) + 1)
            return None

        async def reset_stale(self, max_age_s=None):
            raise AssertionError("stale sweep ran")

    async def fake_wait(event, delay):
        waits.append(delay)
        if len(waits) == 1:
            return True
        if len(waits) >= 3:
            raise asyncio.CancelledError()
        return False

    monkeypatch.setattr(
        "app.domain.services.conversation._wait", fake_wait)
    monkeypatch.setattr(
        "app.domain.services.conversation.STALE_SWEEP_S", 10**9)
    svc = _service(Jobs())
    with pytest.raises(asyncio.CancelledError):
        await svc._worker_loop()
    assert waits == [1.0, 1.0, 2.0]
    assert claims == [1, 2, 3]


@pytest.mark.asyncio
async def test_stale_sweep_runs_at_the_interval_not_every_claim(monkeypatch):
    clock = {"t": 0.0}
    sweeps = []

    class Jobs:
        async def claim(self):
            return None

        async def reset_stale(self, max_age_s=None):
            sweeps.append(max_age_s)
            return 0

    async def fake_wait(event, delay):
        clock["t"] += delay
        if clock["t"] > 200:
            raise asyncio.CancelledError()
        return False

    monkeypatch.setattr(
        "app.domain.services.conversation._wait", fake_wait)
    monkeypatch.setattr(
        "app.domain.services.conversation._loop_time", lambda: clock["t"])
    monkeypatch.setattr(
        "app.domain.services.conversation.STALE_SWEEP_S", 100)
    svc = _service(Jobs())
    with pytest.raises(asyncio.CancelledError):
        await svc._worker_loop()
    assert sweeps == [None]
    assert STALE_SWEEP_S >= 15 * 60


@pytest.mark.asyncio
async def test_schedule_sets_the_wake_event():
    class Jobs:
        async def reset_stale(self, max_age_s=None):
            return 0

        async def claim(self):
            await asyncio.sleep(30)

    svc = _service(Jobs())
    previous = get_job_scheduler()
    await svc.start_worker()
    try:
        await schedule_chat_job("job-1", "")
        assert svc._wake.is_set() is True
    finally:
        await svc.stop_worker()
    assert get_job_scheduler() is previous
    set_job_scheduler(previous)


@pytest.mark.asyncio
async def test_stale_sweep_also_expires_old_approval_cards(monkeypatch):
    executed = []

    class Jobs:
        async def claim(self):
            raise asyncio.CancelledError()

        async def reset_stale(self, max_age_s=None):
            return 0

    class Conn:
        async def execute(self, sql, *args):
            executed.append(sql)
            return "UPDATE 0"

    class Db:
        def q(self):
            return Conn()

    monkeypatch.setattr("app.domain.services.conversation.STALE_SWEEP_S", 0)
    svc = _service(Jobs())
    svc.db = Db()
    with pytest.raises(asyncio.CancelledError):
        await svc._worker_loop()
    assert any("SET status = 'EXPIRED'" in sql for sql in executed)
