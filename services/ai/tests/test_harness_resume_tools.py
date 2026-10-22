from __future__ import annotations

import io
import json
from uuid import uuid4

import httpx
import pytest
from langchain_core.messages import AIMessage
from langgraph.checkpoint.memory import MemorySaver

from app.harness.resume import tools as resume_tools
from app.harness.resume.graph import build_resume_graph
from app.harness.resume.tools import RESUME_TOOLS
from app.harness.tools import ToolContext

USER = str(uuid4())
CONV = str(uuid4())


class _Rows:
    def __init__(self, evidence=None, attachment=None, links=()):
        self.evidence = evidence
        self.attachment = attachment
        self.links = list(links)
        self.files = {}

    def q(self):
        return self

    async def fetchrow(self, sql, *args):
        if "FROM career_evidence" in sql:
            return self.evidence
        if "FROM conversation_attachments" in sql:
            return self.attachment
        return None

    async def fetch(self, sql, *args):
        return [{"url": url} for url in self.links]

    async def execute(self, sql, *args):
        if "workspace_files" in sql:
            self.files[args[1]] = args[2]
        return "INSERT 1"


def _ctx(db, inputs=None):
    return ToolContext(user_id=USER, company_id=None, conversation_id=CONV, job_id="j",
                       tool_call_id="t", db=db, core=None, inputs=inputs or {})


def _tool(name):
    return next(tool for tool in RESUME_TOOLS if tool.name == name)


async def _call(name, ctx, args):
    tool = _tool(name)
    return await tool.run(ctx, tool.args_model.model_validate(args))


def _pdf(text: str) -> bytes:
    from reportlab.pdfgen import canvas
    buf = io.BytesIO()
    page = canvas.Canvas(buf)
    page.drawString(72, 720, text)
    page.save()
    return buf.getvalue()


async def test_parse_attachment_reads_evidence_then_conversation_pdfs():
    pytest.importorskip("reportlab")  # local extra; CI installs the Workers set
    evidence = {"title": "이력서", "source_text": "Python 3 years"}
    assert (await _call("parse_attachment", _ctx(_Rows(evidence=evidence)), {"attachment_id": str(uuid4())})) == {
        "title": "이력서", "text": "Python 3 years"}
    pdf = {"file_name": "cv.pdf", "mime_type": "application/pdf", "content": _pdf("Kotlin backend")}
    result = await _call("parse_attachment", _ctx(_Rows(attachment=pdf)), {"attachment_id": str(uuid4())})
    assert "Kotlin backend" in result["text"]
    assert await _call("parse_attachment", _ctx(_Rows()), {"attachment_id": str(uuid4())}) == {"error": "NOT_FOUND"}


async def test_fetch_url_only_returns_prefetched_pages():
    ctx = _ctx(_Rows(), {"pages": {"https://jobs.example/1": "백엔드 공고"}})
    assert await _call("fetch_url", ctx, {"url": "https://jobs.example/1"}) == {
        "url": "https://jobs.example/1", "text": "백엔드 공고"}
    assert await _call("fetch_url", ctx, {"url": "http://169.254.169.254/"}) == {"error": "NOT_FETCHED"}


async def test_explore_github_needs_a_linked_account(monkeypatch):
    assert await _call("explore_github", _ctx(_Rows()), {"username": "octocat"}) == {"error": "INTEGRATION_REQUIRED"}
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.url.path)
        return httpx.Response(200, json=[{"name": "push", "language": "Python", "fork": False}])

    monkeypatch.setattr(resume_tools, "GITHUB_TRANSPORT", httpx.MockTransport(handler))
    result = await _call("explore_github", _ctx(_Rows(links=["https://github.com/ada"])), {"username": "octocat"})
    assert seen == ["/users/ada/repos"]
    assert "push | Python" in result["text"]


class _ToolModel:
    def __init__(self):
        self.calls = 0
        self.bound = []

    def bind_tools(self, tools, **kwargs):
        self.bound = [tool.name for tool in tools]
        return self

    async def ainvoke(self, messages, **kwargs):
        self.calls += 1
        if self.calls == 1:
            return AIMessage(content="", tool_calls=[{
                "name": "fetch_url", "id": "f1", "type": "tool_call",
                "args": {"url": "https://jobs.example/1"}}])
        tool_text = json.loads(messages[-1].content)["text"]
        return AIMessage(content=json.dumps({"posting": tool_text}))


async def test_phase_node_calls_read_tools():
    model = _ToolModel()
    db = _Rows()
    graph = build_resume_graph(MemorySaver(), model=model, db=db)
    events = []
    async for mode, chunk in graph.astream({
        "status": "active", "phase": "analyze", "access_mode": "AUTO", "conversation_id": CONV,
        "user_id": USER, "job_id": "job-1",
        "inputs": {"pages": {"https://jobs.example/1": "백엔드 공고"}},
    }, {"configurable": {"thread_id": "t"}}, stream_mode=["custom", "values"]):
        if mode == "custom":
            events.append(chunk)
    assert set(model.bound) == {"parse_attachment", "fetch_url", "explore_github", "get_posting", "compute_fit"}
    assert json.loads(db.files["01_parsed_resume.json"]) == {"posting": "백엔드 공고"}
    assert {"type": "tool", "name": "fetch_url", "state": "ok", "summary": "미리 읽은 페이지만 봐요", "tier": "READ"} in events
