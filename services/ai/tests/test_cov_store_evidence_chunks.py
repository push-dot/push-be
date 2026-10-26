from uuid import uuid4

from app.infrastructure.store_evidence_chunks import EvidenceChunkStore
from app.infrastructure.store_rag import EVIDENCE_SEARCH
from tests.cov_fakes import USER, assert_scoped, fake_db

EV = uuid4()


async def test_evidence_ids_missing_is_user_scoped():
    db, conn = fake_db([{"id": EV}])
    assert await EvidenceChunkStore(db).evidence_ids_missing(USER, 5) == [EV]
    assert_scoped(conn.last, USER, "e.user_id")
    assert conn.last[2] == (USER, 5)


async def test_replace_chunks_deletes_then_inserts_vectors():
    db, conn = fake_db()
    await EvidenceChunkStore(db).replace_chunks(USER, EV, [("a", [0.5, 1.0]), ("b", [2])])
    assert conn.calls[0] == ("execute", "SELECT pg_advisory_xact_lock(hashtext($1::text))",
                             (f"evidence:{EV}",))
    assert conn.calls[1] == ("execute",
                             "DELETE FROM evidence_chunks WHERE evidence_id=$1 AND user_id=$2",
                             (EV, USER))
    rows = conn.calls[2][2][0]
    assert [(r[1], r[2], r[3], r[4], r[5]) for r in rows] == [
        (USER, EV, 0, "a", "[0.5,1.0]"), (USER, EV, 1, "b", "[2]")]


async def test_replace_chunks_empty_only_deletes():
    db, conn = fake_db()
    await EvidenceChunkStore(db).replace_chunks(USER, EV, [])
    assert [c[1].split()[0] for c in conn.calls] == ["SELECT", "DELETE"]


async def test_search_is_user_scoped():
    db, conn = fake_db([{"text": "t", "evidence_id": EV, "title": "T", "dist": 0.1}])
    hits = await EvidenceChunkStore(db).search(USER, [1, 2.5], 3)
    assert hits == [{"text": "t", "evidence_id": EV, "title": "T", "dist": 0.1}]
    assert_scoped(conn.last, USER, "c.user_id")
    assert conn.last[2] == (USER, "[1,2.5]", 3)
    assert conn.last[1] == EVIDENCE_SEARCH
    assert conn.last[1].startswith("WITH mine AS MATERIALIZED (")
    assert conn.last[1].endswith("FROM mine ORDER BY dist LIMIT $3")


async def test_replace_chunks_runs_in_one_transaction(monkeypatch):
    db, conn = fake_db()
    entered = []
    real_do = db.do

    async def do(fn):
        entered.append(True)
        return await real_do(fn)

    monkeypatch.setattr(db, "do", do)
    await EvidenceChunkStore(db).replace_chunks(USER, EV, [("a", [1])])
    assert entered == [True] and len(conn.calls) == 3
