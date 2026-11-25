from __future__ import annotations

import io
import json
from uuid import uuid4

import httpx
import pytest
from langchain_core.messages import AIMessage
from langgraph.checkpoint.memory import MemorySaver

from app.harness.personal.resume import tools as resume_tools
from app.harness.personal.resume.graph import build_resume_graph
from app.harness.personal.resume.tools import RESUME_TOOLS
from app.harness.tools import ToolContext
from tests.fakes import data_json

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
    assert seen[0] == "/users/ada/repos"
    assert "push | Python" in result["text"]


def _github_calls(monkeypatch):
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.url.path)
        if request.url.host == "raw.githubusercontent.com":
            return httpx.Response(404)
        return httpx.Response(200, json=[{"name": "api", "language": "Python"},
                                         {"name": "rapid-cache", "language": "Rust"}])

    monkeypatch.setattr(resume_tools, "GITHUB_TRANSPORT", httpx.MockTransport(handler))
    return seen


async def test_explore_github_reads_an_owner_the_user_pasted_this_turn(monkeypatch):
    seen = _github_calls(monkeypatch)
    ctx = _ctx(_Rows(), {"github": ["https://github.com/acme-labs/api"]})
    result = await _call("explore_github", ctx, {"username": "Acme-Labs"})
    assert result["username"] == "acme-labs"
    assert seen == ["/users/acme-labs/repos", "/acme-labs/api/HEAD/README.md"]


async def test_explore_github_lists_every_repo_of_the_account(monkeypatch):
    _github_calls(monkeypatch)
    ctx = _ctx(_Rows(), {"github": ["https://github.com/acme-labs"],
                         "message_text": "api 저장소는 빼줘"})
    result = await _call("explore_github", ctx, {"username": "acme-labs", "exclude": ["api"]})
    assert [row["name"] for row in result["repos"]] == ["api", "rapid-cache"]


async def test_explore_github_does_not_take_a_github_posting_page_as_the_users_account(monkeypatch):
    seen = _github_calls(monkeypatch)
    posting = "https://github.com/acme-corp/careers/blob/main/backend.md"
    ctx = _ctx(_Rows(), {"pages": {posting: "백엔드 공고"}})
    assert await _call("explore_github", ctx, {"username": "acme-corp"}) == {
        "error": "INTEGRATION_REQUIRED"}
    assert await _call("read_github", ctx, {"repo": "acme-corp/careers"}) == {
        "error": "NOT_ALLOWED"}
    assert seen == []


async def test_github_tools_tell_a_rate_limit_from_a_missing_repo(monkeypatch):
    limited = {"value": True}

    def handler(request: httpx.Request) -> httpx.Response:
        if limited["value"]:
            return httpx.Response(403, headers={"x-ratelimit-remaining": "0"})
        return httpx.Response(404)

    monkeypatch.setattr(resume_tools, "GITHUB_TRANSPORT", httpx.MockTransport(handler))
    ctx = _ctx(_Rows(), {"github": ["https://github.com/acme-labs"]})
    assert await _call("explore_github", ctx, {}) == {"error": "GITHUB_RATE_LIMITED"}
    file = {"repo": "acme-labs/api", "path": "a.py"}
    assert await _call("read_github", ctx, {"repo": "acme-labs/api"}) == {
        "error": "GITHUB_RATE_LIMITED"}
    assert await _call("read_github", ctx, file) == {"error": "GITHUB_RATE_LIMITED"}
    limited["value"] = False
    assert await _call("explore_github", ctx, {}) == {"error": "GITHUB_UNAVAILABLE"}
    assert await _call("read_github", ctx, file) == {"error": "NOT_FOUND"}


async def test_read_github_refuses_dot_repo_names_without_a_request(monkeypatch):
    seen = _github_calls(monkeypatch)
    ctx = _ctx(_Rows(), {"github": ["https://github.com/acme-labs"]})
    for repo in ("acme-labs/..", "acme-labs/.", "acme-labs/x?y=1"):
        args = {"repo": repo, "path": "a/b.txt"}
        assert await _call("read_github", ctx, args) == {"error": "INVALID_REPO"}
    assert seen == []


async def test_explore_github_never_fetches_a_username_the_user_did_not_supply(monkeypatch):
    seen = _github_calls(monkeypatch)
    ctx = _ctx(_Rows(), {"github": ["https://github.com/acme-labs"]})
    result = await _call("explore_github", ctx, {"username": "attacker"})
    assert result["username"] == "acme-labs"
    assert all("attacker" not in path for path in seen)
    assert await _call("explore_github", _ctx(_Rows(), {"pages": {"https://jobs.example/1": "x"}}),
                       {"username": "acme-labs"}) == {"error": "INTEGRATION_REQUIRED"}


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
        tool_text = data_json(messages[-1].content)["text"]
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
    assert set(model.bound) == {
        "fetch_url", "explore_github", "read_github",
        "open_page", "research_company", "get_posting", "note", "github_agent",
    }
    assert json.loads(db.files["01_parsed_resume.json"]) == {"posting": "백엔드 공고"}
    assert any(
        {"type": "tool", "name": "fetch_url", "state": "ok", "summary": "미리 읽은 페이지만 봐요", "tier": "READ"}.items()
        <= event.items() for event in events if isinstance(event, dict))


def test_resume_fit_document_id_must_be_a_uuid():
    from pydantic import ValidationError
    assert resume_tools.FitArgs.model_validate({"document_id": ""}).document_id is None
    with pytest.raises(ValidationError):
        resume_tools.FitArgs.model_validate({"document_id": "x"})


class _EvidenceRows(_Rows):
    def __init__(self, texts):
        super().__init__()
        self.texts = texts
        self.asked = None

    async def fetch(self, sql, *args):
        if "FROM career_evidence" in sql:
            self.asked = args
            return [{"source_text": text} for text in self.texts]
        return await super().fetch(sql, *args)


async def test_compute_fit_without_a_document_refuses_instead_of_scoring_zero(monkeypatch):
    async def judge(*_args, **_kwargs):
        raise AssertionError("an empty document must not be judged")

    monkeypatch.setattr(resume_tools, "judge_fit", judge)
    assert await _call("compute_fit", _ctx(_EvidenceRows([])), {"requirements": ["React"]}) == {
        "error": "NO_DOCUMENT"}


async def test_compute_fit_reads_attached_evidence_when_no_content_is_passed(monkeypatch):
    seen = {}

    async def judge(requirements, keywords, description, content, plan, **_kwargs):
        seen["content"] = content
        return {"fitScore": 7.0}

    async def no_plan(*_args):
        return None

    monkeypatch.setattr(resume_tools, "judge_fit", judge)
    monkeypatch.setattr(resume_tools, "read_plan", no_plan)
    evidence = str(uuid4())
    db = _EvidenceRows(["React 3년", "Next.js SSR"])
    ctx = _ctx(db, {"attachments": [evidence, "not-a-uuid"]})
    assert await _call("compute_fit", ctx, {"requirements": ["React"]}) == {"fitScore": 7.0}
    assert seen["content"] == "React 3년\n\nNext.js SSR"
    assert [str(item) for item in db.asked[0]] == [evidence]


async def test_final_markdown_renders_pdf_off_the_event_loop(monkeypatch):
    import threading

    import app.infrastructure.resume_workspace as workspace

    threads = []

    def md_to_pdf(body, buf):
        threads.append(threading.current_thread())
        buf.write(b"%PDF")

    class _Files:
        def q(self):
            return self

        async def execute(self, sql, *args):
            return "INSERT 1"

    monkeypatch.setattr(workspace, "md_to_pdf", md_to_pdf)
    ctx = ToolContext(user_id=USER, company_id=None, conversation_id=CONV, job_id="j",
                      tool_call_id="t", db=_Files(), core=None)
    await resume_tools.save_artifact(ctx, "05_final_resume.md", "# 이력서")
    assert threads and threads[0] is not threading.main_thread()


async def test_resume_read_tool_failure_becomes_tool_failed():
    from app.harness.personal.resume.graph import _read_tool

    class _Down:
        async def call(self, *args, **kwargs):
            raise httpx.ConnectError("core down")

    ctx = ToolContext(user_id=USER, company_id=None, conversation_id=CONV, job_id="j",
                      tool_call_id="", db=None, core=_Down())
    call = {"name": "get_posting", "id": "c1", "args": {"posting_id": str(uuid4())}}
    assert await _read_tool(call, ctx) == {"error": "TOOL_FAILED"}


def test_each_output_target_gets_its_own_body():
    from app.harness.personal.resume.graph import _bodies, phase_instructions

    state = {"output_targets": ["resume", "portfolio", "cover_letter"], "draft_version": 2}
    documents = {"portfolio": "# 포트폴리오", "cover_letter": "# 자소서"}
    output = {"markdown": "# 이력서", "documents": documents}
    assert _bodies("craft", state, output) == [
        ("03_draft_resume_v2.md", "# 이력서"),
        ("03_draft_portfolio_v2.md", "# 포트폴리오"),
        ("03_draft_cover_letter_v2.md", "# 자소서"),
    ]
    note = phase_instructions("craft", state)
    assert "documents" in note and "cover_letter" in note
    assert "documents" not in phase_instructions("craft", {"output_targets": ["resume"]})


def test_publish_falls_back_to_the_draft_of_each_target():
    from app.harness.personal.resume.graph import _bodies

    state = {
        "output_targets": ["resume", "cover_letter"],
        "drafts": {"markdown": "# 초안", "documents": {"cover_letter": "# 자소서 초안"}},
    }
    assert _bodies("publish", state, {"markdown": "# 최종"}) == [
        ("05_final_resume.md", "# 최종"),
        ("05_final_cover_letter.md", "# 자소서 초안"),
    ]


def test_later_phases_reuse_the_computed_fit_instead_of_guessing():
    from app.harness.personal.resume.graph import phase_instructions

    for phase in ("strategy", "review", "present"):
        assert "fit_from 값을 소수 첫째 자리까지 그대로" in phase_instructions(phase, {})
    assert "fit_from" not in phase_instructions("analyze", {})


class _Researcher:
    def __init__(self, text):
        self.text = text
        self.seen = []

    async def company_research(self, company, **kwargs):
        self.seen.append({"company": company, **kwargs})
        return self.text


async def test_research_company_searches_with_the_posting_and_bills_the_job():
    from types import SimpleNamespace

    from app.harness.personal.tools import bound_services

    gate = _Researcher("예시랩은 예시 클래스를 운영해요. https://examplelab.com")
    token = bound_services.set(SimpleNamespace(ai=gate))
    try:
        ctx = _ctx(_Rows(), {"pages": {"https://jobs.example/1": "예시랩 프론트엔드 공고"}})
        result = await _call("research_company", ctx, {"company": " 예시랩 "})
        assert result == {"company": "예시랩", "text": "예시랩은 예시 클래스를 운영해요. https://examplelab.com",
                          "sources": ["https://examplelab.com"]}
        assert gate.seen[0]["company"] == "예시랩"
        assert "프론트엔드 공고" in gate.seen[0]["context"]
        assert str(gate.seen[0]["user_id"]) == USER
        assert await _call("research_company", ctx, {"company": " "}) == {"error": "NO_COMPANY"}
        gate.text = ""
        assert await _call("research_company", ctx, {"company": "예시랩"}) == {
            "error": "RESEARCH_UNAVAILABLE"}
    finally:
        bound_services.reset(token)
    named = _ctx(_Rows(), {"message_text": "예시랩 지원해요"})
    assert await _call("research_company", named, {"company": "예시랩"}) == {
        "error": "RESEARCH_UNAVAILABLE"}


async def test_read_github_lists_files_then_reads_one_only_for_supplied_owners(monkeypatch):
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(str(request.url))
        if request.url.host == "api.github.com":
            return httpx.Response(200, json={"tree": [
                {"path": "package.json", "type": "blob"},
                {"path": "node_modules/x/index.js", "type": "blob"},
                {"path": "assets/logo.png", "type": "blob"},
                {"path": "src", "type": "tree"},
                {"path": "src/app.tsx", "type": "blob"},
            ]})
        return httpx.Response(200, text="export const App = () => null")

    monkeypatch.setattr(resume_tools, "GITHUB_TRANSPORT", httpx.MockTransport(handler))
    ctx = _ctx(_Rows(), {"github": ["https://github.com/acme-labs"]})
    listed = await _call("read_github", ctx, {"repo": "Acme-Labs/shop-web"})
    assert listed == {"repo": "acme-labs/shop-web", "files": ["package.json", "src/app.tsx"]}
    read = await _call("read_github", ctx, {"repo": "acme-labs/shop-web", "path": "/src/app.tsx"})
    assert read["text"] == "export const App = () => null"
    assert (read["lines"], read["from"], read["to"]) == (1, 1, 1)
    assert seen[-1] == "https://raw.githubusercontent.com/acme-labs/shop-web/HEAD/src/app.tsx"
    assert await _call("read_github", ctx, {"repo": "acme-labs/shop-web", "path": "../x"}) == {
        "error": "INVALID_PATH"}
    assert await _call("read_github", ctx, {"repo": "attacker/repo"}) == {"error": "NOT_ALLOWED"}
    assert await _call("read_github", ctx, {"repo": "nope"}) == {"error": "INVALID_REPO"}
    assert len(seen) == 2


async def test_open_page_reads_only_urls_already_seen(monkeypatch):
    from app.ingest.web_page import Page

    opened = []

    async def fake_fetch(url, *, allow_hop=None):
        opened.append(url)
        assert allow_hop(url) and not allow_hop("https://evil.example/")
        return Page(url, "예시랩 소개 https://examplelab.com/careers")

    monkeypatch.setattr(resume_tools, "fetch_page", fake_fetch)
    ctx = _ctx(_Rows(), {
        "pages": {"https://www.jobboard.com/positions/1": "회사 소개 https://www.examplelab.com/story 참고"},
        "links": ["https://tech.examplelab.com/post"],
        "github": ["https://github.com/acme-labs"],
    })
    assert await _call("open_page", ctx, {"url": "https://www.examplelab.com/story"}) == {
        "url": "https://www.examplelab.com/story", "text": "예시랩 소개 https://examplelab.com/careers"}
    assert ctx.inputs["opened_links"] == ["https://examplelab.com/careers"]
    assert (await _call("open_page", ctx, {"url": "https://examplelab.com/careers"}))["text"]
    assert (await _call("open_page", ctx, {"url": "https://tech.examplelab.com/post"}))["text"]
    # The bare origin of a seen site is fine; a path the model built on it is not.
    assert (await _call("open_page", ctx, {"url": "https://examplelab.com/"}))["text"]
    assert await _call("open_page", ctx, {"url": "https://examplelab.com/about"}) == {"error": "NOT_ALLOWED"}
    assert await _call("open_page", ctx, {"url": "https://examplelab.com/?q=secret"}) == {"error": "NOT_ALLOWED"}
    assert resume_tools._domain("story.examplelab.com") == "examplelab.com"
    assert resume_tools._domain("www.examplelab.co.kr") == "examplelab.co.kr"
    assert await _call("open_page", ctx, {"url": "https://evil.example/?q=secret"}) == {
        "error": "NOT_ALLOWED"}
    assert await _call("open_page", ctx, {"url": "https://evil.example/"}) == {"error": "NOT_ALLOWED"}
    assert await _call("open_page", ctx, {"url": "https://github.com/acme-labs"}) == {
        "error": "USE_READ_GITHUB"}
    ctx.inputs["found_links"] = ["https://blog.example.org/examplelab"]
    assert (await _call("open_page", ctx, {"url": "https://blog.example.org/examplelab"}))["text"]
    assert opened == ["https://www.examplelab.com/story", "https://examplelab.com/careers",
                      "https://tech.examplelab.com/post", "https://examplelab.com/",
                      "https://blog.example.org/examplelab"]


def test_open_page_bare_url_must_be_a_host_a_source_printed():
    seen = {"https://attacker.example.com/jobs/1"}
    for url in ("https://x.attacker.example.com/", "https://secret@attacker.example.com/",
                "https://user:pw@attacker.example.com/", "https://attacker.example.com:8443/"):
        assert not resume_tools._may_open(url, resume_tools.site_host(url), seen), url
    assert resume_tools._may_open("https://attacker.example.com/", "attacker.example.com", seen)
    seen = {"https://acme.example.com/careers/1"}
    assert resume_tools._may_open("https://www.acme.example.com/", "acme.example.com", seen)
    assert not resume_tools._may_open("https://evil.github.io/", "evil.github.io", {"https://me.github.io/a"})


async def test_research_company_sources_become_openable():
    from types import SimpleNamespace

    from app.harness.personal.tools import bound_services

    token = bound_services.set(SimpleNamespace(ai=_Researcher("출처 https://examplelab.com/about")))
    try:
        ctx = _ctx(_Rows(), {"message_text": "예시랩 이력서 써줘"})
        await _call("research_company", ctx, {"company": "예시랩"})
        assert ctx.inputs["found_links"] == ["https://examplelab.com/about"]
    finally:
        bound_services.reset(token)


async def test_research_company_only_for_a_company_the_posting_or_user_named():
    from types import SimpleNamespace

    from app.harness.personal.tools import bound_services

    gate = _Researcher("요약 https://examplelab.com/about")
    token = bound_services.set(SimpleNamespace(ai=gate))
    try:
        ctx = _ctx(_Rows(), {"pages": {"https://jobs.example/1": "백엔드 공고 https://evil.example"}})
        assert await _call("research_company", ctx, {"company": "Evil Corp"}) == {"error": "NOT_ALLOWED"}
        posted = _ctx(_Rows(), {"posting": {"company": "Example Lab Korea", "title": "백엔드"}})
        result = await _call("research_company", posted, {"company": "examplelab korea", "focus": "tech"})
        assert result["sources"] == ["https://examplelab.com/about"]
        assert gate.seen[-1]["context"].endswith("조사 초점: tech")
    finally:
        bound_services.reset(token)
    from pydantic import ValidationError
    with pytest.raises(ValidationError):
        resume_tools.CompanyArgs.model_validate({"company": "예시랩", "focus": "https://evil.example"})


async def test_explore_github_lists_repos_as_rows(monkeypatch):
    async def context(username, **_kwargs):
        return ("github.com/acme-labs 공개 레포 (2개, 최근 push 순)\n"
                "- shop-api | Python | ★3 | pushed 2026-11-20 | API | 서버\n"
                "- notes | - | ★0 | pushed 2026-01-02\n\n## shop-api README\n- not | a | row")

    monkeypatch.setattr(resume_tools, "fetch_github_context", context)
    result = await _call("explore_github", _ctx(_Rows(), {"github": ["https://github.com/acme-labs"]}), {})
    assert result["repos"] == [
        {"name": "shop-api", "language": "Python", "pushed": "2026-11-20",
         "description": "API | 서버"},
        {"name": "notes", "language": "", "pushed": "2026-01-02", "description": ""},
    ]


async def test_read_github_pages_a_long_file_and_filters_the_tree_by_folder(monkeypatch):
    body = "\n".join(f"line {index} " + "x" * 100 for index in range(200))

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "api.github.com":
            return httpx.Response(200, json={"tree": [
                {"path": "src/a.py", "type": "blob"}, {"path": "docs/b.md", "type": "blob"}]})
        return httpx.Response(200, text=body)

    monkeypatch.setattr(resume_tools, "GITHUB_TRANSPORT", httpx.MockTransport(handler))
    ctx = _ctx(_Rows(), {"github": ["https://github.com/acme-labs"]})
    assert (await _call("read_github", ctx, {"repo": "acme-labs/r", "dir": "src"}))["files"] == ["src/a.py"]
    first = await _call("read_github", ctx, {"repo": "acme-labs/r", "path": "src/a.py"})
    assert first["lines"] == 200 and first["from"] == 1 and first["to"] < 200
    second = await _call("read_github", ctx, {"repo": "acme-labs/r", "path": "src/a.py", "offset": first["to"]})
    assert second["from"] == first["to"] + 1
