"""Calendar writes send the event revision, pinned per tool call; post and comment fields match core."""
from __future__ import annotations

import json
from uuid import uuid4

import httpx
import pytest
from pydantic import ValidationError

import app.harness.personal.tools as tools
from app.harness.core_client import CoreClient
from app.harness.tools import ToolContext, run_tool

USER = "99999999-9999-4999-8999-999999999999"
CONV = "77777777-7777-4777-8777-777777777777"
EVENT = uuid4()


class Db:
    def __init__(self, revision):
        self.revision = revision
        self.files = {}

    def q(self):
        return self

    async def execute(self, sql, conversation_id, name, event_id, user_id):
        assert "calendar_events" in sql and event_id == EVENT and user_id == USER
        self.files.setdefault((conversation_id, name), str(self.revision or 0))

    async def fetchrow(self, sql, conversation_id, name):
        return {"body": self.files[(conversation_id, name)]}


def _core(sent, status=200):
    def handler(request):
        sent.append((request.method, request.url.path, json.loads(request.content or b"null")))
        if status == 409:
            return httpx.Response(409, json={"error": {"code": "REVISION_CONFLICT", "message": "modified"}})
        return httpx.Response(status, json={"data": {}}) if status != 204 else httpx.Response(204)
    return CoreClient("http://core.test", "secret", httpx.MockTransport(handler))


def _ctx(db, core, call="call-1"):
    return ToolContext(user_id=USER, company_id=None, conversation_id=CONV, job_id="job-1",
                       tool_call_id=call, db=db, core=core)


def _tool(name):
    return next(t for t in tools.PERSONAL_TOOLS if t.name == name)


async def _run(name, args, ctx):
    tool = _tool(name)
    return await run_tool(tool, ctx, tool.args_model.model_validate(args))


async def test_update_sends_the_event_revision():
    sent, db = [], Db(3)
    result, ok = await _run("update_calendar_event", {"event_id": str(EVENT), "title": "면접"}, _ctx(db, _core(sent)))

    assert ok, result
    assert sent == [("PATCH", f"/api/v1/calendar/events/{EVENT}", {"title": "면접", "expectedRevision": 3})]


async def test_delete_sends_the_event_revision():
    sent, db = [], Db(2)
    result, ok = await _run("delete_calendar_event", {"event_id": str(EVENT)}, _ctx(db, _core(sent, 204)))

    assert ok, result
    assert sent == [("DELETE", f"/api/v1/calendar/events/{EVENT}", {"expectedRevision": 2})]


async def test_a_replayed_call_keeps_its_first_revision_and_a_new_call_reads_again():
    sent, db = [], Db(3)
    args = {"event_id": str(EVENT), "title": "면접"}
    await _run("update_calendar_event", args, _ctx(db, _core(sent)))
    db.revision = 4
    await _run("update_calendar_event", args, _ctx(db, _core(sent)))
    await _run("update_calendar_event", args, _ctx(db, _core(sent), call="call-2"))

    assert [body["expectedRevision"] for _, _, body in sent] == [3, 3, 4]


async def test_a_stale_revision_surfaces_the_conflict():
    sent = []
    result, ok = await _run("delete_calendar_event", {"event_id": str(EVENT)}, _ctx(Db(1), _core(sent, 409)))

    assert (result, ok) == ({"error": "REVISION_CONFLICT"}, False)
    assert len(sent) == 1


async def test_a_missing_event_sends_revision_zero_so_core_answers_not_found():
    sent = []
    await _run("delete_calendar_event", {"event_id": str(EVENT)}, _ctx(Db(None), _core(sent, 204)))

    assert sent[0][2] == {"expectedRevision": 0}


async def test_without_a_database_the_write_is_not_sent():
    sent = []
    result, ok = await _run("delete_calendar_event", {"event_id": str(EVENT)}, _ctx(None, _core(sent)))

    assert (result, ok, sent) == ({"error": "UNAVAILABLE"}, False, [])


@pytest.mark.parametrize(("name", "args"), [
    ("create_post", {"category": "talk", "title": "가" * 101, "body": "본문"}),
    ("create_post", {"category": "talk", "title": "", "body": "본문"}),
    ("create_post", {"category": "talk", "title": "제목", "body": ""}),
    ("create_comment", {"post_id": str(uuid4()), "body": ""}),
    ("create_comment", {"post_id": str(uuid4())}),
    ("create_comment", {"post_id": str(uuid4()), "body": "가" * 1001}),
])
def test_post_and_comment_fields_outside_core_limits_are_rejected(name, args):
    with pytest.raises(ValidationError):
        _tool(name).args_model.model_validate(args)


@pytest.mark.parametrize(("name", "args"), [
    ("create_post", {"category": "talk", "title": "가" * 100, "body": "본문"}),
    ("create_comment", {"post_id": str(uuid4()), "body": "좋아요"}),
])
def test_post_and_comment_fields_inside_core_limits_pass(name, args):
    _tool(name).args_model.model_validate(args)
