"""Reachable auth stores: user lookup, dev user seed, bearer lookup, idempotency.

OAuth/session issue and billing writers are dead in Python (core-api owns them).
"""
from uuid import uuid4

import pytest

from app.db import NotFoundError
from app.domain.entities import IdempotencyRecord, User
from app.infrastructure.store_auth import (
    _USER_COLS, IdempotencyStore, SessionStore, UserStore,
)
from tests.cov_fakes import NOW, USER, assert_scoped, entity, fake_db, row


class UniqueViolationError(Exception):
    pass


class SqlStateError(Exception):
    sqlstate = "23505"


async def test_user_get_maps_row_and_misses():
    r = row(_USER_COLS, User, id=USER, plan="PRO")
    db, conn = fake_db(r, None)
    s = UserStore(db)
    u = await s.get(USER)
    assert u.id == USER and u.plan == "PRO"
    assert conn.last[2] == (USER,) and "WHERE id = $1" in conn.last[1]
    with pytest.raises(NotFoundError):
        await s.get(uuid4())


async def test_upsert_dev_user_is_idempotent_insert():
    db, conn = fake_db()
    await UserStore(db).upsert_dev_user(USER)
    assert "ON CONFLICT (id) DO NOTHING" in conn.last[1]
    assert conn.last[2] == (USER,)


async def test_user_by_access_token_splits_expiry_from_user():
    r = row(_USER_COLS, User, id=USER)
    r["token_expires_at"] = NOW
    db, conn = fake_db(r)
    user, expires = await SessionStore(db).get_user_by_access_token("hash")
    assert user.id == USER and expires == NOW
    assert conn.last[2] == ("hash",) and "t.token_hash = $1" in conn.last[1]


async def test_user_by_unknown_access_token_not_found():
    db, _ = fake_db(None)
    with pytest.raises(NotFoundError):
        await SessionStore(db).get_user_by_access_token("nope")


def _rec():
    return entity(IdempotencyRecord, user_id=USER, method="POST", path="/p")


async def test_insert_pending_true_on_insert():
    db, conn = fake_db()
    rec = _rec()
    assert await IdempotencyStore(db).insert_pending(rec) is True
    assert conn.last[2] == (rec.id, USER, "POST", "/p", rec.key, rec.request_hash, rec.created_at)


@pytest.mark.parametrize("err", [UniqueViolationError(), SqlStateError()])
async def test_insert_pending_false_on_duplicate_key(err):
    db, _ = fake_db(err)
    assert await IdempotencyStore(db).insert_pending(_rec()) is False


async def test_insert_pending_reraises_other_errors():
    db, _ = fake_db(RuntimeError("boom"))
    with pytest.raises(RuntimeError):
        await IdempotencyStore(db).insert_pending(_rec())


async def test_idempotency_get_is_user_scoped():
    rec = _rec()
    r = dict(rec)
    db, conn = fake_db(r)
    got = await IdempotencyStore(db).get(USER, "POST", "/p", rec.key)
    assert got == rec
    assert_scoped(conn.last, USER)
    assert conn.last[2] == (USER, "POST", "/p", rec.key)


async def test_complete_dumps_headers_or_null():
    db, conn = fake_db()
    s = IdempotencyStore(db)
    rid = uuid4()
    await s.complete(rid, 201, b"{}", [["content-type", "application/json"]])
    assert conn.last[2] == (rid, 201, b"{}", [["content-type", "application/json"]])
    await s.complete(rid, 200, b"")
    assert conn.last[2] == (rid, 200, b"", None)


async def test_delete_pending_only_unfinished():
    db, conn = fake_db()
    rid = uuid4()
    await IdempotencyStore(db).delete_pending(rid)
    assert "response_status IS NULL" in conn.last[1] and conn.last[2] == (rid,)
