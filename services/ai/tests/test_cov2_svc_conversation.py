"""ConversationService paths that production reaches: the local chat worker
(start/stop/_worker_loop/_run_job).
"""
from __future__ import annotations

import asyncio
from uuid import uuid4

import pytest

from app.domain.errors import feature_disabled
from app.domain.services import conversation as conv_mod
from app.domain.services.conversation import ConversationService, _wait
from app.infrastructure.store_chat_jobs import user_message_id
from app.jobs import get_job_scheduler, set_job_scheduler
from tests.stubs import StubChatJobStore, StubConversationStore

# ---- shared fakes ---------------------------------------------------------

class _Conn:
    def __init__(self):
        self.sql = []

    async def execute(self, sql, *args):
        self.sql.append((sql, args))
        return "INSERT 0 1"


class _DB:
    def __init__(self):
        self.conn = _Conn()

    def q(self):
        return self.conn

    async def run(self, fn):
        return await fn()


def _ai_done(svc):
    return [a for s, a in svc.db.conn.sql if "AI_DONE" in s]


class _Convs(StubConversationStore):
    def __init__(self, err=None):
        super().__init__()
        self.deleted, self.err = [], err

    async def delete_unlinked_user_message(self, message_id):
        if self.err:
            raise self.err
        self.deleted.append(message_id)


def _svc(jobs) -> ConversationService:
    svc = ConversationService(_DB(), None, None)
    svc.jobs = jobs
    svc.conversations = _Convs()
    return svc


# ---- small helpers --------------------------------------------------------

async def test_notify_failure_never_fails_the_job():
    class DB:
        def q(self):
            raise RuntimeError("pool closed")

    svc = _svc(None)
    svc.db = DB()
    await svc._notify_ai_done(uuid4(), uuid4())


async def test_wait_times_out_without_a_wake():
    event = asyncio.Event()
    assert await _wait(event, 0.01) is False


# ---- local worker lifecycle ----------------------------------------------

async def test_start_worker_requeues_stale_jobs_then_stops_cleanly():
    class Jobs:
        async def reset_stale(self, max_age_s=None):
            return 3

        async def claim(self):
            await asyncio.sleep(30)

    svc = _svc(Jobs())
    previous = get_job_scheduler()
    await svc.start_worker()
    assert get_job_scheduler() is not previous
    await svc.stop_worker()
    assert get_job_scheduler() is previous and svc._worker_task is None


async def test_start_worker_failure_restores_the_previous_scheduler():
    class Jobs:
        async def reset_stale(self, max_age_s=None):
            raise RuntimeError("db down")

    async def mine(job_id, claim=""):
        return None

    previous = get_job_scheduler()
    set_job_scheduler(mine)
    try:
        svc = _svc(Jobs())
        with pytest.raises(RuntimeError):
            await svc.start_worker()
        assert get_job_scheduler() is mine
        assert svc._scheduler_installed is False
        await svc.stop_worker()  # nothing to undo
        assert get_job_scheduler() is mine
    finally:
        set_job_scheduler(previous)


async def test_stop_worker_waits_for_inflight_jobs():
    svc = _svc(None)
    done = []

    async def job():
        await asyncio.sleep(0.01)
        done.append(1)

    t = asyncio.create_task(job())
    svc._inflight.add(t)
    await svc.stop_worker()
    assert done == [1]


async def test_worker_loop_survives_failing_sweeps(monkeypatch):
    calls = []

    class Jobs:
        async def reset_stale(self, max_age_s=None):
            calls.append("reset")
            raise RuntimeError("db")

        async def claim(self):
            calls.append("claim")
            raise asyncio.CancelledError()

    class DB:
        def q(self):
            calls.append("expire")
            raise RuntimeError("db")

    monkeypatch.setattr(conv_mod, "STALE_SWEEP_S", 0)
    svc = _svc(Jobs())
    svc.db = DB()
    with pytest.raises(asyncio.CancelledError):
        await svc._worker_loop()
    assert calls == ["reset", "expire", "claim"]


async def test_worker_loop_backs_off_on_claim_errors_and_resets_after_work(
        monkeypatch):
    job = {"id": uuid4()}
    claims = [RuntimeError("claim"), job, None, asyncio.CancelledError()]
    waits, ran = [], []

    class Jobs:
        async def claim(self):
            r = claims.pop(0)
            if isinstance(r, BaseException):
                raise r
            return r

    async def fake_wait(event, delay):
        waits.append(delay)
        return False

    monkeypatch.setattr(conv_mod, "_wait", fake_wait)
    monkeypatch.setattr(conv_mod, "STALE_SWEEP_S", 10**9)
    svc = _svc(Jobs())

    async def run_job(j):
        ran.append(j)

    svc._run_job = run_job
    with pytest.raises(asyncio.CancelledError):
        await svc._worker_loop()
    await asyncio.gather(*svc._inflight)
    assert ran == [job]
    assert waits == [1.0, 1.0]  # error backed off; a claimed job reset it


# ---- _run_job --------------------------------------------------------------

class _Graph:
    def __init__(self, chunks=(), err=None):
        self.chunks, self.err = list(chunks), err
        self.inputs = []

    async def astream(self, state, config=None, stream_mode=None):
        self.inputs.append((state, config))
        for c in self.chunks:
            yield c
        if self.err is not None:
            raise self.err


class _RunJobs(StubChatJobStore):
    def __init__(self, status="RUNNING", flip_on_emit=False):
        super().__init__(status=status)
        self.flip = flip_on_emit
        self.delays = []

    async def emit(self, job_id, type_, payload):
        await super().emit(job_id, type_, payload)
        if self.flip:
            self._status = "CANCELLED"

    async def requeue(self, job_id, delay_s):
        self.delays.append(delay_s)


def _job(jobs, attempt=1, **payload):
    return {"id": jobs.job_id, "user_id": uuid4(), "conversation_id": uuid4(),
            "attempt": attempt,
            "payload": {"text": "hi", **payload}}


def _run_svc(jobs, graph):
    svc = _svc(jobs)
    svc._harness_runtime = graph
    return svc


async def test_run_job_success_streams_events_and_notifies():
    jobs = _RunJobs()
    graph = _Graph([
        ("custom", {"status": "thinking"}),
        ("custom", {"token": "Hi"}),
        ("custom", {"type": "tool", "name": "read"}),
        ("custom", {"type": "unknown"}),
        ("values", {"operation": None}),
        ("values", {"operation": {"status": "SUCCEEDED"}}),
    ])
    svc = _run_svc(jobs, graph)
    j = _job(jobs, intent="review")
    await svc._run_job(j)
    assert [e["type"] for e in jobs.events] == ["status", "token", "tool",
                                                "done"]
    assert jobs.events[-1]["payload"] == {"operation": {"status": "SUCCEEDED"}}
    assert jobs.finished == [("DONE", None)]
    assert _ai_done(svc)
    state, config = graph.inputs[0]
    assert state["access_mode"] == "SUGGEST" and state["intent"] == "review"
    assert config["configurable"]["thread_id"] == str(j["conversation_id"])


async def test_run_job_cancelled_before_done_never_finishes():
    jobs = _RunJobs(status="CANCELLED")
    svc = _run_svc(jobs, _Graph([("values", {"operation": {"x": 1}})]))
    await svc._run_job(_job(jobs))
    assert jobs.events == [] and jobs.finished == [] and _ai_done(svc) == []


async def test_run_job_cancelled_after_last_chunk_keeps_cancelled():
    jobs = _RunJobs(flip_on_emit=True)
    svc = _run_svc(jobs, _Graph([("custom", {"token": "x"})]))
    await svc._run_job(_job(jobs))
    assert [e["type"] for e in jobs.events] == ["token"]
    assert jobs.finished == [] and _ai_done(svc) == []


async def test_run_job_domain_error_fails_and_drops_the_user_message():
    jobs = _RunJobs()
    svc = _run_svc(jobs, _Graph(err=feature_disabled("limit reached")))
    await svc._run_job(_job(jobs))
    assert svc.conversations.deleted == [user_message_id(jobs.job_id)]
    (ev,) = jobs.events
    assert ev["type"] == "error"
    assert ev["payload"]["error"]["code"] == "FEATURE_DISABLED"
    assert jobs.finished == [("FAILED", "FEATURE_DISABLED")]


async def test_run_job_crash_requeues_with_backoff():
    jobs = _RunJobs()
    svc = _run_svc(jobs, _Graph(err=RuntimeError("flaky")))
    await svc._run_job(_job(jobs, attempt=2))
    assert jobs.delays == [4.0] and jobs.finished == [] and jobs.events == []


async def test_run_job_crash_on_last_attempt_fails_without_leaking_the_cause():
    jobs = _RunJobs()
    svc = _run_svc(jobs, _Graph(err=RuntimeError("x" * 900)))
    await svc._run_job(_job(jobs, attempt=3))
    (ev,) = jobs.events
    # The client sees a generic error; the job row keeps the truncated cause.
    assert ev["payload"]["error"] == {"code": "INTERNAL", "message": "internal error"}
    assert jobs.finished == [("FAILED", "x" * 500)] and jobs.delays == []


async def test_worker_loop_claims_only_when_a_run_slot_is_free(monkeypatch):
    monkeypatch.setattr(conv_mod, "STALE_SWEEP_S", 10**9)
    release = asyncio.Event()
    claims = []

    class Jobs:
        async def claim(self):
            claims.append(1)
            if len(claims) > 50:
                raise asyncio.CancelledError()  # old loop: claims without bound
            await asyncio.sleep(0)
            return {"id": uuid4()}

    svc = _svc(Jobs())
    svc._sem = asyncio.Semaphore(1)

    async def run_job(j):
        await release.wait()

    svc._run_job = run_job
    loop = asyncio.create_task(svc._worker_loop())
    await asyncio.sleep(0.05)
    assert claims == [1]  # the second claim waits for the busy slot
    assert not loop.done()
    release.set()
    await asyncio.sleep(0.01)
    loop.cancel()
    with pytest.raises(asyncio.CancelledError):
        await loop
    assert len(claims) >= 2
    await asyncio.gather(*svc._inflight)


async def test_graph_uses_one_harness_runtime():
    from app.harness.runtime import HarnessRuntime
    svc = _svc(None)
    runtime = svc.graph
    assert isinstance(runtime, HarnessRuntime) and svc.graph is runtime
    assert getattr(svc, "_compiled", None) is None
