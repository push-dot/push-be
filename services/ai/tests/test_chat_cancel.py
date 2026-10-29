from __future__ import annotations

from uuid import uuid4

from app.domain.services.conversation import ConversationService
from app.infrastructure.store_chat_jobs import ChatJobStore
from tests.stubs import FakeDB, StubChatJobStore


class _Conn:
    def __init__(self, status: str):
        self.status = status
        self.calls = []

    async def execute(self, sql, *args):
        self.calls.append((sql, args))
        if "NOT IN" in sql:
            clause = sql.split("NOT IN", 1)[1].split(")", 1)[0]
            if self.status in clause:
                return "UPDATE 0"
            self.status = args[1]
            return "UPDATE 1"
        if "status <> 'CANCELLED'" in sql and self.status == "CANCELLED":
            return "UPDATE 0"
        return "UPDATE 1"


class _DB:
    def __init__(self, conn):
        self.pool = conn

    def q(self):
        return self.pool

    async def do(self, fn):
        return await fn()


class _Chunks:
    def __init__(self, chunks):
        self.chunks = chunks

    async def astream(self, _state, config=None, stream_mode=None):
        for chunk in self.chunks:
            yield chunk


async def test_finish_does_not_overwrite_cancelled():
    conn = _Conn("CANCELLED")
    store = ChatJobStore(_DB(conn))
    await store.finish(uuid4(), "DONE")
    sql = conn.calls[0][0]
    clause = sql.split("NOT IN", 1)[1].split(")", 1)[0]
    assert "CANCELLED" in clause
    assert conn.status == "CANCELLED"


async def test_requeue_does_not_revive_cancelled():
    conn = _Conn("CANCELLED")
    store = ChatJobStore(_DB(conn))
    await store.requeue(uuid4(), 2.0)
    sql = conn.calls[0][0]
    assert "status <> 'CANCELLED'" in sql
    assert conn.status == "CANCELLED"
    assert not any("DELETE FROM chat_events" in item[0] for item in conn.calls)


async def test_run_stops_when_status_becomes_cancelled():
    svc = ConversationService(FakeDB(), None, None)
    jobs = StubChatJobStore()

    async def emit(job_id, type_, payload):
        await StubChatJobStore.emit(jobs, job_id, type_, payload)
        jobs._status = "CANCELLED"

    jobs.emit = emit
    svc.jobs = jobs
    svc._harness_runtime = _Chunks([
        ("custom", {"token": "hi"}),
        ("custom", {"type": "tool", "name": "read", "state": "ok", "summary": "file"}),
        ("values", {"operation": {"status": "SUCCEEDED"}}),
    ])
    await svc._run_job({
        "id": jobs.job_id,
        "user_id": uuid4(),
        "conversation_id": uuid4(),
        "attempt": 1,
        "payload": {"text": "hi", "context": {}, "access_mode": "SUGGEST"},
    })
    assert [event["type"] for event in jobs.events] == ["token"]
    assert jobs.finished == []
