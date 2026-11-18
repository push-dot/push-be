from __future__ import annotations

import asyncio
from uuid import uuid4

from app.domain.chat_settings import (
    apply_chat_settings,
    load_chat_settings,
    resolve_chat_settings,
)



def test_none_and_empty_row_resolve_to_medium_and_true():
    expect = {"effort": "MEDIUM", "confirm_before_edit": True}
    assert resolve_chat_settings(None) == expect
    assert resolve_chat_settings({}) == expect


def test_high_and_false_are_kept():
    assert resolve_chat_settings({
        "default_effort": "HIGH",
        "confirm_before_edit": False,
    }) == {"effort": "HIGH", "confirm_before_edit": False}


def test_invalid_effort_falls_back_to_medium():
    assert resolve_chat_settings({
        "default_effort": "TURBO",
        "confirm_before_edit": True,
    }) == {"effort": "MEDIUM", "confirm_before_edit": True}
    assert resolve_chat_settings({
        "default_effort": "  ",
        "confirm_before_edit": False,
    }) == {"effort": "MEDIUM", "confirm_before_edit": False}


def test_client_effort_beats_stored():
    state = {"ai": {"effort": "LOW", "model": "kept"}}
    merged = {**state, **apply_chat_settings(state, {
        "default_effort": "MAX",
        "confirm_before_edit": False,
    })}
    assert merged["ai"] == {"effort": "LOW", "model": "kept"}
    assert merged["confirm_before_edit"] is False


def test_omitted_client_effort_uses_stored():
    state = {"ai": {"model": "kept"}}
    merged = {**state, **apply_chat_settings(state, {
        "default_effort": "HIGH",
    })}
    assert merged["ai"]["effort"] == "HIGH"
    assert merged["ai"]["model"] == "kept"
    assert merged["confirm_before_edit"] is True


def test_blank_client_effort_uses_stored():
    state = {"ai": {"effort": "  "}}
    merged = {**state, **apply_chat_settings(state, {
        "default_effort": "MAX",
    })}
    assert merged["ai"]["effort"] == "MAX"


def test_missing_ai_does_not_invent_ai():
    out = apply_chat_settings({}, {"default_effort": "MAX"})
    assert "ai" not in out
    assert out["confirm_before_edit"] is True


class _Query:
    def __init__(self, row=None, error=None):
        self.row = row
        self.error = error
        self.calls = []

    async def fetchrow(self, sql, *args):
        self.calls.append((sql, args))
        if self.error is not None:
            raise self.error
        return self.row

    async def execute(self, sql, *args):
        self.calls.append((sql, args))
        if self.error is not None:
            raise self.error


async def test_load_returns_defaults_when_query_fails_or_row_is_missing():
    user_id = uuid4()
    broken = _Query(error=RuntimeError("undefined column"))
    assert await load_chat_settings(broken, user_id) == {
        "default_effort": "MEDIUM",
        "confirm_before_edit": True,
    }
    assert "default_effort" in broken.calls[0][0]
    assert "confirm_before_edit" in broken.calls[0][0]
    empty = _Query(row=None)
    assert await load_chat_settings(empty, user_id) == {
        "default_effort": "MEDIUM",
        "confirm_before_edit": True,
    }


class _Core:
    def __init__(self):
        self.calls = []

    async def call(self, method, path, *, user_id, json=None, **kwargs):
        self.calls.append((method, path, user_id, json))
        return {"id": None}


class _Jobs:
    def __init__(self):
        self.finished = []

    async def status(self, job_id):
        return "RUNNING"

    async def emit(self, job_id, type_, payload):
        return None

    async def finish(self, job_id, status, error=None):
        self.finished.append(status)

    async def requeue(self, job_id, delay):
        self.finished.append("REQUEUE")


class _DB:
    def __init__(self):
        self.query = _Query()

    def q(self):
        return self.query


class _Graph:
    def __init__(self, error=None, chunks=None):
        self.error = error
        self.chunks = chunks

    async def astream(self, state, config=None, stream_mode=None):
        if self.error is not None:
            raise self.error
        chunks = self.chunks
        if chunks is None:
            chunks = [("values", {"operation": {"status": "SUCCEEDED"}})]
        for chunk in chunks:
            yield chunk


def _job_svc(error=None, chunks=None):
    from app.domain.services.conversation import ConversationService

    svc = ConversationService.__new__(ConversationService)
    svc.db = _DB()
    svc.jobs = _Jobs()
    svc._harness_runtime = _Graph(error, chunks)
    svc._sem = asyncio.Semaphore(1)
    svc.core = _Core()
    return svc


def _chat_job(user_id, conversation_id):
    return {
        "id": uuid4(),
        "type": "chat",
        "user_id": user_id,
        "conversation_id": conversation_id,
        "attempt": 1,
        "payload": {"text": "hi"},
    }


async def test_run_job_notifies_only_after_an_operation():
    user_id = uuid4()
    conversation_id = uuid4()
    job = _chat_job(user_id, conversation_id)
    svc = _job_svc()
    await svc._run_job(job)
    assert svc.jobs.finished == ["DONE"]
    assert svc.core.calls == [(
        "POST",
        "/api/v1/internal/notifications/ai-done",
        str(user_id),
        {"userId": str(user_id), "conversationId": str(conversation_id), "jobId": str(job["id"])},
    )]
    assert svc.db.query.calls == []

    card = _job_svc(chunks=[("values", {})])
    await card._run_job(_chat_job(user_id, conversation_id))
    assert card.jobs.finished == ["DONE"]
    assert card.core.calls == []

    failed = _job_svc(RuntimeError("model down"))
    await failed._run_job(_chat_job(user_id, conversation_id))
    assert failed.jobs.finished == ["REQUEUE"]
    assert failed.core.calls == []
