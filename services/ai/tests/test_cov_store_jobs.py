from datetime import date
from uuid import uuid4

import pytest

from app.db import ConflictError, NotFoundError
from app.domain.entities import GapAnalysis, JobPosting, RequirementMatch
from app.domain.pagination import Cursor
from app.infrastructure.store_jobs import (
    _ANALYSIS_COLS, _JOB_COLS, GapAnalysisStore, JobStore, ReferenceSampleStore,
)
from tests.cov_fakes import NOW, USER, assert_scoped, entity, fake_db, page, row

JOB = uuid4()


async def test_job_create_stores_deadline_as_date():
    db, conn = fake_db(None, None)
    s = JobStore(db)
    await s.create(entity(JobPosting, user_id=USER, deadline=NOW, keywords=["k"]))
    args = conn.last[2]
    assert args[1] == USER and args[10] == ["k"] and args[12] == date(2026, 1, 2)
    await s.create(entity(JobPosting, user_id=USER))
    assert conn.last[2][12] is None


async def test_job_get_and_find_by_source_url():
    r = row(_JOB_COLS, JobPosting, user_id=USER, requirements=None, risks=None)
    db, conn = fake_db(r, None, r, None)
    s = JobStore(db)
    j = await s.get(USER, r["id"])
    assert j.requirements == [] and j.risks == []
    assert_scoped(conn.last, USER)
    assert await s.find_by_source_url(USER, "u") is None
    assert_scoped(conn.last, USER)
    assert conn.last[2] == (USER, "u")
    assert (await s.find_by_source_url(USER, "u")).id == r["id"]
    with pytest.raises(NotFoundError):
        await s.get(USER, uuid4())


async def test_job_list_filters():
    rows = [row(_JOB_COLS, JobPosting, user_id=USER) for _ in range(2)]
    db, conn = fake_db(rows, [])
    s = JobStore(db)
    cid = uuid4()
    p = await s.list(USER, False, "py", page(1, Cursor(NOW, cid)))
    assert_scoped(conn.last, USER)
    assert "archived = $2 AND (company ILIKE $3 ESCAPE '\\' OR title ILIKE $4 ESCAPE '\\')" in conn.last[1]
    assert conn.last[2] == (USER, False, "%py%", "%py%", NOW, cid, 2) and p.has_more
    await s.list(USER, None, "", page())
    assert conn.last[2] == (USER, 51)


async def test_job_update_conflict_scoped():
    db, conn = fake_db("UPDATE 0", {"revision": 3}, "UPDATE 1")
    s = JobStore(db)
    with pytest.raises(ConflictError):
        await s.update(entity(JobPosting, user_id=USER, deadline=NOW), 2)
    assert_scoped(conn.calls[0], USER)
    assert conn.calls[0][2][11] == date(2026, 1, 2) and conn.calls[0][2][-1] == 2
    await s.update(entity(JobPosting, user_id=USER), 1)
    assert conn.last[2][11] is None


async def test_gap_analysis_store():
    g = entity(GapAnalysis, user_id=USER,
               matched=[RequirementMatch(requirement="r", evidence_ids=["e"])])
    r = row(_ANALYSIS_COLS, GapAnalysis, user_id=USER, matched=None, missing=None)
    rows = [row(_ANALYSIS_COLS, GapAnalysis, user_id=USER) for _ in range(2)]
    db, conn = fake_db(None, r, rows, None, 4)
    s = GapAnalysisStore(db)
    await s.create(g)
    assert conn.last[2][6] == [{"requirement": "r", "evidenceIds": ["e"]}]
    got = await s.get(USER, r["id"])
    assert got.matched == [] and got.missing == []
    assert_scoped(conn.last, USER)
    p = await s.list_by_job(USER, JOB, page(1))
    assert_scoped(conn.last, USER)
    assert conn.last[2] == (USER, JOB, 2) and p.has_more
    keep = uuid4()
    await s.mark_stale_for_job(USER, JOB, keep)
    assert_scoped(conn.last, USER)
    assert conn.last[2] == (USER, JOB, keep)
    assert await s.count_by_application(USER, uuid4()) == 4
    assert_scoped(conn.last, USER)


async def test_reference_sample_store():
    app_id, sid = uuid4(), uuid4()
    db, conn = fake_db({"plan": "PRO"}, None, USER, 70,
                       [{"job_category": "be", "tenure_years": 2, "score_band": "A", "features": {}}])
    s = ReferenceSampleStore(db)
    assert await s.context(USER) == {"plan": "PRO"}
    assert conn.last[2] == (USER,) and "WHERE u.id = $1" in conn.last[1]
    await s.insert(sid, USER, "be", 2, 70, "A", "PRO", {"f": 1}, ["t"], {"p": NOW})
    assert conn.last[2] == (sid, USER, "be", 2, 70, "A", {"p": "2026-01-02T03:04:05Z"},
                            "PRO", {"f": 1}, ["t"])
    company = uuid4()
    assert await s.application_owner(app_id, company) == USER
    assert conn.last[2] == (app_id, company)
    assert "JOIN job_postings p ON p.id = j.source_posting_id" in conn.last[1]
    assert conn.last[1].endswith("WHERE a.id = $1 AND p.company_id = $2")
    assert await s.latest_fit(app_id) == 70
    assert conn.last[2] == (app_id,)
    assert await s.list_for_prompt("be") == [
        {"job_category": "be", "tenure_years": 2, "score_band": "A", "features": {}}]
    assert conn.last[1].endswith("ORDER BY created_at DESC LIMIT 500")
