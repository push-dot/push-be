"""RagStore: transactional re-embed, narrow fallback, user-first vector search."""
from uuid import uuid4

import pytest

from app.infrastructure.store_rag import EVIDENCE_SEARCH, _UNION_SEARCH, RagStore
from app.pgproto import PgError
from tests.cov_fakes import USER, assert_scoped, fake_db

SRC = uuid4()


async def test_replace_locks_source_then_deletes_and_inserts_in_tx(monkeypatch):
    db, conn = fake_db()
    entered = []
    real_do = db.do

    async def do(fn):
        entered.append(True)
        return await real_do(fn)

    monkeypatch.setattr(db, "do", do)
    await RagStore(db).replace(USER, "link", SRC, "T", [("a", [1])])
    assert entered == [True]
    assert conn.calls[0][2] == (f"rag:link:{SRC}",)
    assert "pg_advisory_xact_lock" in conn.calls[0][1]
    assert conn.calls[1][1].startswith("DELETE FROM rag_chunks")
    assert conn.calls[2][0] == "executemany"


async def test_search_falls_back_only_on_undefined_table(caplog):
    db, conn = fake_db(PgError("42P01", "no rag_chunks"), [])
    assert await RagStore(db).search(USER, [1], 2) == []
    assert conn.calls[0][1] == _UNION_SEARCH and conn.calls[1][1] == EVIDENCE_SEARCH
    assert "rag_chunks missing" in caplog.text


async def test_search_reraises_other_errors():
    db, _ = fake_db(PgError("57014", "canceled"))
    with pytest.raises(PgError):
        await RagStore(db).search(USER, [1], 2)


async def test_missing_swallows_only_undefined_table():
    db, _ = fake_db(PgError("42P01", "x"))
    assert await RagStore(db).missing("job", USER, 1) == []
    db, _ = fake_db(RuntimeError("boom"))
    with pytest.raises(RuntimeError):
        await RagStore(db).missing("job", USER, 1)


async def test_union_search_filters_user_before_ranking():
    db, conn = fake_db([])
    await RagStore(db).search(USER, [1], 2)
    sql = conn.last[1]
    assert sql.startswith("WITH mine AS MATERIALIZED (")
    head, tail = sql.split(") SELECT", 1)
    assert "UNION ALL" in head and "<=>" not in head
    assert tail.endswith("FROM mine ORDER BY dist LIMIT $3")
    assert_scoped(conn.last, USER, "c.user_id")
    assert_scoped(conn.last, USER, "r.user_id")
