from __future__ import annotations

import io
import json
import logging
from types import SimpleNamespace
from uuid import UUID, uuid4

import pytest
from pypdf import PdfReader

from app.domain.content import validate_document_content
from app.infrastructure import resume_workspace as ws

CONV = UUID("12345678-0000-4000-8000-000000000001")
USER = uuid4()


@pytest.fixture
def root(tmp_path, monkeypatch):
    monkeypatch.setenv("PUSH_RESUME_DIR", str(tmp_path / "root"))
    monkeypatch.delenv("BLOB_STORE", raising=False)
    return tmp_path / "root"


# --- md_to_doc --------------------------------------------------------------------

def test_md_to_doc_builds_valid_tiptap_with_matching_blocks():
    content, blocks = ws.md_to_doc("# Kim\n\n## Career\n- Built X\n* Led Y\nplain line  \n")
    validate_document_content(content, blocks)
    assert [(n["type"], n["attrs"].get("level"), n["content"][0]["text"])
            for n in content["content"]] == [
        ("heading", 1, "Kim"), ("heading", 2, "Career"),
        ("paragraph", None, "• Built X"), ("paragraph", None, "• Led Y"),
        ("paragraph", None, "plain line")]
    assert [b.id for b in blocks] == [f"block-{i}" for i in range(1, 6)]


def test_md_to_doc_empty_input_yields_single_empty_block():
    content, blocks = ws.md_to_doc("\n\n")
    validate_document_content(content, blocks)
    assert len(blocks) == 1 and blocks[0].text == ""


# --- workspace_dir --------------------------------------------------------------------

def test_workspace_dir_is_under_root_and_keyed_by_full_id(root):
    d = ws.workspace_dir(CONV, "토스 Backend/Engineer!!")
    assert d.parent == root and d.is_dir()
    assert d.name == str(CONV)


@pytest.mark.parametrize("title", ["../../etc/passwd", "..", "/abs/path", "a\\b", ""])
def test_workspace_dir_title_cannot_escape_root(root, title):
    d = ws.workspace_dir(CONV, title)
    assert d.resolve().parent == root.resolve()


def test_workspace_dir_rejects_non_uuid_ids(root):
    with pytest.raises(ValueError):
        ws.workspace_dir("../../etc", "t")


def test_workspace_dir_survives_a_title_change(root):
    first = ws.workspace_dir(CONV, "새 채팅")
    (first / "03_resume.md").write_text("x")
    assert ws.workspace_dir(CONV, "토스 지원") == first


def test_workspace_dir_adopts_the_legacy_directory(root):
    legacy = root / "토스-지원-12345678"
    legacy.mkdir(parents=True)
    (legacy / "03_resume.md").write_text("kept")
    d = ws.workspace_dir(CONV, "토스 지원")
    assert (d / "03_resume.md").read_text() == "kept"
    assert not legacy.exists()


def test_workspace_dir_separates_conversations(root):
    assert ws.workspace_dir(uuid4(), "새 채팅") != ws.workspace_dir(uuid4(), "새 채팅")


def test_workspace_dir_isolates_conversations_sharing_id_prefix(root):
    a = UUID("abcdef01-0000-4000-8000-00000000000a")
    b = UUID("abcdef01-ffff-4fff-bfff-ffffffffffff")
    assert ws.workspace_dir(a, "새 채팅") != ws.workspace_dir(b, "새 채팅")


# --- document sync fakes ---------------------------------------------------------------

class _Docs:
    def __init__(self, fail_create: bool = False):
        self.docs: dict = {}
        self.created: list = []
        self.versions: list = []
        self.fail_create = fail_create

    async def get(self, user_id, doc_id):
        return self.docs[doc_id]

    async def create(self, user_id, application_id, title, kind, template, lang):
        if self.fail_create:
            raise RuntimeError("db down")
        doc = SimpleNamespace(id=uuid4(), revision=1, title=title)
        self.docs[doc.id] = doc
        self.created.append((title, kind, template, lang))
        return doc

    async def create_version(self, user_id, doc_id, revision, content, blocks, note):
        validate_document_content(content, blocks)
        v = SimpleNamespace(id=uuid4())
        self.versions.append((doc_id, note, blocks[0].text))
        return None, v


class _Q:
    def __init__(self, files: dict):
        self.files = files
        self.executes: list = []

    async def execute(self, sql, conv_id, name, payload):
        self.executes.append((sql, name))
        col = "content" if "SET content" in sql else "body"
        self.files.setdefault((conv_id, name), {"body": None, "content": None})[col] = payload

    async def fetchrow(self, sql, conv_id, name):
        return self.files.get((conv_id, name))

    async def fetch(self, sql, conv_id):
        return [{"name": n} for (c, n) in self.files if c == conv_id]


class _DB:
    def __init__(self):
        self.files: dict = {}
        self.query = _Q(self.files)

    def q(self):
        return self.query


def _conv(title):
    return SimpleNamespace(id=CONV, title=title)


# --- sync_documents (filesystem) ---------------------------------------------------------

async def test_sync_documents_without_document_service(root):
    assert await ws.sync_documents(SimpleNamespace(), USER, _conv("t"), ["03_resume.md"]) == []


async def test_sync_documents_creates_then_versions_documents(root):
    conv = _conv("토스 지원")
    d = ws.workspace_dir(conv.id, conv.title)
    (d / "03_resume.md").write_text("# Kim\n")
    (d / "04_cover_letter.md").write_text("Dear\n")
    (d / "02_notes.md").write_text("skip me\n")
    saved = ["03_resume.md", "04_cover_letter.md", "02_notes.md"]
    docs = _Docs()
    svc = SimpleNamespace(document_svc=docs)

    synced = await ws.sync_documents(svc, USER, conv, saved)
    assert [s["title"] for s in synced] == ["토스 지원 이력서", "토스 지원 자기소개서"]
    assert [c[1] for c in docs.created] == ["RESUME", "COVER_LETTER"]
    mapping = json.loads((ws.workspace_dir(conv.id, conv.title) / ".docs.json").read_text())
    assert set(mapping) == {"RESUME", "COVER_LETTER"}

    (ws.workspace_dir(conv.id, conv.title) / "03_resume.md").write_text("# Kim v2\n")
    again = await ws.sync_documents(svc, USER, conv, ["03_resume.md"])
    assert len(docs.created) == 2
    assert again[0]["document_id"] == UUID(mapping["RESUME"])
    assert docs.versions[-1][1:] == ("chat update 03_resume.md", "Kim v2")


@pytest.mark.parametrize("analyses,expected", [
    ([{"company": None}, {"company": {"name": "  Acme  "}}], "Acme 포트폴리오"),
    ({"company": {"name": ""}}, "생성 문서 포트폴리오"),
    (None, "생성 문서 포트폴리오"),
])
async def test_sync_documents_untitled_chat_uses_company_name(root, analyses, expected):
    conv = _conv("새 채팅")
    d = ws.workspace_dir(conv.id, conv.title)
    if analyses is not None:
        (d / "01_job_analyses.json").write_text(json.dumps(analyses))
    (d / ".docs.json").write_text("{not json")
    (d / "04_portfolio.md").write_text("work\n")
    docs = _Docs()
    synced = await ws.sync_documents(
        SimpleNamespace(document_svc=docs), USER, conv, ["04_portfolio.md"])
    assert synced[0]["title"] == expected


async def test_sync_documents_logs_failures_and_skips(root, caplog):
    conv = _conv("t")
    (ws.workspace_dir(conv.id, conv.title) / "03_resume.md").write_text("x\n")
    with caplog.at_level(logging.ERROR):
        synced = await ws.sync_documents(
            SimpleNamespace(document_svc=_Docs(fail_create=True)), USER, conv,
            ["03_resume.md"])
    assert synced == []
    assert "doc sync failed for 03_resume.md" in caplog.text
    assert not (ws.workspace_dir(conv.id, conv.title) / ".docs.json").exists()


async def test_sync_documents_routes_to_db_when_blob_store_is_db(monkeypatch):
    monkeypatch.setenv("BLOB_STORE", "db")
    db = _DB()
    db.files[(CONV, "03_resume.md")] = {"body": "# Kim\n", "content": None}
    docs = _Docs()
    synced = await ws.sync_documents(
        SimpleNamespace(db=db, document_svc=docs), USER, _conv("Job"), ["03_resume.md"])
    assert synced[0]["title"] == "Job 이력서"


async def test_sync_documents_db_flow():
    db = _DB()
    db.files[(CONV, "01_job_analyses.json")] = {
        "body": json.dumps(["bad", {"company": {"name": "Acme"}}]),
        "content": None,
    }
    db.files[(CONV, "03_resume.md")] = {"body": "# Kim\n", "content": None}
    db.files[(CONV, "02_notes.md")] = {"body": "ignored\n", "content": None}
    db.files[(CONV, ".docs.json")] = {"body": "[1, 2]", "content": None}
    docs = _Docs()
    svc = SimpleNamespace(db=db, document_svc=docs)
    conv = _conv("새 채팅")

    synced = await ws._sync_documents_db(svc, USER, conv, ["03_resume.md", "02_notes.md"])
    assert [s["title"] for s in synced] == ["Acme 이력서"]
    mapping = json.loads(db.files[(CONV, ".docs.json")]["body"])
    assert mapping == {"RESUME": str(synced[0]["document_id"])}

    db.files[(CONV, "03_resume.md")] = {"body": "# Kim v2\n", "content": None}
    writes = len(db.query.executes)
    again = await ws._sync_documents_db(svc, USER, conv, ["03_resume.md"])
    assert again[0]["document_id"] == synced[0]["document_id"]
    assert docs.versions[-1][1:] == ("chat update 03_resume.md", "Kim v2")
    assert len(db.query.executes) == writes  # mapping unchanged, not rewritten


async def test_sync_documents_db_edge_cases(caplog):
    db = _DB()
    db.files[(CONV, ".docs.json")] = {"body": "{broken", "content": None}
    db.files[(CONV, "03_resume.md")] = {"body": "x\n", "content": None}
    assert await ws._sync_documents_db(
        SimpleNamespace(db=db), USER, _conv(""), ["03_resume.md"]) == []

    docs = _Docs()
    synced = await ws._sync_documents_db(
        SimpleNamespace(db=db, document_svc=docs), USER, _conv(None), ["03_resume.md"])
    assert synced[0]["title"] == "생성 문서 이력서"

    db.files[(CONV, "01_job_analyses.json")] = {"body": "{oops", "content": None}
    assert await ws._company_label_db(db, CONV) == ""

    with caplog.at_level(logging.ERROR):
        failed = await ws._sync_documents_db(
            SimpleNamespace(db=_DB(), document_svc=_Docs(fail_create=True)), USER,
            _conv("t"), ["03_resume.md"])
    assert failed == []
    assert "doc sync failed" in caplog.text


# --- PDF rendering ------------------------------------------------------------------------

_MD = "\n".join(["# 이력서", "## 경력", "### 2024", "- 백엔드 개발", "* API 설계", "",
                 "일반 문단 " * 30] + ["줄"] * 120)


def test_md_to_pdf_reportlab_writes_file_and_paginates(tmp_path):
    out = tmp_path / "r.pdf"
    ws.md_to_pdf(_MD, out)
    assert len(PdfReader(str(out)).pages) >= 2


def test_md_to_pdf_falls_back_to_plain_writer(tmp_path, monkeypatch):
    def no_reportlab(md, out):
        raise ImportError("reportlab missing")

    monkeypatch.setattr(ws, "_md_to_pdf_reportlab", no_reportlab)
    buf = io.BytesIO()
    ws.md_to_pdf(_MD, buf)
    reader = PdfReader(io.BytesIO(buf.getvalue()))
    assert len(reader.pages) >= 2
    content = reader.pages[0].get_contents().get_data()
    assert "이력서".encode("utf-16-be").hex().upper().encode() in content

    out = tmp_path / "p.pdf"
    ws.md_to_pdf("", out)
    assert len(PdfReader(str(out)).pages) == 1


@pytest.mark.parametrize("name,kind", [
    ("04_cover_letter.md", ("COVER_LETTER", "자기소개서")),
    ("04_Portfolio.md", ("PORTFOLIO", "포트폴리오")),
    ("05_final_resume.md", ("RESUME", "이력서")),
    ("05_final_career_statement.md", ("CAREER_STATEMENT", "경력기술서")),
    ("03_misc.md", ("RESUME", "이력서")),
])
def test_kind_of_maps_file_names(name, kind):
    assert ws._kind_of(name) == kind
