from __future__ import annotations

import json
from types import SimpleNamespace
from uuid import uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.errors import domain_error_handler
from app.api.routers.operations import router
from app.domain import entities as ent
from app.domain.errors import DomainError
from app.domain.services.operation import OperationService
from tests import test_cov_svc_fakes as f
from tests.test_cov_svc_approval import _AsUser
from tests.test_cov_svc_evidence import _svc as _evidence_svc

A, B = uuid4(), uuid4()


def _svc():
    ev = _evidence_svc()
    s = OperationService(f.FakeDB(), ev)
    s.ops = ev.ops  # import_ and the operation routes share one table
    s.locks = _Locks()
    return s


class _Locks:
    def __init__(self):
        self.locked = []

    async def lock_user(self, user_id):
        self.locked.append(user_id)


def _op(user_id, status, type_=ent.OP_JOB_ANALYSIS, **kw):
    return ent.Operation(id=uuid4(), user_id=user_id, type=type_, status=status,
                         created_at=f.now(), updated_at=f.now(), **kw)


async def _raises(code, aw):
    with pytest.raises(DomainError) as e:
        await aw
    assert e.value.code == code, e.value
    return e.value


async def _pending_import(s, **kw):
    args = {"text": "Built X", "kind": "", "title": ""} | kw
    return await s.evidence.import_(A, None, args["text"], None, "", "TEXT",
                                    args["kind"], args["title"])


async def test_submit_input_completes_evidence_import():
    s = _svc()
    op = await _pending_import(s)
    out = await s.submit_input(A, op.id, {"kind": "CAREER", "title": "X"}, None)
    assert out.status == ent.OP_SUCCEEDED and out.input_request is None
    stored = await s.ops.get(A, op.id)
    assert stored.status == ent.OP_SUCCEEDED and stored.input_request is None
    ev_id = stored.result.value["evidence"][0]["id"]
    assert (await s.evidence.evidence.get(A, ev_id)).title == "X"
    # Finished operations refuse more input.
    await _raises("INVALID_TRANSITION", s.submit_input(A, op.id, {"title": "Y"}, None))


async def test_submit_partial_input_keeps_asking_for_the_rest():
    s = _svc()
    op = await _pending_import(s)
    out = await s.submit_input(A, op.id, {"kind": "CAREER"}, None)
    assert out.status == ent.OP_NEEDS_INPUT
    assert [x.name for x in out.input_request.fields] == ["title"]
    assert s.evidence.evidence.rows == {}
    out = await s.submit_input(A, op.id, {"title": "T"}, None)
    assert out.status == ent.OP_SUCCEEDED


async def test_submit_input_rejects_unrequested_field_without_writing():
    s = _svc()
    op = await _pending_import(s, kind="SKILL")
    err = await _raises("VALIDATION_ERROR", s.submit_input(A, op.id, {"kind": "X"}, None))
    assert err.details == {"field": "fields.kind"}
    assert s.ops.updates == 0


async def test_submit_input_is_owner_only():
    s = _svc()
    op = await _pending_import(s)
    await _raises("NOT_FOUND", s.submit_input(B, op.id, {"title": "T"}, None))
    assert (await s.ops.get(A, op.id)).status == ent.OP_NEEDS_INPUT


async def test_submit_input_rejects_ops_not_waiting_for_input():
    s = _svc()
    running = s.ops.put(_op(A, ent.OP_RUNNING))
    err = await _raises("INVALID_TRANSITION", s.submit_input(A, running.id, {}, None))
    assert "does not await input" in err.message
    other = s.ops.put(_op(A, ent.OP_NEEDS_INPUT, input_request=ent.InputRequest(
        code="C", message="m", fields=[])))
    err = await _raises("INVALID_TRANSITION", s.submit_input(A, other.id, {}, None))
    assert "does not accept input" in err.message


async def test_cancel_running_op_and_idempotent_on_terminal():
    s = _svc()
    op = s.ops.put(_op(A, ent.OP_RUNNING))
    out = await s.cancel(A, op.id)
    assert out.status == ent.OP_CANCELLED
    assert (await s.ops.get(A, op.id)).status == ent.OP_CANCELLED
    again = await s.cancel(A, op.id)
    assert again.status == ent.OP_CANCELLED and s.ops.updates == 1
    done = s.ops.put(_op(A, ent.OP_SUCCEEDED))
    assert (await s.cancel(A, done.id)).status == ent.OP_SUCCEEDED
    await _raises("NOT_FOUND", s.cancel(B, done.id))


async def test_get_scoped_and_outage_internal():
    s = _svc()
    op = s.ops.put(_op(A, ent.OP_RUNNING))
    assert (await s.get(A, op.id)).id == op.id
    await _raises("NOT_FOUND", s.get(B, op.id))
    s.ops = f.Boom()
    await _raises("INTERNAL", s.get(A, op.id))


# ---- router -----------------------------------------------------------------

def _client(svc, user_id=A):
    app = FastAPI()
    app.add_exception_handler(DomainError, domain_error_handler)
    app.include_router(router, prefix="/api/v1")
    app.add_middleware(_AsUser, user=ent.User(id=user_id, display_name="u",
                                              created_at=f.now()))
    app.state.deps = SimpleNamespace(operations=svc)
    return TestClient(app)


def _events(res):
    out = []
    for chunk in res.text.strip().split("\n\n"):
        lines = dict(line.split(": ", 1) for line in chunk.splitlines())
        out.append((lines["event"], json.loads(lines["data"])))
    return out


def test_routes_get_input_cancel():
    import asyncio
    s = _svc()
    op = asyncio.run(_pending_import(s))
    c = _client(s)
    assert c.get(f"/api/v1/operations/{op.id}").json()["data"]["status"] == "NEEDS_INPUT"
    res = c.post(f"/api/v1/operations/{op.id}/input",
                 json={"fields": {"kind": "CAREER", "title": "T"}})
    assert res.status_code == 200 and res.json()["data"]["status"] == "SUCCEEDED"
    run = s.ops.put(_op(A, ent.OP_RUNNING))
    assert c.post(f"/api/v1/operations/{run.id}/cancel").json()["data"]["status"] == "CANCELLED"
    assert _client(s, B).get(f"/api/v1/operations/{op.id}").status_code == 404


@pytest.mark.parametrize("op_kw,want", [
    ({"status": ent.OP_RUNNING, "progress": 40}, ["progress"]),
    ({"status": ent.OP_SUCCEEDED, "result": ent.OperationResult(kind="K", value={"x": 1})},
     ["progress", "result"]),
    ({"status": ent.OP_FAILED, "error": ent.OperationError(
        code="BOOM", message="m", retryable=True)}, ["progress", "error"]),
    ({"status": ent.OP_CANCELLED}, ["progress", "error"]),
])
def test_events_snapshot(op_kw, want):
    s = _svc()
    status = op_kw.pop("status")
    op = s.ops.put(_op(A, status, **op_kw))
    res = _client(s).get(f"/api/v1/operations/{op.id}/events")
    assert res.status_code == 200
    assert res.headers["content-type"].startswith("text/event-stream")
    events = _events(res)
    assert [k for k, _ in events] == want
    assert [d["sequence"] for _, d in events] == list(range(1, len(want) + 1))
    assert all(d["operationId"] == str(op.id) for _, d in events)
    assert events[0][1]["payload"]["status"] == status
    if status == ent.OP_SUCCEEDED:
        assert events[1][1]["payload"] == {"x": 1}
    if status == ent.OP_FAILED:
        assert events[1][1]["payload"]["code"] == "BOOM"
    if status == ent.OP_CANCELLED:
        assert events[1][1]["payload"] == {"code": "CANCELLED",
                                           "message": "operation cancelled",
                                           "retryable": False}


async def test_submit_input_serializes_on_the_user_lock_before_reading():
    s = _svc()
    op = await _pending_import(s)
    get = s.ops.get

    async def guarded_get(user_id, id_):
        assert s.locks.locked == [A], "op read before the user lock"
        return await get(user_id, id_)

    s.ops.get = guarded_get
    await s.submit_input(A, op.id, {"kind": "SKILL", "title": "X"}, None)


async def test_cancel_takes_the_user_lock_before_reading():
    s = _svc()
    op = await _pending_import(s)
    get = s.ops.get

    async def guarded_get(user_id, id_):
        assert s.locks.locked == [A], "op read before the user lock"
        return await get(user_id, id_)

    s.ops.get = guarded_get
    assert (await s.cancel(A, op.id)).status == ent.OP_CANCELLED
