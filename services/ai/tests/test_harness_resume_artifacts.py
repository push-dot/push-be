from __future__ import annotations

from types import SimpleNamespace
from uuid import UUID, uuid4

import pytest

from app.harness.personal.tools import bound_services
from app.harness.personal.resume.tools import save_artifact
from app.harness.tools import ToolContext


class _Files:
    def __init__(self):
        self.rows = {}

    def q(self):
        return self

    async def execute(self, sql, *args):
        key = (str(args[0]), args[1])
        row = self.rows.setdefault(key, {})
        if "SET body" in sql:
            row["body"] = args[2]
        elif "SET content" in sql:
            row["content"] = args[2]
        return "INSERT 1"

    async def fetchrow(self, sql, *args):
        row = self.rows.get((str(args[0]), args[1]))
        if not row or row.get("body") is None:
            return None
        return {"body": row["body"]}


class _Docs:
    def __init__(self):
        self.created = []

    async def create(self, user_id, application_id, title, kind, template, lang):
        doc = SimpleNamespace(id=uuid4(), revision=1, title=title)
        self.created.append(doc)
        return doc

    async def create_version(self, user_id, doc_id, expected, content, blocks, note):
        return SimpleNamespace(id=doc_id), SimpleNamespace(id=uuid4())


@pytest.mark.asyncio
async def test_final_resume_is_stored_in_the_database(tmp_path, monkeypatch):
    monkeypatch.setenv("PUSH_RESUME_DIR", str(tmp_path))
    events = []
    monkeypatch.setattr(
        "app.harness.tools.get_stream_writer",
        lambda: events.append,
    )
    user_id = uuid4()
    conversation_id = uuid4()
    db = _Files()
    docs = _Docs()
    token = bound_services.set(SimpleNamespace(document_svc=docs))
    ctx = ToolContext(
        user_id=str(user_id),
        company_id=None,
        conversation_id=str(conversation_id),
        job_id="job-1",
        tool_call_id="call-1",
        db=db,
        core=None,
    )
    try:
        file_id = await save_artifact(ctx, "05_final_resume.md", "# 이력서\n경력")
    finally:
        bound_services.reset(token)

    assert list(tmp_path.iterdir()) == []
    md = db.rows[(str(conversation_id), "05_final_resume.md")]
    pdf = db.rows[(str(conversation_id), "05_final_resume.pdf")]
    assert md["body"].startswith("# 이력서")
    assert pdf["content"].startswith(b"%PDF")
    assert file_id
    assert docs.created
    assert docs.created[0].id
    event = next(item for item in events if item["type"] == "file")
    assert event["name"] == "05_final_resume.md"
    assert event["mime"] == "text/markdown"
    assert event["fileId"] == file_id
    assert event["documentId"] == str(docs.created[0].id)
    assert event["downloadUrl"] == (
        f"/conversations/{conversation_id}/artifacts/05_final_resume.md"
    )
    UUID(file_id)


def test_resume_get_posting_rejects_path_ids():
    import pytest
    from pydantic import ValidationError

    from app.harness.personal.resume.tools import RESUME_TOOLS
    tool = next(tool for tool in RESUME_TOOLS if tool.name == "get_posting")
    with pytest.raises(ValidationError):
        tool.args_model.model_validate({"posting_id": "../../me/profile"})
