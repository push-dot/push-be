import io
import zipfile
from uuid import UUID

import httpx
import pytest

from app.rag import readers
from app.rag.readers import DOCX, docx_text, read_github, read_posting, read_source, read_web

SOURCE = UUID("55555555-5555-4555-8555-555555555555")
POSTING = UUID("66666666-6666-4666-8666-666666666666")
USER = UUID("33333333-3333-4333-8333-333333333333")
COMPANY = UUID("77777777-7777-4777-8777-777777777777")
W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'


def make_docx(body: str) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as archive:
        archive.writestr("word/document.xml", f"<w:document {W}><w:body>{body}</w:body></w:document>")
    return buf.getvalue()


class RowQuery:
    def __init__(self, row):
        self.row = row
        self.calls = []

    async def fetchrow(self, sql, *args):
        self.calls.append((sql, args))
        return self.row


def source_row(mime, content):
    return {"id": SOURCE, "user_id": USER, "mime_type": mime, "file_name": "f", "path": "p", "content": content}


def test_docx_text_joins_runs_per_paragraph_and_trims():
    data = make_docx(
        "<w:p><w:r><w:t>Hello</w:t></w:r><w:r><w:t xml:space=\"preserve\"> world</w:t></w:r></w:p>"
        "<w:p><w:r><w:t/></w:r></w:p>"
        "<w:p><w:r><w:t>끝</w:t></w:r></w:p>"
        "<w:p/>")
    assert docx_text(data) == "Hello world\n\n끝"


def test_docx_text_rejects_non_docx_archive():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as archive:
        archive.writestr("other.xml", "<x/>")
    with pytest.raises(KeyError):
        docx_text(buf.getvalue())


async def test_read_source_returns_none_for_missing_row():
    query = RowQuery(None)
    assert await read_source(query, SOURCE) is None
    assert query.calls[0][1] == (SOURCE,)
    assert "FROM sources WHERE id = $1" in query.calls[0][0]


async def test_read_source_decodes_plain_text_with_replacement():
    out = await read_source(RowQuery(source_row("text/plain", "안녕 ".encode() + b"\xff")), SOURCE)
    assert out == {"user_id": USER, "text": "안녕 �"}


async def test_read_source_handles_null_content_and_memoryview():
    assert (await read_source(RowQuery(source_row("text/markdown", None)), SOURCE))["text"] == ""
    out = await read_source(RowQuery(source_row("text/plain", memoryview(b"abc"))), SOURCE)
    assert out["text"] == "abc"


async def test_read_source_extracts_pdf_bytes(monkeypatch):
    seen = []

    def fake_extract(data):
        seen.append(data)
        return "pdf text"

    monkeypatch.setattr(readers, "extract_pdf_bytes", fake_extract)
    out = await read_source(RowQuery(source_row("application/pdf", b"%PDF-1.4")), SOURCE)
    assert out == {"user_id": USER, "text": "pdf text"}
    assert seen == [b"%PDF-1.4"]


async def test_read_source_extracts_docx():
    data = make_docx("<w:p><w:r><w:t>경력 요약</w:t></w:r></w:p>")
    out = await read_source(RowQuery(source_row(DOCX, data)), SOURCE)
    assert out["text"] == "경력 요약"


async def test_read_posting_missing_returns_none():
    assert await read_posting(RowQuery(None), POSTING) is None


@pytest.mark.parametrize("requirements, tail", [
    (["Python", "SQL"], ["Python", "SQL"]),
    ("Go", ["Go"]),
    (None, []),
    ([3, "AWS"], ["3", "AWS"]),
])
async def test_read_posting_joins_title_description_requirements(requirements, tail):
    row = {"id": POSTING, "company_id": COMPANY, "title": "Backend", "description": "Build APIs",
           "requirements": requirements}
    out = await read_posting(RowQuery(row), POSTING)
    assert out == {"company_id": COMPANY, "text": "\n".join(["Backend", "Build APIs", *tail])}


async def test_read_posting_tolerates_null_title_and_description():
    row = {"id": POSTING, "company_id": None, "title": None, "description": None, "requirements": []}
    assert await read_posting(RowQuery(row), POSTING) == {"company_id": None, "text": "\n"}


async def test_read_web_delegates_to_page_fetcher(monkeypatch):
    calls = []

    async def fetch(url):
        calls.append(url)
        return "page"

    monkeypatch.setattr(readers, "fetch_page_text", fetch)
    assert await read_web("https://example.com/a") == "page"
    assert calls == ["https://example.com/a"]


def github_client(readme=(200, "# Title\nbody"), commits=(200, None)):
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.url.path.endswith("/readme"):
            return httpx.Response(readme[0], text=readme[1])
        status, data = commits
        if data is None:
            data = [{"commit": {"message": "feat: add\n\nlong body"}}, {"commit": {"message": "fix: bug"}}]
        return httpx.Response(status, json=data)

    return httpx.AsyncClient(transport=httpx.MockTransport(handler)), seen


async def test_read_github_combines_readme_and_commit_subjects():
    client, seen = github_client()
    async with client:
        text = await read_github(client, "octo-org/my.repo_1")
    assert text == "# Title\nbody\n- feat: add\n- fix: bug"
    readme, commits = seen
    assert str(readme.url) == "https://api.github.com/repos/octo-org/my.repo_1/readme"
    assert readme.headers["accept"] == "application/vnd.github.raw+json"
    assert readme.headers["user-agent"] == "push-ingest"
    assert commits.url.path == "/repos/octo-org/my.repo_1/commits"
    assert commits.url.params["per_page"] == "20"
    assert commits.headers["accept"] == "application/vnd.github+json"
    assert "authorization" not in readme.headers


async def test_read_github_skips_failed_readme_and_commits():
    client, _ = github_client(readme=(404, "Not Found"), commits=(403, {"message": "rate limited"}))
    async with client:
        assert await read_github(client, "octo/repo") == ""


async def test_read_github_without_readme_keeps_commits_and_tolerates_missing_fields():
    client, _ = github_client(readme=(404, "nope"), commits=(200, [{"sha": "x"}, {"commit": {}}, {"commit": {"message": "ok"}}]))
    async with client:
        assert await read_github(client, "octo/repo") == "- \n- \n- ok"


@pytest.mark.parametrize("repo", [
    "", "octo", "octo/", "/repo", "a/b/c", "octo/re po", "octo/repo?x=1", "oc_to/repo",
    "o" * 40 + "/repo", "octo/" + "r" * 101, "../../users",
])
async def test_read_github_rejects_malformed_repo_without_calling_github(repo):
    client, seen = github_client()
    async with client:
        with pytest.raises(ValueError, match="owner/name"):
            await read_github(client, repo)
    assert seen == []


@pytest.mark.parametrize("repo", ["octo/repo\n", "octo/..", "octo/."])
async def test_read_github_rejects_newline_and_dot_segments(repo):
    client, seen = github_client()
    async with client:
        with pytest.raises(ValueError, match="owner/name"):
            await read_github(client, repo)
    assert seen == []


def test_docx_text_refuses_a_zip_bomb_without_inflating_it(monkeypatch):
    monkeypatch.setattr(readers, "MAX_DOCX_XML", 1000)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("word/document.xml", "<w:document " + W + ">" + " " * 100_000 + "</w:document>")
    with pytest.raises(ValueError, match="too large"):
        docx_text(buf.getvalue())


def test_docx_text_caps_inflation_when_declared_size_lies(monkeypatch):
    monkeypatch.setattr(readers, "MAX_DOCX_XML", 1000)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("word/document.xml", "<w:document " + W + ">" + " " * 100_000 + "</w:document>")
    real_getinfo = zipfile.ZipFile.getinfo

    def lying(self, name):
        info = real_getinfo(self, name)
        info.file_size = 10  # forged header
        return info

    monkeypatch.setattr(zipfile.ZipFile, "getinfo", lying)
    with pytest.raises(zipfile.BadZipFile):
        docx_text(buf.getvalue())
