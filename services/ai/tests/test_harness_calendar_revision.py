"""Calendar writes send the event's current revision; post and comment fields match core."""
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

    def q(self):
        return self

    async def fetchrow(self, sql, event_id, user_id):
        assert "calendar_events" in sql and event_id == EVENT and user_id == USER
        return None if self.revision is None else {"revision": self.revision}


class Core:
    def __init__(self, db, status=200):
        self.db, self.status, self.sent = db, status, []

    def client(self):
        def handler(request):
            body = json.loads(request.content or b"null")
            self.sent.append((request.method, request.url.path, body))
            if self.status == 409:
                return httpx.Response(409, json={"error": {"code": "REVISION_CONFLICT", "message": "modified"}})
            if self.status == 404:
                return httpx.Response(404, json={"error": {"code": "NOT_FOUND", "message": "gone"}})
            if request.method == "DELETE":
                self.db.revision = None
                return httpx.Response(204)
            self.db.revision += 1
            return httpx.Response(200, json={"data": {"revision": self.db.revision}})
        return CoreClient("http://core.test", "secret", httpx.MockTransport(handler))


def _ctx(db, core, call="call-1"):
    return ToolContext(user_id=USER, company_id=None, conversation_id=CONV, job_id="job-1",
                       tool_call_id=call, db=db, core=core.client() if core else None)


def _tool(name):
    return next(t for t in tools.PERSONAL_TOOLS if t.name == name)


async def _run(name, args, ctx):
    tool = _tool(name)
    return await run_tool(tool, ctx, tool.args_model.model_validate(args))


async def test_update_sends_the_event_revision():
    db = Db(3)
    core = Core(db)
    result, ok = await _run("update_calendar_event", {"event_id": str(EVENT), "title": "면접"}, _ctx(db, core))

    assert ok, result
    assert core.sent == [("PATCH", f"/api/v1/calendar/events/{EVENT}", {"title": "면접", "expectedRevision": 3})]


async def test_a_replayed_update_writes_the_same_values_at_the_new_revision():
    db = Db(3)
    core = Core(db)
    args = {"event_id": str(EVENT), "title": "면접"}
    first = await _run("update_calendar_event", args, _ctx(db, core))
    replay = await _run("update_calendar_event", args, _ctx(db, core))

    assert first[1] and replay[1]
    assert [body for _, _, body in core.sent] == [
        {"title": "면접", "expectedRevision": 3}, {"title": "면접", "expectedRevision": 4}]


async def test_delete_sends_the_event_revision():
    db = Db(2)
    core = Core(db)
    result, ok = await _run("delete_calendar_event", {"event_id": str(EVENT)}, _ctx(db, core))

    assert (result, ok) == ({}, True)
    assert core.sent == [("DELETE", f"/api/v1/calendar/events/{EVENT}", {"expectedRevision": 2})]


async def test_a_replayed_delete_is_done_without_a_request():
    db = Db(2)
    core = Core(db)
    await _run("delete_calendar_event", {"event_id": str(EVENT)}, _ctx(db, core))
    replay = await _run("delete_calendar_event", {"event_id": str(EVENT)}, _ctx(db, core))

    assert replay == ({}, True)
    assert len(core.sent) == 1


async def test_a_delete_that_core_finds_gone_is_done():
    db = Db(2)
    result = await _run("delete_calendar_event", {"event_id": str(EVENT)}, _ctx(db, Core(db, 404)))

    assert result == ({}, True)


async def test_an_update_of_a_missing_event_is_not_found():
    db = Db(None)
    core = Core(db)
    result = await _run("update_calendar_event", {"event_id": str(EVENT), "title": "면접"}, _ctx(db, core))

    assert result == ({"error": "NOT_FOUND"}, False)
    assert core.sent == []


@pytest.mark.parametrize("name", ["update_calendar_event", "delete_calendar_event"])
async def test_a_stale_revision_surfaces_the_conflict_once(name):
    db = Db(1)
    core = Core(db, 409)
    result = await _run(name, {"event_id": str(EVENT), "title": "면접"} if name.startswith("update") else
                        {"event_id": str(EVENT)}, _ctx(db, core))

    assert result == ({"error": "REVISION_CONFLICT"}, False)
    assert len(core.sent) == 1


async def test_without_a_database_the_write_is_not_sent():
    core = Core(None)
    result = await _run("delete_calendar_event", {"event_id": str(EVENT)}, _ctx(None, core))

    assert result == ({"error": "UNAVAILABLE"}, False)
    assert core.sent == []


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
