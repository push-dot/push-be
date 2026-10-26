from __future__ import annotations

import json
from datetime import datetime, timezone
from types import SimpleNamespace
from uuid import NAMESPACE_URL, UUID, uuid4, uuid5

from app.domain import entities as ent
from app.domain.services.conversation import ConversationService
from app.graphs.chat import bind_chat_nodes, event_sink
from app.graphs.chat_surface import insert_chat_approval, surface_events
from tests.stubs import FakeDB, StubConversationStore
from tests.test_conversation import _svc

DOC = "11111111-1111-4111-8111-111111111111"
REV = "22222222-2222-4222-8222-222222222222"
USER_ID = UUID("00000000-0000-4000-8000-0000000000aa")
CONV_ID = UUID("00000000-0000-4000-8000-0000000000bb")
OPTIONS = [
    {"id": "apply", "label": "적용"},
    {"id": "skip", "label": "그대로 두기"},
]


def _rich() -> dict:
    return {
        "text": "edit the resume",
        "tool_name": "edit",
        "tool_state": "run",
        "tool_summary": "editing resume",
        "todos": [{"id": "t1", "text": "update summary", "state": "now"}],
        "diff": {
            "documentId": DOC,
            "revisionId": REV,
            "hunks": [{"line": 3, "sign": "+", "text": "shipped"}],
        },
        "confirm_before_edit": True,
        "fit": {
            "score": 7.4,
            "parts": {"techStack": 80, "experienceLink": 55, "keyword": 40},
            "topGap": "no tests",
        },
        "choice": {
            "id": "choice-1",
            "options": [{"id": "a", "label": "Keep"}, {"id": "b", "label": "Drop"}],
        },
    }


def test_plain_chat_has_no_structured_events():
    assert surface_events({"text": "hello"}) == []


def test_rich_state_returns_tool_todo_diff_approval_fit_and_choice():
    events = surface_events(_rich())
    assert [event["type"] for event in events] == [
        "tool", "todo", "diff", "approval", "fit", "choice"]
    assert events[0] == {
        "type": "tool", "name": "edit", "state": "run", "summary": "editing resume"}
    assert events[1] == {
        "type": "todo",
        "items": [{"id": "t1", "text": "update summary", "state": "now"}]}
    assert events[2] == {
        "type": "diff", "documentId": DOC, "revisionId": REV,
        "hunks": [{"line": 3, "sign": "+", "text": "shipped"}]}
    approval = events[3]
    assert approval["kind"] == "DOCUMENT_EDIT"
    assert approval["title"] == "이 수정을 적용할까요?"
    assert approval["options"] == OPTIONS
    UUID(approval["id"])
    assert events[4] == {
        "type": "fit", "score": 7.4, "topGap": "no tests",
        "parts": {"techStack": 80, "experienceLink": 55, "keyword": 40}}
    assert events[5] == {
        "type": "choice", "id": "choice-1",
        "options": [{"id": "a", "label": "Keep"}, {"id": "b", "label": "Drop"}]}
    assert surface_events(_rich()) == events


def test_missing_confirm_flag_still_asks_and_false_does_not():
    absent = _rich()
    del absent["confirm_before_edit"]
    assert "approval" in [event["type"] for event in surface_events(absent)]
    skipped = _rich()
    skipped["confirm_before_edit"] = False
    types = [event["type"] for event in surface_events(skipped)]
    assert "diff" in types
    assert "approval" not in types


def test_posting_read_is_a_tool_event():
    assert surface_events({"posting_read": {
        "name": "posting", "state": "ok", "summary": "job page",
    }}) == [{"type": "tool", "name": "posting", "state": "ok", "summary": "job page"}]


def test_approval_needs_a_diff():
    assert surface_events({"confirm_before_edit": True, "text": "hi"}) == []


class _Graph:
    def __init__(self, chunks):
        self.chunks = chunks

    async def astream(self, _state, config=None, stream_mode=None):
        for chunk in self.chunks:
            yield chunk


async def test_run_job_writes_a_tool_event_and_keeps_token_and_status():
    from tests.stubs import StubChatJobStore

    svc = ConversationService(FakeDB(), None, None)
    jobs = StubChatJobStore()
    svc.jobs = jobs
    svc._compiled = _Graph([
        ("custom", {"type": "tool", "name": "read", "state": "ok", "summary": "file"}),
        ("custom", {"token": "hi"}),
        ("custom", {"status": "working"}),
        ("custom", {"type": "future", "note": "no"}),
        ("values", {"operation": {"status": "SUCCEEDED"}}),
    ])
    job_id = uuid4()
    await svc._run_job({
        "id": job_id,
        "user_id": uuid4(),
        "conversation_id": uuid4(),
        "attempt": 1,
        "payload": {"text": "hi", "context": {}, "access_mode": "SUGGEST"},
    })
    assert jobs.events == [
        {"id": 1, "type": "tool", "payload": {"name": "read", "state": "ok", "summary": "file"}},
        {"id": 2, "type": "token", "payload": {"text": "hi"}},
        {"id": 3, "type": "status", "payload": {"text": "working"}},
        {"id": 4, "type": "done", "payload": {"operation": {"status": "SUCCEEDED"}}},
    ]


def _conv(user_id):
    return ent.Conversation(
        id=uuid4(), user_id=user_id, revision=1, title="kept",
        created_at=datetime.now(timezone.utc), updated_at=datetime.now(timezone.utc))


class _Rec:
    def __init__(self):
        self.calls = []

    def q(self):
        return self

    async def execute(self, sql, *args):
        self.calls.append((sql, args))

    async def run(self, fn):
        return await fn()


def _options_from(args) -> list | None:
    for arg in args:
        blob = arg
        if isinstance(blob, str):
            try:
                blob = json.loads(blob)
            except json.JSONDecodeError:
                continue
        if blob == OPTIONS:
            return blob
    return None


async def test_prepare_emits_tool_todo_and_choice_and_a_plain_turn_emits_nothing():
    user_id = uuid4()
    svc = _svc(StubConversationStore())
    nodes = bind_chat_nodes(svc)
    token = event_sink.set([])
    try:
        await nodes["prepare_reply"]({
            "user_id": user_id,
            "text": "hello",
            "conversation": _conv(user_id),
            "context": {},
            "attachments": [],
            "tool_name": "edit",
            "tool_state": "wait",
            "tool_summary": "needs a file",
            "todos": [{"id": "t1", "text": "draft", "state": "todo"}],
            "choice": {"id": "c1", "options": [{"id": "a", "label": "A"}]},
        })
        structured = list(event_sink.get())
        event_sink.get().clear()
        await nodes["prepare_reply"]({
            "user_id": user_id,
            "text": "hello",
            "conversation": _conv(user_id),
            "context": {},
            "attachments": [],
        })
        plain = list(event_sink.get())
    finally:
        event_sink.reset(token)
    assert structured == [
        {"type": "tool", "name": "edit", "state": "wait", "summary": "needs a file"},
        {"type": "todo", "items": [{"id": "t1", "text": "draft", "state": "todo"}]},
        {"type": "choice", "id": "c1", "options": [{"id": "a", "label": "A"}]},
    ]
    assert plain == []


def _approval_id(job_id) -> str:
    return str(uuid5(NAMESPACE_URL, "push:chat-approval:" + str(job_id)))


def test_approval_id_uses_the_job_id():
    job_id = uuid4()
    state = _rich()
    state["job_id"] = job_id
    approval = next(
        event for event in surface_events(state) if event["type"] == "approval")
    assert approval["id"] == _approval_id(job_id)
    again = next(
        event for event in surface_events(state) if event["type"] == "approval")
    assert again["id"] == approval["id"]


class _Duplicate:
    def __init__(self):
        self.calls = []
        self.seen = set()

    def q(self):
        return self

    async def execute(self, sql, *args):
        self.calls.append((sql, args))
        if "ON CONFLICT (id) DO NOTHING" not in sql and args[0] in self.seen:
            raise RuntimeError("duplicate key")
        self.seen.add(args[0])


async def test_insert_chat_approval_same_job_does_not_raise():
    job_id = uuid4()
    event = {
        "id": _approval_id(job_id),
        "kind": "DOCUMENT_EDIT",
        "title": "이 수정을 적용할까요?",
        "options": OPTIONS,
    }
    db = _Duplicate()
    await insert_chat_approval(db, USER_ID, CONV_ID, event, DOC)
    await insert_chat_approval(db, USER_ID, CONV_ID, event, DOC)
    assert len(db.calls) == 2
    assert "ON CONFLICT (id) DO NOTHING" in db.calls[0][0]
    assert db.calls[0][1][0] == UUID(event["id"])
    assert db.calls[1][1][0] == UUID(event["id"])


class _Order:
    def __init__(self):
        self.calls = []

    def q(self):
        return self

    async def execute(self, sql, *args):
        self.calls.append((sql, args))
        sink = event_sink.get()
        if sink is not None:
            sink.append({"type": "db"})

    async def run(self, fn):
        return await fn()


async def test_persist_inserts_before_the_approval_event():
    user_id = uuid4()
    job_id = uuid4()
    conv = _conv(user_id)
    svc = _svc(StubConversationStore(conv=conv))
    db = _Order()
    svc.db = db
    nodes = bind_chat_nodes(svc)
    token = event_sink.set([])
    try:
        await nodes["persist"]({
            "user_id": user_id,
            "job_id": job_id,
            "text": "edit",
            "attachments": [],
            "conversation": conv,
            "diff": {
                "documentId": DOC,
                "revisionId": REV,
                "hunks": [{"line": 2, "sign": "-", "text": "old"}],
            },
            "fit": {
                "score": 7.4,
                "parts": {"techStack": 80, "experienceLink": 55, "keyword": 40},
                "topGap": "no tests",
            },
        })
        sink = list(event_sink.get())
    finally:
        event_sink.reset(token)
    types = [event["type"] for event in sink]
    assert types.index("db") < types.index("approval")
    assert types.index("diff") < types.index("db")
    assert types.index("fit") < types.index("db")
    approval = next(event for event in sink if event["type"] == "approval")
    assert approval["id"] == _approval_id(job_id)
    assert UUID(approval["id"]) in db.calls[0][1]


async def test_publish_skips_approval_when_nothing_is_inserted():
    from app.graphs.chat_surface import publish_persisted_surface

    emitted = []
    db = _Rec()
    blocked = await publish_persisted_surface(
        {"diff": {
            "documentId": DOC,
            "revisionId": REV,
            "hunks": [{"line": 1, "sign": "+", "text": "new"}],
        }},
        db, emitted.append, None)
    assert blocked is True
    assert db.calls == []
    assert [event["type"] for event in emitted] == ["diff"]


async def test_persist_inserts_approval_and_skips_the_diff_when_confirm_is_absent(monkeypatch):
    user_id = uuid4()
    conv = _conv(user_id)
    store = StubConversationStore(conv=conv)
    svc = _svc(store)
    db = _Rec()
    svc.db = db
    applied = []

    async def apply_hunks(user, diff):
        applied.append(diff)

    svc.document_svc = SimpleNamespace()
    monkeypatch.setattr("app.harness.document_edits.apply_edit", lambda core, user, diff: apply_hunks(user, diff))
    nodes = bind_chat_nodes(svc)
    state = {
        "user_id": user_id,
        "text": "edit",
        "attachments": [],
        "conversation": conv,
        "diff": {
            "documentId": DOC,
            "revisionId": REV,
            "hunks": [{"line": 2, "sign": "-", "text": "old"}],
        },
        "fit": {
            "score": 7.4,
            "parts": {"techStack": 80, "experienceLink": 55, "keyword": 40},
            "topGap": "no tests",
        },
    }
    token = event_sink.set([])
    try:
        await nodes["persist"](state)
        sink = list(event_sink.get())
    finally:
        event_sink.reset(token)
    assert [event["type"] for event in sink] == ["diff", "fit", "approval"]
    assert applied == []
    assert len(db.calls) == 2
    assert "SET tool_args" in db.calls[1][0]
    assert json.loads(db.calls[1][1][1])["hunks"] == [{"line": 2, "sign": "-", "text": "old"}]
    sql, args = db.calls[0]
    assert "conversation_id" in sql
    assert "PENDING" in sql
    assert conv.id in args
    assert _options_from(args) == OPTIONS
    approval = next(event for event in sink if event["type"] == "approval")
    assert approval["id"] in args or UUID(approval["id"]) in args


async def test_persist_applies_the_diff_when_confirm_is_false(monkeypatch):
    user_id = uuid4()
    conv = _conv(user_id)
    svc = _svc(StubConversationStore(conv=conv))
    db = _Rec()
    svc.db = db
    applied = []

    async def apply_hunks(user, diff):
        applied.append(diff)

    svc.document_svc = SimpleNamespace()
    monkeypatch.setattr("app.harness.document_edits.apply_edit", lambda core, user, diff: apply_hunks(user, diff))
    nodes = bind_chat_nodes(svc)
    diff = {
        "documentId": DOC,
        "revisionId": REV,
        "hunks": [{"line": 2, "sign": "-", "text": "old"}],
    }
    token = event_sink.set([])
    try:
        await nodes["persist"]({
            "user_id": user_id,
            "text": "edit",
            "attachments": [],
            "conversation": conv,
            "confirm_before_edit": False,
            "diff": diff,
        })
        sink = list(event_sink.get())
    finally:
        event_sink.reset(token)
    assert [event["type"] for event in sink] == ["diff"]
    assert db.calls == []
    assert applied == [{
        "type": "diff", "documentId": DOC, "revisionId": REV,
        "hunks": [{"line": 2, "sign": "-", "text": "old"}],
    }]


async def test_persist_survives_a_conflicting_auto_edit(monkeypatch):
    from app.domain.errors import revision_conflict
    user_id = uuid4()
    conv = _conv(user_id)
    svc = _svc(StubConversationStore(conv=conv))
    svc.db = _Rec()

    async def apply_hunks(user, diff):
        raise revision_conflict(2)

    svc.document_svc = SimpleNamespace()
    monkeypatch.setattr("app.harness.document_edits.apply_edit", lambda core, user, diff: apply_hunks(user, diff))
    nodes = bind_chat_nodes(svc)
    token = event_sink.set([])
    try:
        await nodes["persist"]({
            "user_id": user_id, "text": "edit", "attachments": [], "conversation": conv,
            "confirm_before_edit": False,
            "diff": {"documentId": DOC, "revisionId": REV,
                     "hunks": [{"line": 2, "sign": "-", "text": "old"}]},
        })
    finally:
        event_sink.reset(token)


