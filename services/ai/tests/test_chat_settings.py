from __future__ import annotations

import asyncio
from uuid import uuid4

from app.domain.chat_settings import (
    apply_chat_settings,
    insert_ai_done,
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


async def test_insert_ai_done_records_sql_title_and_target():
    query = _Query()
    user_id = uuid4()
    conversation_id = uuid4()
    await insert_ai_done(query, user_id, conversation_id)
    sql, args = query.calls[0]
    assert "INSERT INTO notifications" in sql
    assert "AI_DONE" in sql
    assert "AI 작업이 끝났어요" in args
    assert "" in args
    blob = next(arg for arg in args if isinstance(arg, str) and "conversation" in arg)
    assert blob == (
        '{"kind":"conversation","id":"' + str(conversation_id) + '"}'
    )
    assert user_id in args


async def test_insert_ai_done_swallows_execute_error(caplog):
    query = _Query(error=RuntimeError("notifications missing"))
    with caplog.at_level("ERROR"):
        await insert_ai_done(query, uuid4(), uuid4())
    assert any(record.exc_info for record in caplog.records)


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
    def __init__(self, error=None):
        self.error = error

    async def astream(self, state, config=None, stream_mode=None):
        if self.error is not None:
            raise self.error
        yield ("values", {"operation": {"status": "SUCCEEDED"}})


def _job_svc(error=None):
    from app.domain.services.conversation import ConversationService

    svc = ConversationService.__new__(ConversationService)
    svc.db = _DB()
    svc.jobs = _Jobs()
    svc._harness_runtime = _Graph(error)
    svc._sem = asyncio.Semaphore(1)
    return svc


async def test_run_job_inserts_ai_done_only_after_done():
    user_id = uuid4()
    conversation_id = uuid4()
    svc = _job_svc()
    await svc._run_job({
        "id": uuid4(),
        "user_id": user_id,
        "conversation_id": conversation_id,
        "attempt": 1,
        "payload": {"text": "hi"},
    })
    assert svc.jobs.finished == ["DONE"]
    sql, args = svc.db.query.calls[0]
    assert "AI_DONE" in sql
    assert "AI 작업이 끝났어요" in args
    assert '{"kind":"conversation","id":"' + str(conversation_id) + '"}' in args

    failed = _job_svc(RuntimeError("model down"))
    await failed._run_job({
        "id": uuid4(),
        "user_id": user_id,
        "conversation_id": conversation_id,
        "attempt": 1,
        "payload": {"text": "hi"},
    })
    assert failed.jobs.finished == ["REQUEUE"]
    assert failed.db.query.calls == []
