from uuid import UUID, uuid4

import pytest

from app.db import ConflictError, NotFoundError
from app.domain.errors import DomainError
from app.domain.entities import (
    Block, Document, DocumentExport, DocumentVersion, ExportResult, ExportValidation,
    RevisionProposal,
)
from app.domain.pagination import Cursor
from app.infrastructure.store_documents import (
    _DOC_COLS, _EXPORT_COLS, _PROPOSAL_COLS, _VERSION_COLS, DocumentStore,
)
from tests.cov_fakes import NOW, USER, assert_scoped, entity, fake_db, page, row

DOC = uuid4()


async def test_document_create_get_list_update():
    d = entity(Document, user_id=USER)
    r = row(_DOC_COLS, Document, user_id=USER)
    rows = [row(_DOC_COLS, Document, user_id=USER) for _ in range(2)]
    db, conn = fake_db(None, r, rows, [], "UPDATE 0", {"revision": 9})
    s = DocumentStore(db)
    await s.create(d)
    assert conn.last[2][:2] == (d.id, USER) and len(conn.last[2]) == 13
    assert (await s.get(USER, r["id"])).id == r["id"]
    assert_scoped(conn.last, USER)
    app_id, cid = uuid4(), uuid4()
    p = await s.list(USER, app_id, "RESUME", page(1, Cursor(NOW, cid)))
    assert_scoped(conn.last, USER)
    assert "application_id = $2 AND kind = $3" in conn.last[1]
    assert conn.last[2] == (USER, app_id, "RESUME", NOW, cid, 2) and p.has_more
    await s.list(USER, None, None, page())
    assert conn.last[2] == (USER, 51)
    with pytest.raises(ConflictError):
        await s.update(d, 1)
    assert_scoped(conn.calls[-2], USER)


async def test_get_document_not_found():
    db, _ = fake_db(None)
    with pytest.raises(NotFoundError):
        await DocumentStore(db).get(USER, uuid4())


async def test_create_version_dumps_json():
    v = entity(DocumentVersion, user_id=USER, content={"a": NOW},
               blocks=[Block(id="b", text="t")])
    db, conn = fake_db()
    await DocumentStore(db).create_version(v)
    args = conn.last[2]
    assert args[5] == {"a": "2026-01-02T03:04:05Z"}
    assert args[6] == [{"id": "b", "text": "t", "evidenceRefs": [], "claimStatus": ""}]
    assert args[8]["method"] == "RULE_BASED"


async def test_get_version_with_and_without_document_filter():
    r = row(_VERSION_COLS, DocumentVersion, user_id=USER, blocks=None, quality=None)
    db, conn = fake_db(r, r, r)
    s = DocumentStore(db)
    v = await s.get_version(USER, DOC, r["id"])
    assert v.blocks == [] and v.quality.method == "RULE_BASED"
    assert conn.last[1].endswith("AND document_id = $3") and conn.last[2] == (r["id"], USER, DOC)
    assert_scoped(conn.last, USER)
    await s.get_version(USER, UUID(int=0), r["id"])
    assert "document_id = " not in conn.last[1] and conn.last[2] == (r["id"], USER)
    await s.get_version_by_id(USER, r["id"])
    assert_scoped(conn.last, USER)


async def test_list_versions_and_next_number():
    rows = [row(_VERSION_COLS, DocumentVersion, user_id=USER) for _ in range(2)]
    db, conn = fake_db(rows, DOC, 3)
    s = DocumentStore(db)
    p = await s.list_versions(USER, DOC, page(1))
    assert_scoped(conn.calls[0], USER)
    assert conn.calls[0][2] == (USER, DOC, 2) and p.has_more
    assert await s.next_version_number(DOC) == 4
    lock, mx = conn.calls[1:]
    assert lock[1] == "SELECT id FROM documents WHERE id = $1 FOR UPDATE"
    assert lock[2] == (DOC,) and "MAX(number)" in mx[1]


async def test_proposals():
    p = entity(RevisionProposal, user_id=USER)
    r = row(_PROPOSAL_COLS, RevisionProposal, user_id=USER)
    r["selection"] = {"from": 0, "to": 1, "text": "a"}
    db, conn = fake_db(None, r, None)
    s = DocumentStore(db)
    await s.create_proposal(p)
    assert conn.last[2][5] == {"from": 1, "to": 1, "text": "x"}
    got = await s.get_proposal(USER, DOC, r["id"])
    assert got.selection.from_ == 0
    assert_scoped(conn.last, USER)
    assert conn.last[2] == (r["id"], USER, DOC)
    await s.mark_proposal_applied(r["id"], NOW)
    assert conn.last[2] == (r["id"], NOW)


def _result():
    return ExportResult(sha256="s", byte_length=1,
                        validation=ExportValidation(korean_text=True, links=True, ats_text=True))


async def test_exports():
    e = entity(DocumentExport, user_id=USER)
    e2 = entity(DocumentExport, user_id=USER, result=_result())
    r = row(_EXPORT_COLS, DocumentExport, user_id=USER, blocks=None)
    rows = [row(_EXPORT_COLS, DocumentExport, user_id=USER)]
    db, conn = fake_db(None, None, r, rows, "UPDATE 1", "UPDATE 1", 1)
    s = DocumentStore(db)
    await s.create_export(e)
    assert conn.last[2][12] is None
    await s.create_export(e2)
    assert conn.last[2][12]["sha256"] == "s"
    got = await s.get_export(USER, DOC, r["id"])
    assert got.blocks == []
    assert_scoped(conn.last, USER)
    p = await s.list_exports(USER, DOC, page())
    assert_scoped(conn.last, USER)
    assert conn.last[2] == (USER, DOC, 51) and len(p.items) == 1
    await s.update_export_result(e)
    assert conn.last[2][2] is None
    assert_scoped(conn.last, USER)
    assert "status = 'READY_TO_RENDER'" in conn.last[1]
    await s.update_export_result(e2)
    assert conn.last[2][2]["byteLength"] == 1
    app_id = uuid4()
    assert await s.count_finalized_by_application(USER, app_id) == 1
    assert_scoped(conn.last, USER)


async def test_update_export_result_refuses_recorded_export():
    db, _ = fake_db("UPDATE 0")
    with pytest.raises(DomainError) as err:
        await DocumentStore(db).update_export_result(entity(DocumentExport, user_id=USER))
    assert err.value.status == 409
