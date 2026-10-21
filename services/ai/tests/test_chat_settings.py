from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from types import SimpleNamespace
from uuid import uuid4

from app.domain import entities as ent
from app.domain.chat_settings import (
    apply_chat_settings,
    insert_ai_done,
    load_chat_settings,
    resolve_chat_settings,
)
from app.graphs.chat import bind_chat_nodes
from app.graphs.chat_surface import surface_events

DOC = "11111111-1111-4111-8111-111111111111"
REV = "22222222-2222-4222-8222-222222222222"


def _diff_state(confirm: bool) -> dict:
    return {
        "diff": {
            "documentId": DOC,
            "revisionId": REV,
            "hunks": [{"line": 1, "sign": "+", "text": "shipped"}],
        },
        "confirm_before_edit": confirm,
    }


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


def test_confirm_false_omits_approval_and_true_keeps_it():
    skipped = [event["type"] for event in surface_events(_diff_state(False))]
    assert "diff" in skipped
    assert "approval" not in skipped
    kept = [event["type"] for event in surface_events(_diff_state(True))]
    assert "approval" in kept


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


def _conv(user_id):
    now = datetime.now(timezone.utc)
    return ent.Conversation(
        id=uuid4(), user_id=user_id, revision=1, title="chat",
        created_at=now, updated_at=now)


async def test_resolve_context_merges_settings_and_survives_a_query_failure():
    user_id = uuid4()
    conv = _conv(user_id)

    class Store:
        async def get(self, uid, cid):
            assert uid == user_id and cid == conv.id
            return conv

    class DB:
        def __init__(self, query):
            self.query = query

        def q(self):
            return self.query

    nodes = bind_chat_nodes(SimpleNamespace(
        db=DB(_Query(row={
            "default_effort": "HIGH",
            "confirm_before_edit": False,
        })),
        conversations=Store(),
    ))
    state = {
        "user_id": user_id,
        "conversation_id": conv.id,
        "text": "hi",
        "context": {},
        "ai": {"model": "kept"},
    }
    out = await nodes["resolve_context"](state)
    assert out["confirm_before_edit"] is False
    assert out["ai"]["effort"] == "HIGH"
    assert out["ai"]["model"] == "kept"

    broken = bind_chat_nodes(SimpleNamespace(
        db=DB(_Query(error=RuntimeError("undefined column"))),
        conversations=Store(),
    ))
    safe = await broken["resolve_context"]({
        **state,
        "ai": {"effort": "LOW"},
    })
    assert safe["confirm_before_edit"] is True
    assert "ai" not in safe or safe["ai"]["effort"] == "LOW"


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
    svc._compiled = _Graph(error)
    svc._byok_keys = {}
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
