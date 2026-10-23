"""Cloudflare cron must not claim chat_jobs while the VPS worker does."""

import pytest

from app.domain.services.conversation import ConversationService
from app.jobs import remote_executor, set_job_scheduler


def test_remote_executor_flag(monkeypatch):
    monkeypatch.delenv("CHAT_EXECUTOR_REMOTE", raising=False)
    monkeypatch.delenv("AI_ORIGIN", raising=False)
    assert remote_executor() is False
    monkeypatch.setenv("CHAT_EXECUTOR_REMOTE", "0")
    assert remote_executor() is False
    monkeypatch.setenv("CHAT_EXECUTOR_REMOTE", "true")
    assert remote_executor() is True
    monkeypatch.setenv("CHAT_EXECUTOR_REMOTE", "")
    monkeypatch.setenv("AI_ORIGIN", "  ")
    assert remote_executor() is False
    monkeypatch.setenv("AI_ORIGIN", "https://ai.example.test")
    assert remote_executor() is True


def _service():
    calls = []

    class Jobs:
        async def reset_stale(self):
            calls.append("reset")
            return 0

        async def pending_ids(self, limit):
            calls.append(("pending", limit))
            return ["job-1"]

    svc = ConversationService.__new__(ConversationService)
    svc.jobs = Jobs()
    return svc, calls


@pytest.mark.asyncio
async def test_nudge_schedules_on_the_cloudflare_path(monkeypatch):
    monkeypatch.delenv("CHAT_EXECUTOR_REMOTE", raising=False)
    monkeypatch.delenv("AI_ORIGIN", raising=False)
    svc, calls = _service()
    scheduled = []

    async def sched(job_id, claim=""):
        scheduled.append(job_id)

    set_job_scheduler(sched)
    try:
        assert await svc.nudge_pending() == 1
    finally:
        set_job_scheduler(None)
    assert calls[0] == "reset"
    assert scheduled == ["job-1"]


@pytest.mark.asyncio
async def test_nudge_is_noop_when_the_vps_owns_chat(monkeypatch):
    monkeypatch.setenv("CHAT_EXECUTOR_REMOTE", "1")
    svc, calls = _service()
    scheduled = []

    async def sched(job_id, claim=""):
        scheduled.append(job_id)

    set_job_scheduler(sched)
    try:
        assert await svc.nudge_pending() == 0
        monkeypatch.delenv("CHAT_EXECUTOR_REMOTE", raising=False)
        monkeypatch.setenv("AI_ORIGIN", "https://ai.example.test")
        assert await svc.nudge_pending() == 0
    finally:
        set_job_scheduler(None)
    assert calls == []
    assert scheduled == []
