from __future__ import annotations

import json
from datetime import datetime, timezone
from uuid import UUID, uuid4

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.errors import domain_error_handler
from app.api.routers.conversations import _sse_frames, router
from app.domain import entities as ent
from app.domain.errors import DomainError
from app.domain.services.conversation import ConversationService
from app.graphs.chat import bind_chat_nodes, event_sink
from app.graphs.chat_surface import surface_events
from tests.stubs import FakeDB, StubConversationStore
from tests.test_conversation import _svc

DOC = "11111111-1111-4111-8111-111111111111"
REV = "22222222-2222-4222-8222-222222222222"
USER_ID = UUID("00000000-0000-4000-8000-0000000000aa")
CONV_ID = UUID("00000000-0000-4000-8000-0000000000bb")
APPR_ID = UUID("00000000-0000-4000-8000-0000000000cc")
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


async def test_persist_inserts_approval_and_skips_the_diff_when_confirm_is_absent():
    user_id = uuid4()
    conv = _conv(user_id)
    store = StubConversationStore(conv=conv)
    svc = _svc(store)
    db = _Rec()
    svc.db = db
    applied = []

    async def apply_hunks(diff):
        applied.append(diff)

    svc.documents.apply_hunks = apply_hunks
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
    assert [event["type"] for event in sink] == ["diff", "approval", "fit"]
    assert applied == []
    assert len(db.calls) == 1
    sql, args = db.calls[0]
    assert "conversation_id" in sql
    assert "PENDING" in sql
    assert conv.id in args
    assert _options_from(args) == OPTIONS
    assert sink[1]["id"] in args or UUID(sink[1]["id"]) in args


async def test_persist_applies_the_diff_when_confirm_is_false():
    user_id = uuid4()
    conv = _conv(user_id)
    svc = _svc(StubConversationStore(conv=conv))
    db = _Rec()
    svc.db = db
    applied = []

    async def apply_hunks(diff):
        applied.append(diff)

    svc.documents.apply_hunks = apply_hunks
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


class _AsUser:
    def __init__(self, app, user):
        self.app = app
        self.user = user

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            scope.setdefault("state", {})["user"] = self.user
        await self.app(scope, receive, send)


class _Rows:
    def __init__(self, row, tag="UPDATE 1"):
        self.row = row
        self.calls = []
        self.tag = tag

    def q(self):
        return self

    async def fetchrow(self, sql, *args):
        self.calls.append((sql, args))
        if self.row is None:
            return None
        if CONV_ID not in args or USER_ID not in args:
            return None
        return dict(self.row)

    async def execute(self, sql, *args):
        self.calls.append((sql, args))
        return self.tag


def _client(db: _Rows) -> TestClient:
    app = FastAPI()
    app.add_exception_handler(DomainError, domain_error_handler)
    app.include_router(router, prefix="/api/v1")
    app.add_middleware(_AsUser, user=ent.User(
        id=USER_ID, display_name="Ada",
        created_at=datetime.now(timezone.utc)))
    app.state.db = db
    return TestClient(app)


def _pending():
    return {"id": APPR_ID, "status": "PENDING", "options": OPTIONS}


def test_resolve_approval_returns_the_choice():
    db = _Rows(_pending())
    res = _client(db).post(
        f"/api/v1/conversations/{CONV_ID}/approvals/{APPR_ID}",
        json={"optionId": "apply"},
        headers={"Authorization": "Bearer test"})
    assert res.status_code == 200
    assert res.json()["data"] == {
        "id": str(APPR_ID), "status": "APPROVED", "optionId": "apply"}
    updates = [call for call in db.calls if call[0].lstrip().upper().startswith("UPDATE")]
    assert len(updates) == 1
    assert "apply" in updates[0][1]
    assert "APPROVED" in updates[0][0]


def test_resolve_unknown_option_is_validation_error():
    db = _Rows(_pending())
    res = _client(db).post(
        f"/api/v1/conversations/{CONV_ID}/approvals/{APPR_ID}",
        json={"optionId": "nope"})
    assert res.status_code == 400
    assert res.json()["error"]["code"] == "VALIDATION_ERROR"
    assert not any(call[0].lstrip().upper().startswith("UPDATE") for call in db.calls)


def test_resolve_missing_approval_is_404():
    res = _client(_Rows(None)).post(
        f"/api/v1/conversations/{CONV_ID}/approvals/{APPR_ID}",
        json={"optionId": "apply"})
    assert res.status_code == 404
    assert res.json()["error"]["code"] == "NOT_FOUND"


def test_resolve_second_decide_is_conflict():
    row = _pending()
    row["status"] = "APPROVED"
    res = _client(_Rows(row)).post(
        f"/api/v1/conversations/{CONV_ID}/approvals/{APPR_ID}",
        json={"optionId": "apply"})
    assert res.status_code == 409
    assert res.json()["error"]["code"] == "CONFLICT"


def test_resolve_update_match_zero_is_conflict():
    db = _Rows(_pending(), tag="UPDATE 0")
    res = _client(db).post(
        f"/api/v1/conversations/{CONV_ID}/approvals/{APPR_ID}",
        json={"optionId": "apply"})
    assert res.status_code == 409
    assert res.json()["error"]["code"] == "CONFLICT"


def _data_frames(frames: list[str]) -> list[dict]:
    found = []
    for frame in frames:
        for line in frame.splitlines():
            if line.startswith("data: "):
                found.append(json.loads(line[len("data: "):]))
    return found


class _Open:
    async def is_disconnected(self):
        return False


async def test_sse_frames_forwards_tool_and_future():
    async def gen():
        yield ("tool", {"name": "read", "state": "run", "summary": "file"}, 3)
        yield ("future", {"note": "later"}, 4)
        yield ("cancelled", {}, 5)
        yield ("done", {"status": "SUCCEEDED"}, 6)
        yield ("error", {"code": "INTERNAL", "message": "no"}, 7)

    frames = _data_frames([frame async for frame in _sse_frames(gen(), _Open())])
    assert frames[0] == {
        "type": "tool", "name": "read", "state": "run", "summary": "file", "seq": 3}
    assert frames[1] == {"type": "future", "note": "later", "seq": 4}
    assert frames[2] == {"type": "cancelled", "seq": 5}
    assert frames[3] == {
        "type": "done", "operation": {"status": "SUCCEEDED"}, "seq": 6}
    assert frames[4] == {
        "type": "error", "error": {"code": "INTERNAL", "message": "no"}, "seq": 7}
