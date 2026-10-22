from __future__ import annotations

from uuid import UUID

import httpx
import pytest
from fakeredis.aioredis import FakeRedis

from app.harness.core_client import CoreClient
from app.harness.jobs import run_queue_turn
from app.harness.runtime import HarnessRuntime
from app.workers.ai_worker_main import AI_WORKER_QUEUES
from app.workers.handlers.chat import chat, configure_chat, configure_harness
from tests.harness_fakes import CONV, USER, Rows, ScriptedLC, managed_ai, service
from tests.test_queue_worker import MemoryJobs, queued, worker

POSTING = "11111111-1111-4111-8111-111111111111"
MESSAGE_JOB = UUID("a1000000-0000-4000-8000-000000000001")
RESUME_JOB = UUID("b2000000-0000-4000-8000-000000000002")


def _job(job_id: UUID, payload: dict) -> dict:
    job = queued(job_id, conversation_id=CONV, user_id=USER)
    job["payload"] = {"ai": managed_ai(), "access_mode": "AUTO", "context": {}, **payload}
    return job


async def _deliver(box, db, job: dict) -> str:
    db.jobs[job["id"]] = job
    await box.queue.add("q:chat", job["id"])
    msg = (await box.queue.read("ai", "worker-a", ["q:chat"], 1, 0))[0]
    return await box.process(msg)


@pytest.mark.asyncio
async def test_harness_turn_on_the_redis_worker_runs_an_approved_tool_once(monkeypatch):
    monkeypatch.setenv("AI_HARNESS", "1")
    monkeypatch.setenv("QUEUE_BACKEND", "redis")
    ScriptedLC.replies = [
        {"tool_calls": [{"name": "apply_to_posting", "id": "call-1", "type": "tool_call",
                         "args": {"posting_id": POSTING}}]},
        {"content": "지원했어요"},
    ]
    applies = []

    def core(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/apply"):
            applies.append(request.headers["idempotency-key"])
        return httpx.Response(200, json={"data": {"ok": True}})

    svc = service(Rows())
    runtime = HarnessRuntime(svc, model_cls=ScriptedLC)
    runtime._core = CoreClient("http://core.test", "secret", httpx.MockTransport(core))
    svc.graph = runtime
    svc._byok_from_payload = lambda _user, _payload: ""
    db = MemoryJobs()

    async def cancelled(job_id):
        return False

    async def legacy_node(ctx, name):
        raise AssertionError("legacy chat nodes must not run with AI_HARNESS on")

    async def set_state(job_id, state):
        return None

    configure_chat(run_node=legacy_node, cancelled=cancelled, set_state=set_state)
    configure_harness(lambda ctx: run_queue_turn(svc, ctx, cancelled))
    try:
        await _flow(svc, db, applies)
    finally:
        configure_harness(None)


async def _flow(svc, db, applies):
    box = worker(FakeRedis(decode_responses=True), db, {"chat": chat}, queues=list(AI_WORKER_QUEUES))

    assert await _deliver(box, db, _job(MESSAGE_JOB, {"text": "이 공고에 지원해줘"})) == "done"
    kinds = [kind for kind, _ in db.events[MESSAGE_JOB]]
    assert "approval" in kinds
    assert db.events[MESSAGE_JOB][-1] == ("done", {"awaiting": "approval"})
    approval_id = next(payload["id"] for kind, payload in db.events[MESSAGE_JOB] if kind == "approval")
    assert applies == []

    resume = _job(RESUME_JOB, {"text": "", "resume": {"approvalId": approval_id, "optionId": "approve"}})
    assert await _deliver(box, db, resume) == "done"
    done = db.events[RESUME_JOB][-1]
    assert done[0] == "done"
    assert done[1]["operation"]["result"]["value"]["assistantMessage"]["text"] == "지원했어요"

    resume["status"] = "QUEUED"
    assert await _deliver(box, db, resume) == "done"
    assert len(applies) == 1
    assert svc.ai.reserved == [str(MESSAGE_JOB), str(RESUME_JOB)]
    assert len(svc.ai.settled) == 2


@pytest.mark.asyncio
async def test_legacy_edit_answer_on_the_redis_worker_applies_without_chat_nodes(monkeypatch):
    from types import SimpleNamespace

    from tests.test_legacy_edit_approval import APPROVAL, DIFF, _Docs, _Rows

    monkeypatch.delenv("AI_HARNESS", raising=False)
    docs = _Docs()
    monkeypatch.setattr("app.harness.jobs.apply_edit", lambda core, user, diff: docs.apply_hunks(user, diff))
    svc = SimpleNamespace(db=_Rows(), document_svc=SimpleNamespace(), _byok_from_payload=lambda _u, _p: "")
    db = MemoryJobs()

    async def cancelled(job_id):
        return False

    async def legacy_node(ctx, name):
        raise AssertionError("an approved legacy edit must not run chat nodes")

    async def set_state(job_id, state):
        return None

    configure_chat(run_node=legacy_node, cancelled=cancelled, set_state=set_state)
    configure_harness(lambda ctx: run_queue_turn(svc, ctx, cancelled))
    try:
        box = worker(FakeRedis(decode_responses=True), db, {"chat": chat}, queues=list(AI_WORKER_QUEUES))
        job = queued(RESUME_JOB, conversation_id=CONV, user_id=USER)
        job["payload"] = {"text": "", "resume": {"approvalId": APPROVAL, "optionId": "apply"}}
        assert await _deliver(box, db, job) == "done"
    finally:
        configure_harness(None)
    assert docs.applied == [DIFF]
    assert [kind for kind, _ in db.events[RESUME_JOB]] == ["diff", "done"]
