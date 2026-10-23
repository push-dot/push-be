"""AiUsageStore."""
from uuid import uuid4

import pytest

from app.claimctx import LostClaim, claim_job, claim_token
from app.domain.entities import AiUsage
from app.domain.pagination import Cursor
from app.infrastructure.store_ai import _USAGE_COLS, AiUsageStore
from tests.cov_fakes import NOW, USER, assert_scoped, entity, fake_db, page, row


def _usage(**kw):
    return entity(AiUsage, user_id=USER, created_at=NOW, **kw)


@pytest.fixture
def claimed():
    job = uuid4()
    t1, t2 = claim_token.set("tok"), claim_job.set(str(job))
    yield job
    claim_token.reset(t1)
    claim_job.reset(t2)


async def test_create_for_job_passes_job_id_last():
    db, conn = fake_db()
    u, job = _usage(), uuid4()
    await AiUsageStore(db).create_for_job(u, job)
    _, sql, args = conn.last
    assert "job_id = COALESCE(ai_usage.job_id, EXCLUDED.job_id)" in sql
    assert args[0] == u.id and args[1] == USER and args[-1] == job and len(args) == 12


async def test_create_without_claim_is_plain_upsert():
    db, conn = fake_db()
    u = _usage()
    await AiUsageStore(db).create(u)
    assert len(conn.calls) == 1
    _, sql, args = conn.last
    assert "FROM chat_jobs" not in sql and "ON CONFLICT (id)" in sql
    assert args[:2] == (u.id, USER) and len(args) == 11


async def test_create_with_claim_inserts_only_for_owned_job(claimed):
    db, conn = fake_db("INSERT 0 1")
    await AiUsageStore(db).create(_usage())
    assert len(conn.calls) == 1
    _, sql, args = conn.last
    assert "checkpoint->>'claim'=$13" in sql
    assert args[11] == claimed and args[12] == "tok"


async def test_create_with_claim_noop_upsert_still_owned(claimed):
    db, conn = fake_db("INSERT 0 0", True)
    await AiUsageStore(db).create(_usage())
    assert conn.last[0] == "fetchval" and conn.last[2] == (claimed, "tok")


async def test_create_with_lost_claim_raises(claimed):
    db, _ = fake_db("INSERT 0 0", False)
    with pytest.raises(LostClaim):
        await AiUsageStore(db).create(_usage())


async def test_sum_cost_since_is_user_scoped():
    db, conn = fake_db(42)
    assert await AiUsageStore(db).sum_cost_since(USER, NOW) == 42
    assert_scoped(conn.last, USER)
    assert conn.last[2] == (USER, NOW)


async def test_lock_settle_release_expire_sql_args():
    db, conn = fake_db()
    s = AiUsageStore(db)
    uid = uuid4()
    await s.lock_user(USER)
    assert conn.last[2] == (str(USER),)
    await s.settle(uid, 1, 2, 3)
    assert conn.last[2] == (uid, 1, 2, 3) and "status = 'SETTLED'" in conn.last[1]
    await s.release(uid)
    assert conn.last[2] == (uid,) and "'RELEASED'" in conn.last[1]
    await s.expire_stale()
    assert "'EXPIRED'" in conn.last[1]


async def test_attach_operations_empty_skips_query():
    db, conn = fake_db()
    assert await AiUsageStore(db).attach_operations(uuid4(), []) == 0
    assert conn.calls == []


async def test_attach_operations_returns_rows_changed():
    db, conn = fake_db("UPDATE 2")
    op, ids = uuid4(), [uuid4(), uuid4()]
    assert await AiUsageStore(db).attach_operations(op, ids) == 2
    assert conn.last[2] == (op, ids)


async def test_list_minimal_is_user_scoped():
    rows = [row(_USAGE_COLS, AiUsage, user_id=USER)]
    db, conn = fake_db(rows)
    p = await AiUsageStore(db).list(USER, None, None, page())
    _, sql, args = conn.last
    assert_scoped(conn.last, USER)
    assert sql.endswith("ORDER BY created_at DESC, id DESC LIMIT $2")
    assert args == (USER, 51)
    assert [u.id for u in p.items] == [rows[0]["id"]] and not p.has_more


async def test_list_with_range_and_cursor_numbers_params():
    rows = [row(_USAGE_COLS, AiUsage, user_id=USER) for _ in range(3)]
    db, conn = fake_db(rows)
    cid = uuid4()
    p = await AiUsageStore(db).list(USER, NOW, NOW, page(2, Cursor(NOW, cid)))
    _, sql, args = conn.last
    assert ("AND created_at >= $2 AND created_at <= $3 AND (created_at, id) < ($4, $5) "
            "ORDER BY created_at DESC, id DESC LIMIT $6") in sql
    assert args == (USER, NOW, NOW, NOW, cid, 3)
    assert len(p.items) == 2 and p.has_more
    assert p.next_cursor == Cursor(NOW, rows[1]["id"]).encode()
