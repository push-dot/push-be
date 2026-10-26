from uuid import uuid4

import pytest

from app.db import ConflictError, NotFoundError
from app.domain.entities import Conversation, Message, MessageAttachment
from app.domain.pagination import Cursor
from app.infrastructure.store_conversations import (
    _CONV_COLS, _MSG_COLS, ConversationStore, _artifact_item,
)
from tests.cov_fakes import NOW, OTHER, USER, assert_scoped, entity, fake_db, page, row


async def test_create_writes_company_id_last():
    c = entity(Conversation, user_id=USER, company_id=OTHER)
    db, conn = fake_db()
    await ConversationStore(db).create(c)
    assert conn.last[2][:2] == (c.id, USER) and conn.last[2][-1] == OTHER


async def test_get_allows_owner_or_company_member_only():
    r = row(_CONV_COLS, Conversation, user_id=USER)
    db, conn = fake_db(r, None)
    s = ConversationStore(db)
    assert (await s.get(USER, r["id"])).id == r["id"]
    _, sql, args = conn.last
    assert_scoped(conn.last, USER)
    assert "company_members WHERE user_id = $2" in sql and args == (r["id"], USER)
    with pytest.raises(NotFoundError):
        await s.get(OTHER, r["id"])


async def test_list_hides_archived_and_pages():
    rows = [row(_CONV_COLS, Conversation, user_id=USER) for _ in range(2)]
    db, conn = fake_db(rows, [])
    s = ConversationStore(db)
    app_id, cid = uuid4(), uuid4()
    p = await s.list(USER, app_id, page(1, Cursor(NOW, cid)))
    _, sql, args = conn.last
    assert_scoped(conn.last, USER)
    assert "archived = $2 AND application_id = $3" in sql
    assert args == (USER, False, app_id, NOW, cid, 2)
    assert p.has_more and len(p.items) == 1
    await s.list(USER, None, page())
    assert conn.last[2] == (USER, False, 51)


@pytest.mark.parametrize("plan,expected", [(None, None), ("  ", None), ("PRO", "PRO")])
async def test_company_plan(plan, expected):
    cid = uuid4()
    db, conn = fake_db({"plan": plan})
    assert await ConversationStore(db).company_plan(cid) == expected
    assert conn.last[2] == (cid,)


async def test_company_plan_missing_company():
    db, _ = fake_db(None)
    with pytest.raises(NotFoundError):
        await ConversationStore(db).company_plan(uuid4())


async def test_update_conflict_is_scoped():
    c = entity(Conversation, user_id=USER)
    db, conn = fake_db("UPDATE 0", {"revision": 5})
    with pytest.raises(ConflictError):
        await ConversationStore(db).update(c, 4)
    assert_scoped(conn.calls[0], USER)
    assert_scoped(conn.calls[1], USER)


async def test_message_writes():
    att = MessageAttachment(type="EVIDENCE", id=uuid4())
    m = entity(Message, user_id=USER, attachments=[att])
    db, conn = fake_db()
    s = ConversationStore(db)
    await s.create_message(m)
    assert "ON CONFLICT (id) DO NOTHING" in conn.last[1]
    assert conn.last[2][5] == [{"type": "EVIDENCE", "id": str(att.id)}]
    await s.upsert_user_message(m)
    assert "DO UPDATE SET attachments = EXCLUDED.attachments" in conn.last[1]
    await s.delete_unlinked_user_message(m.id)
    assert "role = 'USER' AND operation_id IS NULL" in conn.last[1]
    assert conn.last[2] == (m.id,)


async def test_list_messages_scoped_to_owner_or_company():
    r = row(_MSG_COLS, Message, user_id=USER, attachments=None)
    db, conn = fake_db([r])
    conv = uuid4()
    p = await ConversationStore(db).list_messages(USER, conv, page())
    _, sql, args = conn.last
    assert "conversation_id = $1" in sql and "(user_id = $2 OR EXISTS" in sql
    assert "m.user_id = $3 WHERE cv.id = $4" in sql
    assert args == (conv, USER, USER, conv, 51)
    assert p.items[0].attachments == []


async def test_evidence_lookups_are_scoped():
    eid = uuid4()
    conv = uuid4()
    db, conn = fake_db([{"eid": eid}], 2)
    s = ConversationStore(db)
    assert await s.evidence_ids_in(USER, conv) == [eid]
    assert_scoped(conn.last, USER)
    assert await s.evidence_refs_elsewhere(USER, conv, eid) == 2
    assert_scoped(conn.last, USER)
    assert conn.last[2] == (USER, conv, str(eid))


async def test_share_queries():
    conv = uuid4()
    db, conn = fake_db(None, {"conversation_id": conv, "title": "t"}, [{"role": "USER"}])
    s = ConversationStore(db)
    await s.put_share(conv, "h")
    assert conn.last[2] == (conv, "h")
    assert await s.share_by_hash("h") == {"conversation_id": conv, "title": "t"}
    assert await s.list_share_messages(conv) == [{"role": "USER"}]
    assert conn.last[2] == (conv,)
    inner, outer = conn.last[1].split(") recent ", 1)
    assert inner.endswith("ORDER BY created_at DESC, id DESC LIMIT 500")
    assert outer == "ORDER BY created_at ASC, id ASC"


def test_artifact_item_filters():
    did = str(uuid4())
    assert _artifact_item("nope") is None
    assert _artifact_item({"type": "EVIDENCE", "id": "e"}) is None
    assert _artifact_item({"type": "DOCUMENT_VERSION", "id": "v"}) == {
        "type": "DOCUMENT_VERSION", "id": "v", "title": ""}
    assert _artifact_item({"type": "X", "id": "v", "documentId": did, "title": "T"}) == {
        "type": "X", "id": "v", "title": "T"}
    assert _artifact_item({"type": "X", "id": "v", "document_id": did})["title"] == ""


async def test_list_artifacts_skips_bad_rows():
    rows = [
        {"id": 1, "attachments": None},
        {"id": 2, "attachments": {"not": "a list"}},
        {"id": 3, "attachments": [{"type": "EVIDENCE", "id": "e"},
                                   {"type": "DOCUMENT_VERSION", "id": "v", "title": "R"}]},
    ]
    db, conn = fake_db(rows)
    conv = uuid4()
    assert await ConversationStore(db).list_artifacts(conv) == [
        {"type": "DOCUMENT_VERSION", "id": "v", "title": "R"}]
    assert conn.last[2] == (conv,)
