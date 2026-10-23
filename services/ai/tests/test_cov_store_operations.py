from uuid import uuid4

import pytest

from app.db import ConflictError, NotFoundError
from app.domain.entities import (
    Approval, InputField, InputRequest, Operation, OperationError, OperationResult,
)
from app.domain.pagination import Cursor
from app.infrastructure.store_operations import (
    _APPR_COLS, _OP_COLS, ApprovalStore, OperationStore,
)
from tests.cov_fakes import NOW, USER, assert_scoped, entity, fake_db, page, row


def _full_op():
    return entity(
        Operation, user_id=USER,
        result=OperationResult(kind="k", value={"a": 1}),
        error=OperationError(code="E", message="m", retryable=False),
        input_request=InputRequest(code="c", message="m",
                                   fields=[InputField(name="n", label="l", type="t")]),
        pending_payload={"p": 1})


async def test_operation_create_and_update_dump_optional_json():
    db, conn = fake_db()
    s = OperationStore(db)
    bare = entity(Operation, user_id=USER)
    await s.create(bare)
    assert "ON CONFLICT (id) DO NOTHING" in conn.last[1]
    assert conn.last[2][6:10] == (None, None, None, None)
    full = _full_op()
    await s.create(full)
    assert conn.last[2][6:10] == ({"kind": "k", "value": {"a": 1}},
                                  {"code": "E", "message": "m", "retryable": False},
                                  {"code": "c", "message": "m",
                                   "fields": [{"name": "n", "label": "l", "type": "t"}]},
                                  {"p": 1})
    await s.update(bare)
    assert conn.last[2][3:7] == (None, None, None, None)
    await s.update(full)
    assert conn.last[2][0] == full.id and conn.last[2][6] == {"p": 1}


async def test_operation_get_scoped():
    r = row(_OP_COLS, Operation, user_id=USER)
    db, conn = fake_db(r, None)
    s = OperationStore(db)
    assert (await s.get(USER, r["id"])).id == r["id"]
    assert_scoped(conn.last, USER)
    with pytest.raises(NotFoundError):
        await s.get(USER, uuid4())


async def test_approval_crud():
    a = entity(Approval, user_id=USER)
    r = row(_APPR_COLS, Approval, user_id=USER)
    rows = [row(_APPR_COLS, Approval, user_id=USER) for _ in range(2)]
    db, conn = fake_db(None, r, rows, [], "UPDATE 0", {"revision": 2})
    s = ApprovalStore(db)
    await s.create(a)
    assert conn.last[2][:2] == (a.id, USER) and len(conn.last[2]) == 14
    assert (await s.get(USER, r["id"])).id == r["id"]
    assert_scoped(conn.last, USER)
    app_id, cid = uuid4(), uuid4()
    p = await s.list(USER, app_id, "PENDING", page(1, Cursor(NOW, cid)))
    assert_scoped(conn.last, USER)
    assert "application_id = $2 AND status = $3" in conn.last[1]
    assert conn.last[2] == (USER, app_id, "PENDING", NOW, cid, 2) and p.has_more
    await s.list(USER, None, None, page())
    assert conn.last[2] == (USER, 51)
    with pytest.raises(ConflictError):
        await s.update(a, 1)
    assert_scoped(conn.calls[-2], USER)


async def test_find_active_scoped_and_missing():
    r = row(_APPR_COLS, Approval, user_id=USER)
    db, conn = fake_db(r, None)
    s = ApprovalStore(db)
    app_id, target = uuid4(), uuid4()
    assert (await s.find_active(USER, "K", app_id, target, NOW)).id == r["id"]
    assert_scoped(conn.last, USER)
    assert conn.last[2] == (USER, "K", app_id, target, NOW)
    with pytest.raises(NotFoundError):
        await s.find_active(USER, "K", None, target, NOW)
