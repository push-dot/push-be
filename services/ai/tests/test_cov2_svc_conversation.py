"""ConversationService paths that production reaches: the local chat worker
(start/stop/_worker_loop/_run_job) and the queue-worker step runner
(exec_chat_node). CRUD/post/stream methods have no live caller (see report).
"""
from __future__ import annotations

import asyncio
import json
from uuid import uuid4

import pytest

from app.claimctx import LostClaim, claim_job, claim_token
from app.domain.errors import feature_disabled
from app.domain.services import conversation as conv_mod
from app.domain.services.conversation import (
    ConversationService, _checkpoint_dict, _wait, flush_chat_events,
)
from app.graphs.chat import byok_key_var, event_sink
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

@pytest.mark.parametrize("raw,out", [
    ({"node": "persist"}, {"node": "persist"}),
    ('{"node": "persist", "fails": 2}', {"node": "persist", "fails": 2}),
    ("{broken", {}),
    ("[1, 2]", {}),
    ("", {}),
    (None, {}),
    (7, {}),
])
def test_checkpoint_dict_accepts_dict_or_json_object_only(raw, out):
    assert _checkpoint_dict(raw) == out


@pytest.mark.parametrize("ck,hit", [
    ({"fails": "x"}, False), ({"fails": None}, False), ({"fails": 2}, False),
    ({"fails": "3"}, True), (None, False),
])
def test_step_fail_limit_tolerates_garbage_counts(ck, hit):
    assert conv_mod.step_fail_limit_reached(ck) is hit


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


async def test_flush_chat_events_drops_unknown_chunks():
    sent = []

    async def emit_many(job_id, items):
        sent.extend(items)

    q: asyncio.Queue = asyncio.Queue()
    for item in ({"type": "noise"}, {"other": 1}, {"token": "a"}, None):
        q.put_nowait(item)
    await flush_chat_events(emit_many, "j", q)
    assert sent == [("token", {"text": "a"})]


async def test_ensure_chat_nodes_binds_once():
    svc = _svc(None)
    svc.ensure_chat_nodes()
    nodes = svc.chat_nodes
    assert {"resolve_context", "generate_reply", "persist"} <= set(nodes)
    svc.ensure_chat_nodes()
    assert svc.chat_nodes is nodes


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

    async def mine(job_id, byok="", claim=""):
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
    svc._compiled = graph
    svc._byok_keys[jobs.job_id] = "sk-user"
    return svc


async def test_run_job_success_streams_events_and_notifies(monkeypatch):
    monkeypatch.delenv("AI_HARNESS", raising=False)
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
    assert _ai_done(svc) and jobs.job_id not in svc._byok_keys
    state, config = graph.inputs[0]
    assert state["access_mode"] == "SUGGEST" and state["intent"] == "review"
    assert config["configurable"]["thread_id"] == str(j["conversation_id"])


async def test_run_job_cancelled_before_done_never_finishes():
    jobs = _RunJobs(status="CANCELLED")
    svc = _run_svc(jobs, _Graph([("values", {"operation": {"x": 1}})]))
    await svc._run_job(_job(jobs))
    assert jobs.events == [] and jobs.finished == [] and _ai_done(svc) == []
    assert jobs.job_id not in svc._byok_keys


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
    assert jobs.job_id not in svc._byok_keys


async def test_run_job_crash_requeues_with_backoff_and_keeps_the_key():
    jobs = _RunJobs()
    svc = _run_svc(jobs, _Graph(err=RuntimeError("flaky")))
    await svc._run_job(_job(jobs, attempt=2))
    assert jobs.delays == [4.0] and jobs.finished == [] and jobs.events == []
    assert svc._byok_keys[jobs.job_id] == "sk-user"
    assert byok_key_var.get() == ""


async def test_run_job_crash_on_last_attempt_fails_with_truncated_message():
    jobs = _RunJobs()
    svc = _run_svc(jobs, _Graph(err=RuntimeError("x" * 900)))
    await svc._run_job(_job(jobs, attempt=3))
    (ev,) = jobs.events
    assert ev["payload"]["error"] == {"code": "INTERNAL", "message": "x" * 500}
    assert jobs.finished == [("FAILED", "x" * 500)] and jobs.delays == []
    assert jobs.job_id not in svc._byok_keys


# ---- exec_chat_node --------------------------------------------------------

class _StepJobs:
    def __init__(self, status="RUNNING", checkpoint=None, touch=True, err=None):
        self.job = {"id": None, "status": status, "user_id": uuid4(),
                    "conversation_id": uuid4(),
                    "payload": {"text": "hi", "ai": None},
                    "checkpoint": checkpoint if checkpoint is not None else {}}
        self.touch = touch
        self.err = err or {}  # method name -> exception
        self.events, self.finished, self.deleted_after = [], [], []

    def _maybe(self, name):
        if name in self.err:
            raise self.err[name]

    async def touch_owner(self, jid, claim):
        self.claim_seen = (claim_token.get(), claim_job.get())
        return self.touch

    async def get(self, jid):
        return self.job

    async def delete_events_after(self, jid, hw):
        self._maybe("delete_events_after")
        self.deleted_after.append(hw)

    async def save_checkpoint(self, jid, ck):
        self.job["checkpoint"] = ck

    async def emit_many(self, jid, items):
        self._maybe("emit_many")
        self.events.extend(items)

    async def emit(self, jid, type_, payload):
        self._maybe("emit")
        self.events.append((type_, payload))

    async def finish(self, jid, status, error=None):
        self._maybe("finish")
        self.finished.append((status, error))
        self.job["status"] = status

    async def max_event_id(self, jid):
        return 40 + len(self.events)


def _step_svc(jobs, **nodes):
    svc = _svc(jobs)
    svc.ai = None
    svc.chat_nodes = nodes
    return svc


async def _never(state):  # a node that must not run
    raise AssertionError("node ran")


@pytest.mark.parametrize("status,result", [("DONE", "ok"),
                                           ("RUNNING", "skip")])
async def test_lost_claim_owner_check(status, result):
    jobs = _StepJobs(status=status, touch=False)
    svc = _step_svc(jobs, generate_reply=_never)
    jid = uuid4()
    assert await svc.exec_chat_node(str(jid), "generate_reply", "run-b") == \
        result
    assert jobs.claim_seen == ("run-b", str(jid))
    assert (claim_token.get(), claim_job.get()) == ("", "")


async def test_missing_job_is_skipped():
    jobs = _StepJobs()
    jobs.job = None
    assert await _step_svc(jobs).exec_chat_node(str(uuid4()), "persist") == \
        "skip"


@pytest.mark.parametrize("status,result", [("DONE", "ok"),
                                           ("FAILED", "error")])
async def test_terminal_jobs_do_not_rerun(status, result):
    jobs = _StepJobs(status=status)
    svc = _step_svc(jobs, persist=_never)
    assert await svc.exec_chat_node(str(uuid4()), "persist") == result
    assert jobs.finished == [] and jobs.events == []


async def test_completed_earlier_step_is_a_no_op():
    jobs = _StepJobs(checkpoint={"node": "generate_reply"})
    svc = _step_svc(jobs, resolve_context=_never)
    assert await svc.exec_chat_node(str(uuid4()), "resolve_context") == "ok"
    assert jobs.finished == [] and jobs.deleted_after == []


async def test_persist_replay_finishes_a_still_running_job():
    jobs = _StepJobs(checkpoint=json.dumps({"node": "persist"}))
    svc = _step_svc(jobs, persist=_never)
    assert await svc.exec_chat_node(str(uuid4()), "persist") == "ok"
    assert jobs.finished == [("DONE", None)] and len(_ai_done(svc)) == 1


async def test_persist_replay_that_lost_the_claim_skips():
    jobs = _StepJobs(checkpoint={"node": "persist"},
                     err={"finish": LostClaim()})
    svc = _step_svc(jobs, persist=_never)
    assert await svc.exec_chat_node(str(uuid4()), "persist") == "skip"
    assert _ai_done(svc) == []


async def test_step_retry_limit_fails_the_job():
    jobs = _StepJobs(checkpoint={"node": "resolve_context", "fails": 3})
    svc = _step_svc(jobs, generate_reply=_never)
    assert await svc.exec_chat_node(str(uuid4()), "generate_reply") == "error"
    (ev,) = jobs.events
    assert ev == ("error", {"error": {"code": "INTERNAL",
                                      "message": "step exceeded retry limit",
                                      "details": None}})
    assert jobs.finished == [("FAILED", "step exceeded retry limit")]


async def test_step_retry_limit_after_lost_claim_writes_nothing():
    jobs = _StepJobs(checkpoint={"fails": 5}, err={"emit": LostClaim()})
    svc = _step_svc(jobs, generate_reply=_never)
    assert await svc.exec_chat_node(str(uuid4()), "generate_reply") == "error"
    assert jobs.finished == []


async def test_lost_claim_while_resetting_events_skips_the_step():
    jobs = _StepJobs(err={"delete_events_after": LostClaim()})
    svc = _step_svc(jobs, generate_reply=_never)
    assert await svc.exec_chat_node(str(uuid4()), "generate_reply") == "skip"


async def test_step_runs_node_streams_events_and_checkpoints():
    jobs = _StepJobs(checkpoint={"node": "resolve_context", "event_id": 9,
                                 "fails": 1,
                                 "state": {"text": "from-ck", "n": 1}})
    seen = {}

    async def generate_reply(state):
        seen.update(state)
        sink = event_sink.get()
        sink.append({"status": "drafting"})
        sink.append({"token": "Hel"})
        sink.append({"token": "lo"})
        return {"n": 2, "reply": "Hello"}

    svc = _step_svc(jobs, generate_reply=generate_reply)
    assert await svc.exec_chat_node(str(uuid4()), "generate_reply") == "ok"
    assert seen["text"] == "from-ck"  # resumed from the checkpoint state
    assert jobs.deleted_after == [9]
    assert jobs.events == [("status", {"text": "drafting"}),
                           ("token", {"text": "Hel"}),
                           ("token", {"text": "lo"})]
    ck = jobs.job["checkpoint"]
    assert (ck["node"], ck["fails"], ck["event_id"]) == ("generate_reply", 0,
                                                          43)
    assert ck["state"]["reply"] == "Hello" and ck["state"]["n"] == 2
    assert jobs.finished == [] and event_sink.get() is None


async def test_first_step_builds_state_from_payload():
    jobs = _StepJobs()
    jobs.job["payload"] = {"text": "hello", "intent": "posting",
                           "access_mode": "AUTO"}
    seen = {}

    async def resolve_context(state):
        seen.update(state)

    svc = _step_svc(jobs, resolve_context=resolve_context)
    jid = uuid4()
    assert await svc.exec_chat_node(str(jid), "resolve_context") == "ok"
    assert (seen["text"], seen["access_mode"], seen["intent"],
            seen["job_id"]) == ("hello", "AUTO", "posting", str(jid))
    assert seen["user_id"] == jobs.job["user_id"]


async def test_lost_claim_inside_the_node_skips_without_checkpoint():
    jobs = _StepJobs()

    async def node(state):
        raise LostClaim()

    svc = _step_svc(jobs, generate_reply=node)
    assert await svc.exec_chat_node(str(uuid4()), "generate_reply") == "skip"
    assert jobs.job["checkpoint"] == {"fails": 1}
    assert jobs.finished == []


async def test_domain_error_fails_job_and_rolls_back_user_message():
    jobs = _StepJobs()

    async def node(state):
        raise feature_disabled("monthly limit")

    svc = _step_svc(jobs, generate_reply=node)
    jid = uuid4()
    assert await svc.exec_chat_node(str(jid), "generate_reply") == "error"
    assert svc.conversations.deleted == [user_message_id(jid)]
    assert jobs.events[-1][0] == "error"
    assert jobs.events[-1][1]["error"]["code"] == "FEATURE_DISABLED"
    assert jobs.finished == [("FAILED", "FEATURE_DISABLED")]


async def test_domain_error_after_lost_claim_skips_and_survives_rollback_error():
    jobs = _StepJobs(err={"emit": LostClaim()})

    async def node(state):
        raise feature_disabled("x")

    svc = _step_svc(jobs, generate_reply=node)
    svc.conversations = _Convs(err=RuntimeError("db"))
    assert await svc.exec_chat_node(str(uuid4()), "generate_reply") == "skip"
    assert jobs.finished == []


async def test_unexpected_error_propagates_and_keeps_the_fail_count():
    jobs = _StepJobs(checkpoint={"fails": 1})

    async def node(state):
        event_sink.get().append({"token": "partial"})
        raise RuntimeError("cpu limit")

    svc = _step_svc(jobs, generate_reply=node)
    with pytest.raises(RuntimeError):
        await svc.exec_chat_node(str(uuid4()), "generate_reply")
    assert jobs.job["checkpoint"] == {"fails": 2}
    assert jobs.events == [("token", {"text": "partial"})]
    assert jobs.finished == []


async def test_persist_emits_done_and_finishes():
    jobs = _StepJobs(checkpoint={"node": "generate_reply"})

    async def persist(state):
        return {"operation": {"id": "op-1", "status": "SUCCEEDED"}}

    svc = _step_svc(jobs, persist=persist)
    jid = uuid4()
    svc._byok_keys[jid] = "sk"
    assert await svc.exec_chat_node(str(jid), "persist") == "ok"
    assert jobs.events == [("done", {"operation": {"id": "op-1",
                                                   "status": "SUCCEEDED"}})]
    assert jobs.finished == [("DONE", None)] and len(_ai_done(svc)) == 1
    assert jid not in svc._byok_keys
    assert jobs.job["checkpoint"]["node"] == "persist"


async def test_persist_that_loses_the_claim_on_done_skips():
    jobs = _StepJobs(checkpoint={"node": "generate_reply"},
                     err={"emit": LostClaim()})

    async def persist(state):
        return {"operation": {"id": "op-1"}}

    svc = _step_svc(jobs, persist=persist)
    assert await svc.exec_chat_node(str(uuid4()), "persist") == "skip"
    assert jobs.finished == []


async def test_event_flush_that_loses_the_claim_still_completes_the_step():
    jobs = _StepJobs(err={"emit_many": LostClaim()})

    async def node(state):
        event_sink.get().append({"status": "x"})
        await asyncio.sleep(0)

    svc = _step_svc(jobs, generate_reply=node)
    assert await svc.exec_chat_node(str(uuid4()), "generate_reply") == "ok"
    assert jobs.events == []


async def test_setup_failure_cancels_the_pump_and_resets_context(monkeypatch):
    jobs = _StepJobs()
    svc = _step_svc(jobs)
    svc.chat_nodes = None

    def broken(_svc):
        raise RuntimeError("import failed")

    monkeypatch.setattr("app.graphs.chat.bind_chat_nodes", broken)
    with pytest.raises(RuntimeError, match="import failed"):
        await svc.exec_chat_node(str(uuid4()), "generate_reply")
    assert event_sink.get() is None and byok_key_var.get() == ""
    assert jobs.events == []


async def test_graph_uses_one_harness_runtime_when_enabled(monkeypatch):
    from app.harness.runtime import HarnessRuntime
    monkeypatch.setenv("AI_HARNESS", "1")
    svc = _svc(None)
    runtime = svc.graph
    assert isinstance(runtime, HarnessRuntime) and svc.graph is runtime
    assert svc._compiled is None
