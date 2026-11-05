from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from uuid import UUID

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.errors import domain_error_handler
from app.api.routers.conversations import router
from app.domain import entities as ent
from app.domain.chat_turns import turn_events
from app.domain.errors import DomainError
from app.infrastructure.store_chat_jobs import assistant_message_id, user_message_id

USER_ID = UUID("00000000-0000-4000-8000-0000000000aa")
OTHER_ID = UUID("00000000-0000-4000-8000-0000000000ff")
CONV_ID = UUID("00000000-0000-4000-8000-0000000000c1")
JOB_A = UUID("00000000-0000-4000-8000-00000000a001")
JOB_B = UUID("00000000-0000-4000-8000-00000000a002")
CARD = "00000000-0000-4000-8000-00000000c0de"
T0 = datetime(2026, 11, 5, tzinfo=UTC)


def _row(id_, type_, payload, job=JOB_A):
    return {"id": id_, "job_id": job, "type": type_, "payload": payload}


def test_turn_events_merge_tokens_and_drop_progress_rows():
    rows = [
        _row(1, "status", {"text": "대기 중"}),
        _row(2, "todo", {"id": "analyze", "items": []}),
        _row(3, "token", {"text": "다 "}),
        _row(4, "token", {"text": "됐어요"}),
        _row(5, "file", {"name": "final.md", "mime": "text/markdown"}),
        _row(6, "done", {"operation": None}),
    ]
    assert turn_events(rows, {}) == [
        {"type": "todo", "id": "analyze", "items": [], "seq": 2},
        {"type": "token", "text": "다 됐어요", "seq": 3},
    ]


def test_turn_events_read_text_payload_and_attach_card_resolution():
    rows = [_row(7, "choice", json.dumps({"id": CARD, "options": []}))]
    resolved = {CARD: {"status": "APPROVED", "optionId": "ready"}}
    assert turn_events(rows, resolved) == [
        {
            "type": "choice",
            "id": CARD,
            "options": [],
            "seq": 7,
            "resolution": {"status": "APPROVED", "optionId": "ready"},
        }
    ]


class _Mem:
    def __init__(self):
        self.jobs = []
        self.events = []
        self.approvals = []
        self.messages = set()
        self.calls = []

    def q(self):
        return self

    async def fetchrow(self, sql, *args):
        if "from conversations" in sql.lower() and args[1] == USER_ID and args[0] == CONV_ID:
            return {
                "id": CONV_ID,
                "user_id": USER_ID,
                "revision": 1,
                "application_id": None,
                "title": "t",
                "pinned": False,
                "archived": False,
                "created_at": T0,
                "updated_at": T0,
                "company_id": None,
            }
        return None

    async def fetch(self, sql, *args):
        self.calls.append((sql, args))
        text = " ".join(sql.lower().split())
        if text.startswith("select j.id"):
            rows = sorted(self.jobs, key=lambda j: (j["created_at"], j["id"]), reverse=True)
            return rows[: args[-1]]
        if "from chat_events" in text:
            return [e for e in self.events if e["job_id"] in args[0]]
        if "from approvals" in text:
            return [a for a in self.approvals if a["id"] in args[1]]
        if "from messages" in text:
            return [{"id": m} for m in self.messages if m in args[1]]
        return []


def _client(db: _Mem, user_id: UUID) -> TestClient:
    app = FastAPI()
    app.add_exception_handler(DomainError, domain_error_handler)
    app.include_router(router, prefix="/api/v1")

    class _AsUser:
        def __init__(self, inner):
            self.inner = inner

        async def __call__(self, scope, receive, send):
            if scope["type"] == "http":
                scope.setdefault("state", {})["user"] = ent.User(
                    id=user_id, display_name="Ada", created_at=T0
                )
            await self.inner(scope, receive, send)

    app.add_middleware(_AsUser)
    app.state.db = db
    return TestClient(app)


def _db() -> _Mem:
    db = _Mem()
    db.jobs = [
        {"id": JOB_A, "status": "DONE", "created_at": T0, "resume": None},
        {
            "id": JOB_B,
            "status": "DONE",
            "created_at": T0 + timedelta(minutes=1),
            "resume": json.dumps({"approvalId": CARD, "optionId": "ready"}),
        },
    ]
    db.events = [
        _row(1, "choice", {"id": CARD, "options": [{"id": "ready", "label": "네"}]}),
        _row(2, "token", {"text": "고를게요"}),
        _row(3, "todo", {"id": "analyze", "items": []}, job=JOB_B),
    ]
    db.approvals = [
        {"id": UUID(CARD), "status": "APPROVED", "option_id": "ready", "option_ids": None}
    ]
    db.messages = {user_message_id(JOB_A), assistant_message_id(JOB_B)}
    return db


def test_turns_lists_newest_first_with_cards_and_answers():
    res = _client(_db(), USER_ID).get(f"/api/v1/conversations/{CONV_ID}/turns")
    assert res.status_code == 200
    body = res.json()
    assert body["page"] == {"nextCursor": None, "hasMore": False}
    newest, oldest = body["data"]
    assert newest == {
        "jobId": str(JOB_B),
        "status": "DONE",
        "createdAt": "2026-11-05T00:01:00Z",
        "userMessageId": None,
        "assistantMessageId": str(assistant_message_id(JOB_B)),
        "answer": {"approvalId": CARD, "optionId": "ready"},
        "events": [{"type": "todo", "id": "analyze", "items": [], "seq": 3}],
    }
    assert oldest["userMessageId"] == str(user_message_id(JOB_A))
    assert oldest["assistantMessageId"] is None
    assert oldest["answer"] is None
    assert oldest["events"][0]["resolution"] == {"status": "APPROVED", "optionId": "ready"}


def test_turns_page_has_cursor_when_more_jobs_exist():
    res = _client(_db(), USER_ID).get(f"/api/v1/conversations/{CONV_ID}/turns?limit=1")
    body = res.json()
    assert [turn["jobId"] for turn in body["data"]] == [str(JOB_B)]
    assert body["page"]["hasMore"] is True
    assert body["page"]["nextCursor"]


def test_turns_multi_select_answer_keeps_every_option():
    db = _db()
    db.approvals = [
        {
            "id": UUID(CARD),
            "status": "APPROVED",
            "option_id": "resume",
            "option_ids": json.dumps(["resume", "cover_letter"]),
        }
    ]
    res = _client(db, USER_ID).get(f"/api/v1/conversations/{CONV_ID}/turns")
    card = res.json()["data"][1]["events"][0]
    assert card["resolution"] == {
        "status": "APPROVED",
        "optionId": "resume",
        "optionIds": ["resume", "cover_letter"],
    }


def test_turns_of_another_users_conversation_is_404():
    res = _client(_db(), OTHER_ID).get(f"/api/v1/conversations/{CONV_ID}/turns")
    assert res.status_code == 404
    assert res.json()["error"]["code"] == "NOT_FOUND"
