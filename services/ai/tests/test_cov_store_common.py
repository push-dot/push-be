from uuid import uuid4

import pytest

from app.db import ConflictError, NotFoundError
from app.domain.entities import Conversation
from app.domain.pagination import Cursor
from app.infrastructure.store_common import Conds, Store, list_page, m, to_model
from tests.cov_fakes import NOW, USER, entity, fake_db, page, row


async def test_one_returns_row_or_raises_not_found():
    db, conn = fake_db({"a": 1}, None)
    s = Store(db)
    assert await s.one("SELECT 1 WHERE x = $1", 5) == {"a": 1}
    assert conn.last == ("fetchrow", "SELECT 1 WHERE x = $1", (5,))
    with pytest.raises(NotFoundError):
        await s.one("SELECT 1")


async def test_guard_update_passes_when_a_row_changed():
    db, conn = fake_db("UPDATE 1")
    await Store(db).guard_update("t", 1, USER, "UPDATE t", 1, USER)
    assert len(conn.calls) == 1


async def test_guard_update_reports_conflict_with_current_revision():
    id_ = uuid4()
    db, conn = fake_db("UPDATE 0", {"revision": 7})
    with pytest.raises(ConflictError) as e:
        await Store(db).guard_update("documents", id_, USER, "UPDATE documents")
    assert e.value.current == 7
    op, sql, args = conn.last
    assert sql == "SELECT revision FROM documents WHERE id = $1 AND user_id = $2"
    assert args == (id_, USER)


async def test_guard_update_reports_not_found_for_foreign_row():
    db, _ = fake_db("UPDATE 0", None)
    with pytest.raises(NotFoundError):
        await Store(db).guard_update("documents", uuid4(), USER, "UPDATE documents")


def test_conds_numbers_placeholders_in_order():
    c = Conds()
    c.add("user_id = {}", USER)
    c.add("NOT archived")
    c.add("(a ILIKE {} OR b ILIKE {})", "%q%", "%q%")
    cid = uuid4()
    c.cursor(page(cursor=Cursor(NOW, cid)))
    sql, args = c.query("id", "t", 10)
    assert sql == ("SELECT id FROM t WHERE user_id = $1 AND NOT archived AND "
                   "(a ILIKE $2 OR b ILIKE $3) AND (created_at, id) < ($4, $5) "
                   "ORDER BY created_at DESC, id DESC LIMIT $6")
    assert args == [USER, "%q%", "%q%", NOW, cid, 11]


def test_conds_cursor_absent_adds_nothing():
    c = Conds()
    c.add("user_id = {}", USER)
    c.cursor(page())
    assert c.where == ["user_id = $1"]


def test_list_page_maps_rows_and_sets_cursor():
    cols = "id, user_id, revision, application_id, title, pinned, archived, created_at, updated_at, company_id"
    rows = [row(cols, Conversation, user_id=USER) for _ in range(3)]
    p = list_page(rows, page(limit=2), Conversation, lambda c: Cursor(c.created_at, c.id))
    assert [c.id for c in p.items] == [r["id"] for r in rows[:2]]
    assert p.has_more and p.next_cursor == Cursor(NOW, rows[1]["id"]).encode()


def test_to_model_and_m_build_entities():
    c = entity(Conversation, user_id=USER)
    d = dict(c)
    assert to_model(Conversation, d) == c
    assert m(Conversation)(d) == c
