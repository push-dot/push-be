from __future__ import annotations

from datetime import datetime, timezone
from uuid import uuid4

import pytest

from app.domain import entities as ent
from app.domain.errors import REVISION_CONFLICT, DomainError
from app.domain.services.document import DocumentService, hunk_edits
from tests.stubs import FakeDB, StubDocumentStore, StubEvidenceStore


def _now():
    return datetime.now(timezone.utc)


class _Store(StubDocumentStore):
    def __init__(self, doc, version):
        super().__init__(doc, version)
        self.created = []
        self.updates = []

    async def next_version_number(self, doc_id):
        return 2

    async def create_version(self, v):
        self.created.append(v)

    async def update(self, d, expected):
        self.updates.append(expected)


def _setup(text="Python 3년 경력\n백엔드 개발"):
    user_id = uuid4()
    doc = ent.Document(
        id=uuid4(), user_id=user_id, revision=4, application_id=None, title="이력서",
        kind="RESUME", template="CLASSIC", status=ent.DOC_DRAFT,
        created_at=_now(), updated_at=_now())
    version = ent.DocumentVersion(
        id=uuid4(), user_id=user_id, document_id=doc.id, application_id=None, number=1,
        content={"type": "doc", "content": [{"type": "paragraph", "attrs": {"blockId": "b1"}, "content": [
            {"type": "text", "text": text}]}]},
        blocks=[ent.Block(id="b1", text=text)], created_at=_now())
    doc.latest_version_id = version.id
    svc = DocumentService(FakeDB(), None, None)
    svc.documents = _Store(doc, version)
    svc.evidence = StubEvidenceStore()
    return svc, user_id, doc, version


def test_hunk_edits_pairs_removed_and_added_lines():
    assert hunk_edits([
        {"line": 1, "sign": "-", "text": "3년"},
        {"line": 1, "sign": "+", "text": "4년"},
    ]) == [("3년", "4년")]
    assert hunk_edits([
        {"line": 1, "sign": "", "text": "백엔드 개발"},
        {"line": 2, "sign": "+", "text": "API 설계"},
    ]) == [("백엔드 개발", "백엔드 개발\nAPI 설계")]


async def test_apply_hunks_writes_a_new_version():
    svc, user_id, doc, version = _setup()
    _doc, created = await svc.apply_hunks(user_id, {
        "documentId": str(doc.id), "revisionId": str(version.id),
        "hunks": [{"line": 1, "sign": "-", "text": "3년"}, {"line": 1, "sign": "+", "text": "4년"}],
    })
    assert created.blocks[0].text == "Python 4년 경력\n백엔드 개발"
    assert created.content["content"][0]["content"][0]["text"] == "Python 4년 경력\n백엔드 개발"
    assert svc.documents.updates == [4]
    assert version.blocks[0].text == "Python 3년 경력\n백엔드 개발"


async def test_apply_hunks_conflict_writes_nothing():
    svc, user_id, doc, version = _setup()
    for diff in (
        {"documentId": str(doc.id), "revisionId": str(uuid4()),
         "hunks": [{"sign": "-", "text": "3년"}, {"sign": "+", "text": "4년"}]},
        {"documentId": str(doc.id), "revisionId": "",
         "hunks": [{"sign": "-", "text": "없는 문장"}, {"sign": "+", "text": "x"}]},
    ):
        with pytest.raises(DomainError) as caught:
            await svc.apply_hunks(user_id, diff)
        assert caught.value.code == REVISION_CONFLICT
    assert svc.documents.created == []
    assert svc.documents.updates == []
