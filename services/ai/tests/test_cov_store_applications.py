from uuid import uuid4

import pytest

from app.db import ConflictError, NotFoundError
from app.domain.entities import Application, ApplicationEvent, Submission, SubmissionDraft
from app.domain.pagination import Cursor
from app.infrastructure.store_applications import (
    _APP_COLS, _DRAFT_COLS, _EVENT_COLS, _SUB_COLS, ApplicationStore, SubmissionStore,
)
from tests.cov_fakes import NOW, USER, assert_scoped, entity, fake_db, page, row


def _app_row(**kw):
    return row(_APP_COLS + ", fit_score", Application, user_id=USER, fit_score=80, **kw)


async def test_create_writes_all_columns_in_order():
    db, conn = fake_db()
    a = entity(Application, user_id=USER)
    await ApplicationStore(db).create(a)
    _, sql, args = conn.last
    assert sql.startswith(f"INSERT INTO applications ({_APP_COLS})")
    assert args == (a.id, USER, a.revision, a.job_id, a.company, a.title, a.stage, a.notes,
                    a.applied_at, a.next_action_at, a.imported, a.created_at, a.updated_at)


async def test_get_is_owner_scoped_and_maps_fit_score():
    r = _app_row()
    db, conn = fake_db(r)
    a = await ApplicationStore(db).get(USER, r["id"])
    assert a.id == r["id"] and a.fit_score == 80
    assert_scoped(conn.last, USER)
    assert conn.last[2] == (r["id"], USER)


async def test_get_foreign_or_missing_raises_not_found():
    db, _ = fake_db(None)
    with pytest.raises(NotFoundError):
        await ApplicationStore(db).get(USER, uuid4())


async def test_find_by_job_none_and_found():
    r = _app_row()
    db, conn = fake_db(None, r)
    s = ApplicationStore(db)
    job = uuid4()
    assert await s.find_by_job(USER, job) is None
    assert_scoped(conn.last, USER)
    assert conn.last[2] == (USER, job)
    assert (await s.find_by_job(USER, job)).id == r["id"]


async def test_list_filters_and_cursor():
    rows = [_app_row(), _app_row()]
    db, conn = fake_db(rows)
    cid = uuid4()
    p = await ApplicationStore(db).list(USER, "APPLIED", "acme", page(1, Cursor(NOW, cid)))
    _, sql, args = conn.last
    assert_scoped(conn.last, USER)
    assert "stage = $2 AND (company ILIKE $3 OR title ILIKE $4)" in sql
    assert args == (USER, "APPLIED", "%acme%", "%acme%", NOW, cid, 2)
    assert len(p.items) == 1 and p.has_more


async def test_list_without_filters_only_scopes_user():
    db, conn = fake_db([])
    p = await ApplicationStore(db).list(USER, None, "", page())
    assert "stage" not in conn.last[1].split("WHERE")[1].split("ORDER")[0]
    assert conn.last[2] == (USER, 51) and p.items == []


async def test_update_conflict_reports_current_revision():
    a = entity(Application, user_id=USER)
    db, conn = fake_db("UPDATE 0", {"revision": 4})
    with pytest.raises(ConflictError):
        await ApplicationStore(db).update(a, 2)
    update = conn.calls[0]
    assert_scoped(update, USER)
    assert update[2][-1] == 2 and "revision = $9" in update[1]


async def test_add_event_and_list_events():
    e = entity(ApplicationEvent, user_id=USER, payload={"at": NOW})
    rows = [row(_EVENT_COLS, ApplicationEvent, user_id=USER)]
    db, conn = fake_db(None, rows)
    s = ApplicationStore(db)
    await s.add_event(e)
    assert conn.last[2][4] == {"at": "2026-01-02T03:04:05Z"}
    app_id = uuid4()
    p = await s.list_events(USER, app_id, page())
    assert_scoped(conn.last, USER)
    assert conn.last[2] == (USER, app_id, 51)
    assert p.items[0].id == rows[0]["id"]


async def test_submission_draft_round_trip():
    v1 = uuid4()
    d = entity(SubmissionDraft, user_id=USER, document_version_ids=[v1])
    r = row(_DRAFT_COLS, SubmissionDraft, user_id=USER)
    db, conn = fake_db(None, r)
    s = SubmissionStore(db)
    await s.create_draft(d)
    assert conn.last[2][6] == [str(v1)]
    got = await s.get_draft(USER, r["id"])
    assert got.id == r["id"]
    assert_scoped(conn.last, USER)


async def test_get_draft_not_found():
    db, _ = fake_db(None)
    with pytest.raises(NotFoundError):
        await SubmissionStore(db).get_draft(USER, uuid4())


async def test_submission_create_and_list():
    sub = entity(Submission, user_id=USER)
    rows = [row(_SUB_COLS, Submission, user_id=USER)]
    db, conn = fake_db(None, rows)
    s = SubmissionStore(db)
    await s.create(sub)
    assert conn.last[2][:2] == (sub.id, USER) and len(conn.last[2]) == 12
    app_id = uuid4()
    p = await s.list(USER, app_id, page())
    assert_scoped(conn.last, USER)
    assert conn.last[2] == (USER, app_id, 51) and len(p.items) == 1
