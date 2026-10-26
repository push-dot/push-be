"""EvidenceStore and the reachable SourceStore reads.

SourceStore.create/delete have no callers in Python (sources CRUD lives in
core-api)."""
from uuid import uuid4

import pytest

from app.db import ConflictError, NotFoundError
from app.domain.entities import CareerEvidence, Source
from app.domain.pagination import Cursor
from app.infrastructure.store_evidence import (
    _EVIDENCE_COLS, _SOURCE_COLS, EvidenceStore, SourceStore,
)
from tests.cov_fakes import NOW, USER, assert_scoped, entity, fake_db, page, row


async def test_evidence_create_and_get():
    e = entity(CareerEvidence, user_id=USER, skills=["py"])
    r = row(_EVIDENCE_COLS, CareerEvidence, user_id=USER)
    db, conn = fake_db(None, r, None)
    s = EvidenceStore(db)
    await s.create(e)
    args = conn.last[2]
    assert args[:2] == (e.id, USER) and args[7] == ["py"] and isinstance(args[9], dict)
    assert (await s.get(USER, r["id"])).id == r["id"]
    assert_scoped(conn.last, USER)
    with pytest.raises(NotFoundError):
        await s.get(USER, uuid4())


async def test_evidence_list_filters_skip_archived():
    rows = [row(_EVIDENCE_COLS, CareerEvidence, user_id=USER) for _ in range(2)]
    db, conn = fake_db(rows, [])
    s = EvidenceStore(db)
    cid = uuid4()
    p = await s.list(USER, "SKILL", "go", page(1, Cursor(NOW, cid)))
    _, sql, args = conn.last
    assert_scoped(conn.last, USER)
    assert "user_id = $1 AND NOT archived AND kind = $2 AND (title ILIKE $3 ESCAPE '\\' OR source_text ILIKE $4 ESCAPE '\\')" in sql
    assert args == (USER, "SKILL", "%go%", "%go%", NOW, cid, 2) and p.has_more
    await s.list(USER, None, "", page())
    assert conn.last[2] == (USER, 51)


async def test_evidence_update_conflict_and_count():
    e = entity(CareerEvidence, user_id=USER)
    db, conn = fake_db("UPDATE 0", {"revision": 2}, 7)
    s = EvidenceStore(db)
    with pytest.raises(ConflictError):
        await s.update(e, 1)
    assert_scoped(conn.calls[0], USER)
    assert await s.count(USER) == 7
    assert_scoped(conn.last, USER)
    assert "NOT archived" in conn.last[1]


async def test_source_get_and_content():
    r = row(_SOURCE_COLS, Source, user_id=USER)
    db, conn = fake_db(r, {"content": memoryview(b"pdf")}, {"content": None}, None)
    s = SourceStore(db)
    assert (await s.get(USER, r["id"])).id == r["id"]
    assert_scoped(conn.last, USER)
    assert await s.content(USER, r["id"]) == b"pdf"
    assert_scoped(conn.last, USER)
    assert await s.content(USER, r["id"]) == b""
    with pytest.raises(NotFoundError):
        await s.content(USER, uuid4())
