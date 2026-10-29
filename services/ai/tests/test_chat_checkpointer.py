from __future__ import annotations

from contextlib import AsyncExitStack
from uuid import uuid4

import pytest
from langgraph.checkpoint.memory import MemorySaver

import app.db as db
import app.main as main
import app.workers.handlers.chat as handlers
from app.config import Config
from app.domain.errors import DomainError
from app.graphs.chat import _emit, build_chat_graph
from app.queue.worker import JobContext
from app.workers.ai_worker_main import build_chat


class _Killed(BaseException):
    pass


class _Jobs:
    def __init__(self) -> None:
        self.rows: list[dict] = []
        self.next_id = 1

    async def emit_many(self, job_id, batch) -> None:
        for kind, payload in batch:
            self.rows.append({
                "id": self.next_id, "kind": kind, "payload": dict(payload)})
            self.next_id += 1

    async def delete_events_after(self, job_id, event_id: int) -> None:
        keep = int(event_id)
        self.rows = [row for row in self.rows if row["id"] <= keep]

    async def max_event_id(self, job_id) -> int:
        if not self.rows:
            return 0
        return self.rows[-1]["id"]

    async def worker_status(self, job_id) -> str:
        return "RUNNING"

    async def worker_set_state(self, job_id, state) -> None:
        return None


async def _emit_nothing(kind, payload) -> None:
    return None


def _tokens(jobs: _Jobs) -> list[str]:
    return [row["payload"]["text"] for row in jobs.rows if row["kind"] == "token"]


async def _worker(monkeypatch, generate):
    calls: list[str] = []
    jobs = _Jobs()

    async def resolve_context(state):
        calls.append("context")
        _emit({"status": "맥락"})
        return {}

    async def generate_reply(state):
        calls.append("reply")
        await generate()
        return {"completion": {"text": "안녕"}}

    async def persist(state):
        calls.append("persist")
        return {"messageId": "m-1", "operation": {"id": "op"}}

    def bind(svc):
        nodes = {
            "resolve_context": resolve_context,
            "prepare_reply": resolve_context,
            "generate_reply": generate_reply,
            "persist": persist,
        }
        svc.chat_nodes = nodes
        return nodes

    monkeypatch.setattr("app.graphs.chat.bind_chat_nodes", bind)
    monkeypatch.delenv("AI_HARNESS", raising=False)
    monkeypatch.setattr(handlers, "_saved_turn", None, raising=False)
    svc = type("Svc", (), {"jobs": jobs, "node_calls": []})()

    async def exec_chat_node(job_id, name, claim):
        svc.node_calls.append(name)
        raise AssertionError("node loop")

    svc.exec_chat_node = exec_chat_node
    svc.graph = build_chat_graph(svc, MemorySaver())
    await build_chat(svc)
    job_id = uuid4()
    ctx = JobContext(
        {
            "id": job_id,
            "user_id": uuid4(),
            "conversation_id": uuid4(),
            "payload": {"text": "안녕"},
        },
        lambda: None,
        _emit_nothing,
    )
    return calls, jobs, svc, ctx


async def test_external_jobs_keeps_a_checkpointer(monkeypatch):
    monkeypatch.setenv("CHAT_EXECUTOR", "external")
    monkeypatch.setenv("CHECKPOINTER", "memory")
    saver = await main._chat_checkpointer(
        Config(database_url="postgres://db"), AsyncExitStack())
    assert saver is not None


async def test_external_jobs_opens_the_postgres_saver(monkeypatch):
    opened: list[str] = []

    class Pool:
        async def close(self) -> None:
            opened.append("closed")

    async def open_saver(url):
        opened.append(url)
        return "saver", Pool()

    monkeypatch.setenv("CHAT_EXECUTOR", "external")
    monkeypatch.delenv("CHECKPOINTER", raising=False)
    monkeypatch.setattr(db, "open_chat_checkpointer", open_saver)
    stack = AsyncExitStack()
    saver = await main._chat_checkpointer(Config(database_url="postgres://db"), stack)
    assert saver == "saver"
    assert opened == ["postgres://db"]
    await stack.aclose()
    assert "closed" in opened


async def test_killed_mid_reply_resumes_without_rerunning_context(monkeypatch):
    attempts = {"n": 0}

    async def generate():
        attempts["n"] += 1
        _emit({"token": "안"})
        if attempts["n"] == 1:
            raise _Killed()
        _emit({"token": "녕"})

    calls, jobs, svc, ctx = await _worker(monkeypatch, generate)
    with pytest.raises(_Killed):
        await handlers.chat(ctx)
    await handlers.chat(ctx)
    assert calls.count("context") == 1
    assert calls.count("reply") == 2
    assert svc.node_calls == []
    assert _tokens(jobs) == ["안", "녕"]


async def test_retry_policy_reruns_reply_without_rerunning_context(monkeypatch):
    attempts = {"n": 0}

    async def generate():
        attempts["n"] += 1
        _emit({"token": str(attempts["n"])})
        if attempts["n"] < 3:
            raise ConnectionError("down")

    calls, jobs, _svc, ctx = await _worker(monkeypatch, generate)
    await handlers.chat(ctx)
    assert calls.count("context") == 1
    assert calls.count("reply") == 3
    assert _tokens(jobs) == ["3"]


async def test_domain_error_is_not_retried(monkeypatch):
    attempts = {"n": 0}

    async def generate():
        attempts["n"] += 1
        raise DomainError(400, "FEATURE_DISABLED", "no")

    calls, _jobs, _svc, ctx = await _worker(monkeypatch, generate)
    with pytest.raises(DomainError):
        await handlers.chat(ctx)
    assert attempts["n"] == 1
    assert calls.count("context") == 1
    assert calls.count("reply") == 1
