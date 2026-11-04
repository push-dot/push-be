from __future__ import annotations

import json
from types import SimpleNamespace
from uuid import uuid4

from app.harness.personal.tools import bound_services
from tests.test_harness_resume import _Approvals, _base, _config, _graph, _PhaseModel

_FILE = "김서준_모아페이_백엔드.pdf"
_STEM = "김서준_모아페이_백엔드"
_COMPANY = "도토리증권"
_APPLY = f"{_COMPANY}에 바로 지원하기"
_SAVED = "내 서류에 자동 저장됨"
_FILE_GATE = "내 서류에 저장했어요. 결과를 확인할까요?"
_FILE_GATE_FAILED = "내 서류에 저장하지 못했어요. 결과를 확인할까요?"
_TASK_FILE = "이력서 수정 · 올린 파일 · 경력"
_TASK_PROFILE = "프로필 수정 · Push 프로필 · 경력"
_FILE_STEPS = (
    "이력서 읽기",
    "공고 요건 정리",
    "적합도 계산",
    "경력 섹션 고치기",
    "PDF로 만들기",
)
_PROFILE_STEPS = (
    "프로필 읽기",
    "공고 요건 정리",
    "적합도 계산",
    "경력 섹션 고치기",
    "프로필에 저장",
)


class _DB(_Approvals):
    def __init__(self):
        super().__init__()
        self.calls = []

    async def execute(self, sql, *args):
        self.calls.append((sql, args))
        return await super().execute(sql, *args)


class _SourceFails(_DB):
    async def execute(self, sql, *args):
        if "INSERT INTO sources" in sql:
            raise RuntimeError("sources down")
        return await super().execute(sql, *args)


class _NoDocs:
    async def create(self, *_args, **_kwargs):
        raise RuntimeError("documents down")

    async def create_version(self, *_args, **_kwargs):
        raise RuntimeError("documents down")


class _Docs:
    def __init__(self):
        self.docs = {}
        self.versions = []

    async def create(self, doc):
        self.docs[doc.id] = doc

    async def get(self, user_id, id_):
        doc = self.docs.get(id_)
        if doc is None or doc.user_id != user_id:
            raise KeyError(id_)
        return doc

    async def update(self, doc, expected):
        self.docs[doc.id] = doc

    async def next_version_number(self, document_id):
        return 1 + sum(1 for version in self.versions if version.document_id == document_id)

    async def create_version(self, version):
        self.versions.append(version)


def _services(store):
    from app.db import NotFoundError
    from app.domain.services.document import DocumentService
    from tests.stubs import FakeDB

    class Store(_Docs):
        async def get(self, user_id, id_):
            doc = self.docs.get(id_)
            if doc is None or doc.user_id != user_id:
                raise NotFoundError()
            return doc

    docs = DocumentService(FakeDB(), None, None)
    kept = Store()
    docs.documents = kept
    return docs, kept


async def _events(graph, payload, config):
    found = []
    async for mode, chunk in graph.astream(payload, config, stream_mode=["custom", "values"]):
        if mode == "custom" and isinstance(chunk, dict):
            found.append(chunk)
    return found


def _one(events, kind):
    found = [event for event in events if event.get("type") == kind]
    assert len(found) == 1
    return found[0]


async def _present(db, store, *, document_svc=None, **extra):
    docs, kept = _services(store)
    token = bound_services.set(SimpleNamespace(document_svc=document_svc or docs))
    try:
        graph = _graph(db, model=_PhaseModel({"present": {"summary": "끝"}}))
        events = await _events(graph, _base(**extra), graph and _config())
    finally:
        bound_services.reset(token)
    return events, kept


def test_external_publish_does_not_ask_for_a_pdf():
    from app.harness.personal.resume.graph import phase_instructions

    external = phase_instructions("publish", {"inputs": {
        "attachments": [{"fileName": _FILE, "mimeType": "application/pdf"}],
    }})
    profile = phase_instructions("publish", {"inputs": {"documentId": "doc-1"}})
    assert "PDF로 만들지 묻지 않는다" in external
    assert "올린 파일" in external
    assert "올린 파일" not in profile
    assert "산출물은 Push 프로필" in profile


async def test_external_file_is_saved_and_the_card_names_the_file():
    user_id = str(uuid4())
    db = _DB()
    events, saved = await _present(
        db, None,
        phase="present",
        user_id=user_id,
        drafts={"markdown": "# 이력서\n백엔드"},
        inputs={"attachments": [{"fileName": _FILE, "mimeType": "application/pdf"}]},
    )
    result = _one(events, "result")
    todo = _one(events, "todo")
    assert result["source"] == "external"
    assert result["taskLine"] == _TASK_FILE
    assert result["checklist"] == list(_FILE_STEPS)
    assert [item["text"] for item in todo["items"]] == list(_FILE_STEPS)
    assert result["fileName"] == _FILE
    assert result["pageLine"].startswith("A4 ")
    assert result["pageLine"].endswith("KB") or result["pageLine"].endswith("MB")
    assert " · " in result["pageLine"]
    assert result["savedLine"] == _SAVED
    assert result["cardMeta"] == f"{result['pageLine']} · {_SAVED}"
    assert "company" not in result
    assert result["documentId"]
    assert result["actions"] == [
        {
            "id": "convert",
            "label": "프로필로 전환",
            "method": "POST",
            "path": f"/api/v1/documents/{result['documentId']}/profile",
        },
    ]
    assert "PDF로 만들까요" not in json.dumps(events, ensure_ascii=False)
    inserted = [call for call in db.calls if "INSERT INTO sources" in call[0]]
    assert inserted
    assert _FILE in inserted[0][1]
    assert "application/pdf" in inserted[0][1]
    doc = next(iter(saved.docs.values()))
    assert doc.kind == "HUB_PROFILE"
    assert doc.title == _STEM
    assert str(doc.id) == result["documentId"]
    assert saved.versions


async def test_profile_result_is_the_profile_card_without_a_pdf_step():
    user_id = str(uuid4())
    db = _DB()
    events, saved = await _present(
        db, None,
        phase="present",
        user_id=user_id,
        drafts={"markdown": "# 프로필\n백엔드"},
        inputs={
            "documentId": "11111111-1111-4111-8111-111111111111",
            "name": "김서준",
            "headline": "백엔드 엔지니어",
        },
    )
    result = _one(events, "result")
    todo = _one(events, "todo")
    blob = json.dumps(events, ensure_ascii=False)
    assert result["source"] == "profile"
    assert result["taskLine"] == _TASK_PROFILE
    assert result["checklist"] == list(_PROFILE_STEPS)
    assert [item["text"] for item in todo["items"]] == list(_PROFILE_STEPS)
    assert result["name"] == "김서준"
    assert result["headline"] == "백엔드 엔지니어"
    assert result["title"] == "김서준 · 백엔드 엔지니어"
    assert result["subtitle"] == "Push 프로필 · 방금 수정"
    assert "company" not in result
    assert result["actions"] == [{"id": "view", "label": "프로필 보기"}]
    assert "PDF로 만들기" not in blob
    assert "PDF로 만들까요" not in blob
    assert not any("INSERT INTO sources" in call[0] for call in db.calls)
    doc = next(iter(saved.docs.values()))
    assert doc.kind == "HUB_PROFILE"
    assert doc.title == "Push 프로필"
    assert result["documentId"] == str(doc.id)
    choice = _one(events, "choice")
    assert choice["note"] == "PDF는 Push 프로필에서 내보낼 수 있어요."
    assert any(event.get("token") == "Push 프로필에 저장하는 중…" for event in events)


def _posting(company: str) -> dict:
    return {"posting": {"company": company}}


async def test_apply_label_uses_the_posting_company():
    user_id = str(uuid4())
    events, _saved = await _present(
        _DB(), None,
        phase="present",
        user_id=user_id,
        drafts={"markdown": "# 이력서\n백엔드"},
        inputs={
            "attachments": [{"fileName": _FILE, "mimeType": "application/pdf"}],
            **_posting(_COMPANY),
        },
    )
    result = _one(events, "result")
    assert result["company"] == _COMPANY
    assert result["actions"][0] == {"id": "apply", "label": _APPLY}


async def test_result_omits_apply_when_there_is_no_posting():
    user_id = str(uuid4())
    events, _saved = await _present(
        _DB(), None,
        phase="present",
        user_id=user_id,
        drafts={"markdown": "# 이력서\n백엔드"},
        inputs={"attachments": [{"fileName": _FILE, "mimeType": "application/pdf"}]},
    )
    result = _one(events, "result")
    assert "company" not in result
    assert [action["id"] for action in result["actions"]] == ["convert"]
    blank, _kept = await _present(
        _DB(), None,
        phase="present",
        user_id=user_id,
        drafts={"markdown": "# 이력서\n백엔드"},
        inputs={
            "attachments": [{"fileName": _FILE, "mimeType": "application/pdf"}],
            "posting": {"title": "백엔드"},
        },
    )
    blank_result = _one(blank, "result")
    assert "company" not in blank_result
    assert "apply" not in [action["id"] for action in blank_result["actions"]]


async def test_failed_source_insert_does_not_claim_a_save():
    user_id = str(uuid4())
    events, _saved = await _present(
        _SourceFails(), None,
        phase="present",
        user_id=user_id,
        drafts={"markdown": "# 이력서\n백엔드"},
        inputs={"attachments": [{"fileName": _FILE, "mimeType": "application/pdf"}]},
    )
    result = _one(events, "result")
    blob = json.dumps(result, ensure_ascii=False)
    assert "savedLine" not in result
    assert _SAVED not in blob
    assert "convert" not in [action["id"] for action in result["actions"]]
    assert result["pageLine"].startswith("A4 ")


async def test_empty_document_id_omits_convert_and_view():
    user_id = str(uuid4())
    external, _saved = await _present(
        _DB(), None,
        document_svc=_NoDocs(),
        phase="present",
        user_id=user_id,
        drafts={"markdown": "# 이력서\n백엔드"},
        inputs={"attachments": [{"fileName": _FILE, "mimeType": "application/pdf"}]},
    )
    file_result = _one(external, "result")
    assert not file_result["documentId"]
    assert "convert" not in [action["id"] for action in file_result["actions"]]
    profile, _kept = await _present(
        _DB(), None,
        document_svc=_NoDocs(),
        phase="present",
        user_id=user_id,
        drafts={"markdown": "# 프로필\n백엔드"},
        inputs={"documentId": "11111111-1111-4111-8111-111111111111", "name": "김서준"},
    )
    profile_result = _one(profile, "result")
    assert not profile_result["documentId"]
    assert "view" not in [action["id"] for action in profile_result["actions"]]


async def test_external_present_title_is_the_saved_file():
    user_id = str(uuid4())
    events, _saved = await _present(
        _DB(), None,
        phase="present",
        user_id=user_id,
        drafts={"markdown": "# 이력서\n백엔드"},
        inputs={"attachments": [{"fileName": _FILE, "mimeType": "application/pdf"}]},
    )
    choice = _one(events, "choice")
    assert choice["title"] == _FILE_GATE
    assert "note" not in choice
    assert choice["options"] == [
        {"id": "done", "label": "확인했어요"},
        {"id": "cancel", "label": "그만하기"},
    ]


class _OwnedSources(_DB):
    def __init__(self, owner, source_id, file_name, mime):
        super().__init__()
        self.owner = str(owner)
        self.source_id = str(source_id)
        self.file_name = file_name
        self.mime = mime
        self.lookups = []

    async def fetchrow(self, sql, *args):
        if "FROM sources" in sql and "file_name" in sql:
            self.lookups.append((sql, tuple(str(arg) for arg in args)))
            if len(args) >= 2 and str(args[0]) == self.source_id and str(args[1]) == self.owner:
                return {"file_name": self.file_name, "mime_type": self.mime}
            return None
        return await super().fetchrow(sql, *args)


async def _uploaded(db, user_id, **inputs):
    events, _saved = await _present(
        db, None,
        phase="present",
        user_id=str(user_id),
        drafts={"markdown": "# 이력서\n백엔드"},
        inputs=inputs,
    )
    return events


async def test_uuid_pdf_source_is_external_with_its_file_name():
    owner = uuid4()
    source_id = uuid4()
    file_name = "김서준_이력서.pdf"
    db = _OwnedSources(owner, source_id, file_name, "application/pdf")
    events = await _uploaded(db, owner, attachments=[str(source_id)])
    result = _one(events, "result")
    assert result["source"] == "external"
    assert result["fileName"] == file_name
    assert len(db.lookups) == 1
    assert "user_id" in db.lookups[0][0]
    assert db.lookups[0][1] == (str(source_id), str(owner))


async def test_uuid_docx_source_is_saved_as_stem_pdf():
    owner = uuid4()
    source_id = uuid4()
    db = _OwnedSources(
        owner, source_id, "경력기술서.docx",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    )
    events = await _uploaded(db, owner, attachments=[str(source_id)])
    result = _one(events, "result")
    assert result["source"] == "external"
    assert result["fileName"] == "경력기술서.pdf"


async def test_uuid_image_source_stays_profile():
    owner = uuid4()
    source_id = uuid4()
    db = _OwnedSources(owner, source_id, "명함.png", "image/png")
    events = await _uploaded(db, owner, attachments=[str(source_id)])
    result = _one(events, "result")
    assert result["source"] == "profile"
    assert "fileName" not in result
    assert "명함.png" not in json.dumps(events, ensure_ascii=False)


async def test_other_users_source_stays_profile():
    owner = uuid4()
    stranger = uuid4()
    source_id = uuid4()
    file_name = "다른사람_이력서.pdf"
    db = _OwnedSources(owner, source_id, file_name, "application/pdf")
    events = await _uploaded(db, stranger, attachments=[str(source_id)])
    result = _one(events, "result")
    assert result["source"] == "profile"
    assert file_name not in json.dumps(events, ensure_ascii=False)
    assert db.lookups
    assert "user_id" in db.lookups[0][0]
    assert db.lookups[0][1][1] == str(stranger)
    assert db.lookups[0][1][1] != str(owner)


async def test_document_id_of_uploaded_pdf_is_external():
    owner = uuid4()
    source_id = uuid4()
    file_name = "올린이력서.pdf"
    db = _OwnedSources(owner, source_id, file_name, "application/pdf")
    events = await _uploaded(db, owner, documentId=str(source_id))
    result = _one(events, "result")
    assert result["source"] == "external"
    assert result["fileName"] == file_name
    assert db.lookups[0][1] == (str(source_id), str(owner))


async def test_failed_insert_choice_does_not_claim_the_save():
    user_id = str(uuid4())
    events, _saved = await _present(
        _SourceFails(), None,
        phase="present",
        user_id=user_id,
        drafts={"markdown": "# 이력서\n백엔드"},
        inputs={"attachments": [{"fileName": _FILE, "mimeType": "application/pdf"}]},
    )
    choice = _one(events, "choice")
    assert choice["title"] == _FILE_GATE_FAILED
    assert "note" not in choice
    assert choice["options"] == [
        {"id": "done", "label": "확인했어요"},
        {"id": "cancel", "label": "그만하기"},
    ]
