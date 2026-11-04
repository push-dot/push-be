from __future__ import annotations

import json
from uuid import uuid4

from app.harness.personal.tools import PERSONAL_TOOLS, bound_services
from app.harness.runtime import HarnessRuntime
from app.harness.tools import ToolContext
from tests.harness_fakes import USER, Rows, run, service

_FILE = "김테스트_백엔드_이력서.pdf"
_FIX = "이 이력서를 고쳐 줘"


class _Sources(Rows):
    def __init__(self, owner, source_id, file_name, mime, origin="UPLOAD"):
        super().__init__({"company_id": None, "resume_state": None})
        self.owner = str(owner)
        self.source_id = str(source_id)
        self.file_name = file_name
        self.mime = mime
        self.origin = origin
        self.queries: list = []

    async def fetchrow(self, sql, *args):
        if "FROM sources" in sql and "file_name" in sql:
            self.queries.append((sql, tuple(str(arg) for arg in args)))
            if len(args) >= 2 and str(args[0]) == self.source_id and str(args[1]) == self.owner:
                return {"file_name": self.file_name, "mime_type": self.mime}
            return None
        return await super().fetchrow(sql, *args)

    async def fetch(self, sql, *args):
        if "FROM sources" in sql:
            self.queries.append((sql, tuple(str(arg) for arg in args)))
            row = {
                "id": self.source_id,
                "file_name": self.file_name,
                "mime_type": self.mime,
                "size": 2048,
                "page_count": 2,
                "origin": self.origin,
                "created_at": "2026-11-04T01:02:03Z",
            }
            if "user_id" not in sql:
                return [row]
            if args and str(args[0]) == self.owner:
                return [row]
            return []
        return await super().fetch(sql, *args)


def _saved(rows):
    raw = rows.conversation.get("resume_state")
    if isinstance(raw, str):
        raw = json.loads(raw)
    return raw if isinstance(raw, dict) else {}


def _payload(text, source_id, **extra):
    return {
        "text": text,
        "user_id": USER,
        "conversation_id": "77777777-7777-4777-8777-777777777777",
        "job_id": "99999999-9999-4999-8999-999999999999",
        "access_mode": "AUTO",
        "ai": None,
        "context": {"evidenceIds": [str(source_id)]},
        **extra,
    }


async def test_plain_fix_request_enters_resume_flow_with_the_uploaded_pdf():
    source_id = uuid4()
    rows = _Sources(USER, source_id, _FILE, "application/pdf")
    svc = service(rows)
    items = await run(HarnessRuntime(svc), _payload(_FIX, source_id))
    saved = _saved(rows)
    assert saved.get("status") == "active"
    assert saved.get("inputs", {}).get("source") == "external"
    assert saved.get("inputs", {}).get("fileName") == _FILE
    assert saved.get("inputs", {}).get("attachments") == [str(source_id)]
    choice = next(
        chunk for mode, chunk in items if mode == "custom" and chunk.get("type") == "choice")
    assert choice["kind"] == "RESUME_GATE"
    assert choice["options"]
    assert "1." not in choice["title"]
    assert all("서류가 하나도 없어요" not in (message.text or "") for message in svc.messages)


async def test_plain_fix_request_ignores_another_users_pdf():
    source_id = uuid4()
    owner = uuid4()
    file_name = "다른사람_이력서.pdf"
    rows = _Sources(owner, source_id, file_name, "application/pdf")
    svc = service(rows)
    await run(HarnessRuntime(svc), _payload(_FIX, source_id))
    saved = _saved(rows)
    assert saved.get("inputs", {}).get("source") != "external"
    assert saved.get("inputs", {}).get("fileName") != file_name
    assert all(file_name not in (message.text or "") for message in svc.messages)
    looked = [bound for sql, bound in rows.queries if "file_name" in sql]
    assert looked
    assert all(bound[1] == str(USER) for bound in looked)


async def test_attached_pdf_without_a_fix_request_stays_with_the_agent():
    source_id = uuid4()
    rows = _Sources(USER, source_id, _FILE, "application/pdf")
    await run(HarnessRuntime(service(rows)), _payload("이 파일 뭐야", source_id))
    assert _saved(rows).get("status") != "active"


def _tool(name):
    return next(tool for tool in PERSONAL_TOOLS if tool.name == name)


async def test_list_documents_returns_uploaded_sources_and_push_documents():
    source_id = uuid4()
    rows = _Sources(USER, source_id, _FILE, "application/pdf", origin="AI")
    doc_id = uuid4()

    class Docs:
        async def list(self, user_id, application_id, kind, page):
            assert user_id == USER
            return type("Page", (), {"items": [{"id": doc_id, "title": "Push 이력서"}]})()

    ctx = ToolContext(
        user_id=str(USER), company_id=None, conversation_id=str(uuid4()),
        job_id="job-1", tool_call_id="call-1", db=rows, core=None,
    )
    token = bound_services.set(type("Svc", (), {"document_svc": Docs()})())
    try:
        tool = _tool("list_documents")
        listed = await tool.run(ctx, tool.args_model.model_validate({}))
    finally:
        bound_services.reset(token)
    ids = [item["id"] for item in listed["items"]]
    assert str(doc_id) in ids
    uploaded = [item for item in listed["items"] if item["id"] == str(source_id)]
    assert len(uploaded) == 1
    uploaded = uploaded[0]
    assert uploaded["fileName"] == _FILE
    assert uploaded["origin"] == "AI"
    assert uploaded["mimeType"] == "application/pdf"
    sql, bound = next(query for query in rows.queries if "FROM sources" in query[0])
    assert "user_id" in sql
    assert "UPLOAD" in sql and "AI" in sql
    assert "ORDER BY created_at DESC, id DESC LIMIT 50" in sql
    assert bound[0] == str(USER)


async def test_list_documents_hides_markdown():
    ctx = ToolContext(
        user_id=str(USER), company_id=None, conversation_id=str(uuid4()),
        job_id="job-1", tool_call_id="call-1", db=None, core=None,
    )
    tool = _tool("list_documents")

    class Docs:
        def __init__(self, items):
            self.items = items

        async def list(self, user_id, application_id, kind, page):
            return type("Page", (), {"items": self.items})()

    async def listed(rows, docs):
        token = bound_services.set(type("Svc", (), {"document_svc": docs})())
        try:
            ctx.db = rows
            return await tool.run(ctx, tool.args_model.model_validate({}))
        finally:
            bound_services.reset(token)

    markdown = await listed(
        _Sources(USER, uuid4(), "05_final_resume.md", "text/plain", origin="AI"),
        Docs([
            {"id": str(uuid4()), "title": "notes.md"},
            {"id": str(uuid4()), "title": "Push 이력서"},
        ]),
    )
    assert [item["title"] for item in markdown["items"]] == ["Push 이력서"]
    mime = await listed(_Sources(USER, uuid4(), "notes.txt", "text/markdown"), Docs([]))
    assert mime["items"] == []


async def test_list_documents_hides_another_users_source():
    source_id = uuid4()
    rows = _Sources(uuid4(), source_id, "다른사람_이력서.pdf", "application/pdf")
    ctx = ToolContext(
        user_id=str(USER), company_id=None, conversation_id=str(uuid4()),
        job_id="job-1", tool_call_id="call-1", db=rows, core=None,
    )
    tool = _tool("list_documents")
    listed = await tool.run(ctx, tool.args_model.model_validate({}))
    assert listed["items"] == []
    assert "다른사람_이력서.pdf" not in json.dumps(listed, ensure_ascii=False)
