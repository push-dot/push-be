"""InterviewStore. CalendarEventStore is only used by the unmounted calendar
router and the unreachable Google sync, so it is not tested here."""
from uuid import uuid4

import pytest

from app.db import ConflictError, NotFoundError
from app.domain.entities import CalendarEvent, CompanySource, InterviewSession
from app.domain.pagination import Cursor
from app.infrastructure.store_calendar import _INTERVIEW_COLS, InterviewStore
from tests.cov_fakes import NOW, USER, assert_scoped, entity, fake_db, page, row


def _iv(**kw):
    return entity(InterviewSession, user_id=USER, **kw)


async def test_create_dumps_json_columns():
    eid = uuid4()
    src = CompanySource(source_url="u", source_text="t", accessed_at=NOW)
    v = _iv(evidence_ids=[eid], company_sources=[src])
    db, conn = fake_db()
    await InterviewStore(db).create(v)
    args = conn.last[2]
    assert args[:2] == (v.id, USER)
    assert args[8] == [str(eid)]
    assert args[9] == [{"sourceUrl": "u", "sourceText": "t", "accessedAt": "2026-01-02T03:04:05Z"}]


async def test_get_scoped_and_null_json_becomes_empty_lists():
    r = row(_INTERVIEW_COLS, InterviewSession, user_id=USER, evidence_ids=None, company_sources=None)
    db, conn = fake_db(r)
    v = await InterviewStore(db).get(USER, r["id"])
    assert v.evidence_ids == [] and v.company_sources == []
    assert_scoped(conn.last, USER)
    assert conn.last[2] == (r["id"], USER)


async def test_get_missing_raises():
    db, _ = fake_db(None)
    with pytest.raises(NotFoundError):
        await InterviewStore(db).get(USER, uuid4())


async def test_list_all_filters_and_cursor():
    rows = [row(_INTERVIEW_COLS, InterviewSession, user_id=USER) for _ in range(2)]
    db, conn = fake_db(rows)
    app_id, cid = uuid4(), uuid4()
    p = await InterviewStore(db).list(USER, app_id, NOW, NOW, page(1, Cursor(NOW, cid)))
    _, sql, args = conn.last
    assert_scoped(conn.last, USER)
    assert "application_id = $2 AND scheduled_at >= $3 AND scheduled_at <= $4" in sql
    assert args == (USER, app_id, NOW, NOW, NOW, cid, 2)
    assert len(p.items) == 1 and p.has_more
    assert p.next_cursor == Cursor(NOW, rows[0]["id"]).encode()


async def test_list_no_filters():
    db, conn = fake_db([])
    p = await InterviewStore(db).list(USER, None, None, None, page())
    assert conn.last[2] == (USER, 51) and p.items == []


async def test_update_scoped_and_conflict():
    v = _iv()
    db, conn = fake_db("UPDATE 0", {"revision": 3})
    with pytest.raises(ConflictError):
        await InterviewStore(db).update(v, 1)
    assert_scoped(conn.calls[0], USER)
    assert conn.calls[0][2][-1] == 1


async def test_calendar_event_writes():
    e = entity(CalendarEvent, user_id=USER)
    db, conn = fake_db(None, None, 2)
    s = InterviewStore(db)
    await s.create_calendar_event(e)
    assert conn.last[2][:2] == (e.id, USER) and len(conn.last[2]) == 14
    await s.update_calendar_event(e.id, "", NOW, NOW)
    assert conn.last[2] == (e.id, "", NOW, NOW)
    assert "coalesce(nullif($2,''), title)" in conn.last[1]
    app_id = uuid4()
    assert await s.count_by_application(USER, app_id) == 2
    assert_scoped(conn.last, USER)
