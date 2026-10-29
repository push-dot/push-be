"""graphs/chat.py: resolve_context validation, link ingest, generate_reply failure, helpers.

Also holds the shared chat fakes used by test_cov2_chat_prepare/persist.
"""
from __future__ import annotations

from datetime import datetime, timezone
from types import SimpleNamespace
from uuid import UUID, uuid4

import pytest

from app.db import NotFoundError
from app.domain import entities as ent
from app.domain.errors import DomainError
from app.graphs import chat
from app.graphs.chat import bind_chat_nodes, event_sink
from tests.stubs import (StubAiUsageStore, StubDocumentStore,
                         StubEvidenceStore, StubOperationStore)

NOW = datetime(2026, 1, 2, tzinfo=timezone.utc)


def ai_dict(**over) -> dict:
    out = {"provider": "OPENAI", "model": "m", "effort": "LOW"}
    out.update(over)
    return out


def conv(user_id, **over):
    base = dict(id=uuid4(), user_id=user_id, archived=False, application_id=None,
                company_id=None, title="지원 준비", revision=1)
    base.update(over)
    return SimpleNamespace(**base)


def message(user_id, conv_id, role, text, attachments=()):
    return ent.Message(id=uuid4(), user_id=user_id, conversation_id=conv_id, role=role,
                       text=text, attachments=list(attachments), created_at=NOW)


class Query:
    """svc.db.q(): records calls; fetch/fetchrow answers come from callables."""

    def __init__(self, fetch=None, fetchrow=None):
        self._fetch = fetch or (lambda sql, args: [])
        self._fetchrow = fetchrow or (lambda sql, args: None)
        self.calls: list = []

    async def fetch(self, sql, *args):
        self.calls.append(("fetch", sql, args))
        return self._fetch(sql, args)

    async def fetchrow(self, sql, *args):
        self.calls.append(("fetchrow", sql, args))
        return self._fetchrow(sql, args)

    async def execute(self, sql, *args):
        self.calls.append(("execute", sql, args))
        return "INSERT 0 1"


class DB:
    def __init__(self, query=None, run_err=None):
        self.query = query or Query()
        self.run_err = run_err
        self.runs = 0

    def q(self):
        return self.query

    async def run(self, fn):
        self.runs += 1
        if self.run_err is not None:
            raise self.run_err
        return await fn()


class Convs:
    def __init__(self, c=None, history=(), plan="BASIC", get_err=None, update_err=None):
        self.conv = c
        self.history = list(history)  # oldest first
        self.plan = plan
        self.get_err = get_err
        self.update_err = update_err
        self.created: list = []
        self.upserted: list = []
        self.updates: list = []
        self.pages: list = []
        self.gets = 0

    async def get(self, user_id, id_):
        self.gets += 1
        if self.get_err is not None and self.gets > 1:
            raise self.get_err
        if self.conv is None or self.conv.id != id_ or self.conv.user_id != user_id:
            raise NotFoundError()
        return self.conv

    async def list_messages(self, user_id, conversation_id, page):
        self.pages.append((user_id, conversation_id, page.limit))
        return SimpleNamespace(items=list(reversed(self.history)))

    async def create_message(self, m):
        self.created.append(m)

    async def upsert_user_message(self, m):
        self.upserted.append(m)

    async def update(self, c, expected):
        if self.update_err is not None:
            raise self.update_err
        self.updates.append((c, expected))

    async def company_plan(self, company_id):
        if isinstance(self.plan, Exception):
            raise self.plan
        return self.plan


class Gate:
    """svc.ai: scripted stream rounds, company research, levers config."""

    def __init__(self, rounds=(("Hel", "lo"),), finishes=("stop",), research="", err=None):
        self.rounds = [list(r) for r in rounds]
        self.finishes = list(finishes)
        self.research_text = research
        self.err = err
        self.calls: list = []
        self.research: list = []
        self.plans: list = []

    async def stream(self, user_id, opts, system, user, usage,
                     search_query="", assistant_prefix="", job_id=None):
        from app.domain.employer_chat import current_employer_plan
        if self.err is not None:
            raise self.err
        self.calls.append({"model": opts.model, "system": system, "user": user,
                           "prefix": assistant_prefix, "job_id": job_id})
        self.plans.append(current_employer_plan())
        for tok in self.rounds.pop(0) if self.rounds else []:
            yield tok
        usage["input_tokens"] += 2
        usage["output_tokens"] += 3
        usage["finish"] = self.finishes.pop(0) if self.finishes else "stop"
        usage.setdefault("usage_ids", []).append(uuid4())

    async def company_research(self, company, model, text, user_id=None, job_id=None):
        self.research.append((company, model, text, user_id, job_id))
        return self.research_text


def make_svc(c=None, *, history=(), docs=None, ev=None, gate=None, db=None, **extra):
    svc = SimpleNamespace(
        db=db or DB(), conversations=Convs(c, history), documents=docs or StubDocumentStore(),
        evidence=ev or StubEvidenceStore(), ops=StubOperationStore(),
        usage=StubAiUsageStore(), ai=gate)
    for k, v in extra.items():
        setattr(svc, k, v)
    bind_chat_nodes(svc)
    return svc


class Sink:
    def __enter__(self):
        self.events: list = []
        self.token = event_sink.set(self.events)
        return self.events

    def __exit__(self, *exc):
        event_sink.reset(self.token)


@pytest.fixture(autouse=True)
def _isolated(monkeypatch, tmp_path):
    monkeypatch.setenv("PUSH_RESUME_DIR", str(tmp_path / "resume"))
    for name in ("BLOB_STORE", "CHAT_EXECUTOR", "LLM_STREAM", "RAG_ENGINE"):
        monkeypatch.delenv(name, raising=False)


# ---- pure helpers -------------------------------------------------------

def test_chunk_text_splits_on_paragraphs_with_overlap():
    assert chat._chunk_text("   ") == []
    para = "a" * 700 + "\n\n" + "b" * 700
    chunks = chat._chunk_text(para, size=1000, overlap=100)
    assert chunks[0] == "a" * 700
    assert chunks[1].endswith("b" * 700)
    assert "".join(chunks).count("b") >= 700


def test_stub_reply_truncates_long_text():
    out = chat.stub_reply("x" * 200)
    assert out == "(로컬 스텁) 메시지를 받았습니다: " + "x" * 80


def test_job_meta_reads_company_and_title_from_the_first_job_page():
    sections = [
        "[첨부 자료] cv\nbody",
        "[웹 페이지] https://blog.example\nno bracket here",
        "[웹 페이지] https://jobs.example/1\n[Acme] Backend Engineer | Seoul\n본문",
    ]
    company, title, url, text = chat._job_meta(sections)
    assert (company, title, url) == ("Acme", "Backend Engineer", "https://jobs.example/1")
    assert text.startswith("[Acme]")
    assert chat._company_from_pages(sections) == "Acme"
    assert chat._job_meta(["[웹 페이지] https://x\n[Acme]|pipe"])[1] == "https://x"
    assert chat._company_from_pages(["[현재 메시지]\nhi"]) == ""


def test_load_artifacts_skips_hidden_pdf_and_unreadable_entries(tmp_path, monkeypatch):
    from app.infrastructure.resume_workspace import workspace_dir
    c = conv(uuid4(), title="t")
    d = workspace_dir(c.id, "t")
    (d / "01_parsed_resume.json").write_text("{\"a\": 1}")
    (d / ".docs.json").write_text("{}")
    (d / "05_final_resume.pdf").write_bytes(b"%PDF")
    (d / "02_dir").mkdir()
    assert chat._load_artifacts(c) == ["### 01_parsed_resume.json\n{\"a\": 1}"]


# ---- resolve_context ----------------------------------------------------

def _doc(user_id, app_id=None, latest=None, title="이력서"):
    return ent.Document(id=uuid4(), user_id=user_id, application_id=app_id, title=title,
                        kind="RESUME", template="CLASSIC", latest_version_id=latest,
                        created_at=NOW, updated_at=NOW)


def _version(user_id, doc, texts=("첫 줄", "둘째 줄")):
    return ent.DocumentVersion(
        id=uuid4(), user_id=user_id, document_id=doc.id, number=1, content={},
        blocks=[ent.Block(id=str(i), text=t) for i, t in enumerate(texts)], created_at=NOW)


async def _resolve(svc, user_id, c, context, text="hi", **state):
    return await svc.chat_nodes["resolve_context"]({
        "user_id": user_id, "conversation_id": c.id, "text": text,
        "context": context, **state})


async def _error(coro) -> DomainError:
    with pytest.raises(DomainError) as e:
        await coro
    return e.value


async def test_resolve_context_hides_another_users_conversation():
    owner, other = uuid4(), uuid4()
    c = conv(owner)
    err = await _error(_resolve(make_svc(c), other, c, {}))
    assert err.code == "NOT_FOUND"


async def test_resolve_context_rejects_unknown_document():
    user_id = uuid4()
    c = conv(user_id)
    err = await _error(_resolve(make_svc(c), user_id, c, {"documentId": str(uuid4())}))
    assert (err.code, err.details) == ("VALIDATION_ERROR", {"field": "context.documentId"})


async def test_resolve_context_rejects_another_users_document():
    user_id = uuid4()
    c = conv(user_id)
    doc = _doc(uuid4())
    svc = make_svc(c, docs=StubDocumentStore(doc=doc))
    err = await _error(_resolve(svc, user_id, c, {"documentId": str(doc.id)}))
    assert err.details == {"field": "context.documentId"}


async def test_resolve_context_rejects_a_version_outside_the_document():
    user_id = uuid4()
    c = conv(user_id)
    doc = _doc(user_id)
    svc = make_svc(c, docs=StubDocumentStore(doc=doc, version=_version(user_id, _doc(user_id))))
    err = await _error(_resolve(svc, user_id, c, {
        "documentId": str(doc.id), "versionId": str(uuid4())}))
    assert (err.message, err.details) == ("version not found in document",
                                          {"field": "context.versionId"})


async def test_resolve_context_attaches_an_explicit_document_version():
    user_id = uuid4()
    c = conv(user_id)
    doc = _doc(user_id)
    version = _version(user_id, doc)
    svc = make_svc(c, docs=StubDocumentStore(doc=doc, version=version))
    out = await _resolve(svc, user_id, c, {"documentId": str(doc.id), "versionId": str(version.id)})
    att = out["attachments"][0]
    assert (att.type, att.id, att.document_id, att.title) == (
        "DOCUMENT_VERSION", version.id, doc.id, "이력서")
    assert out["context_text"] == "[첨부 문서] 이력서\n첫 줄\n둘째 줄"
    assert out["conversation"] is c


async def test_resolve_context_latest_version_read_failure_is_internal():
    user_id = uuid4()
    c = conv(user_id)
    doc = _doc(user_id, latest=uuid4())
    svc = make_svc(c, docs=StubDocumentStore(doc=doc))
    err = await _error(_resolve(svc, user_id, c, {"documentId": str(doc.id)}))
    assert err.code == "INTERNAL"


async def test_resolve_context_version_only_unknown_is_validation():
    user_id = uuid4()
    c = conv(user_id)
    err = await _error(_resolve(make_svc(c), user_id, c, {"versionId": str(uuid4())}))
    assert (err.message, err.details) == ("version not found", {"field": "context.versionId"})


async def test_resolve_context_version_only_store_failure_is_internal():
    user_id = uuid4()
    c = conv(user_id)

    class Docs(StubDocumentStore):
        async def get_version_by_id(self, user_id, version_id):
            raise RuntimeError("db down")

    err = await _error(_resolve(make_svc(c, docs=Docs()), user_id, c, {"versionId": str(uuid4())}))
    assert err.code == "INTERNAL"


async def test_resolve_context_version_only_missing_document_is_internal():
    user_id = uuid4()
    c = conv(user_id)
    version = _version(user_id, _doc(user_id))
    svc = make_svc(c, docs=StubDocumentStore(doc=None, version=version))
    err = await _error(_resolve(svc, user_id, c, {"versionId": str(version.id)}))
    assert err.code == "INTERNAL"


async def test_resolve_context_version_only_from_another_application_is_rejected():
    user_id, app_id = uuid4(), uuid4()
    c = conv(user_id, application_id=app_id)
    doc = _doc(user_id, app_id=uuid4())
    version = _version(user_id, doc)
    svc = make_svc(c, docs=StubDocumentStore(doc=doc, version=version))
    err = await _error(_resolve(svc, user_id, c, {"versionId": str(version.id)}))
    assert (err.message, err.details) == ("document belongs to another application",
                                          {"field": "context.documentId"})


async def test_resolve_context_version_only_attaches_and_applies_settings():
    user_id, app_id = uuid4(), uuid4()
    c = conv(user_id, application_id=app_id)
    doc = _doc(user_id, app_id=app_id)
    version = _version(user_id, doc, texts=("본문",))
    db = DB(Query(fetchrow=lambda sql, args: {"default_effort": "HIGH",
                                              "confirm_before_edit": False}
                  if "user_settings" in sql else None))
    svc = make_svc(c, docs=StubDocumentStore(doc=doc, version=version), db=db)
    out = await _resolve(svc, user_id, c, {"versionId": str(version.id)},
                         ai={"provider": "OPENAI", "model": "m"})
    assert out["attachments"][0].id == version.id
    assert out["context_text"] == "[첨부 문서] 이력서\n본문"
    assert out["confirm_before_edit"] is False
    assert out["ai"]["effort"] == "HIGH"
    settings = [c_ for c_ in db.query.calls if "user_settings" in c_[1]]
    assert settings[0][2] == (user_id,)


async def test_resolve_context_ingests_links_with_the_stable_user_message_id(monkeypatch):
    import app.domain.link_ingest as link_ingest
    from app.infrastructure.store_chat_jobs import user_message_id
    user_id = uuid4()
    c = conv(user_id)
    job_id = uuid4()
    seen = {}

    async def counted(query, conversation_id, exclude_id, text):
        seen["counted"] = (conversation_id, exclude_id, text)
        return True

    async def ingest(query, **kwargs):
        seen["ingest"] = kwargs

    monkeypatch.setattr(link_ingest, "older_message_counted", counted)
    monkeypatch.setattr(link_ingest, "ingest_chat_links", ingest)
    text = "참고 https://github.com/a/b"
    await _resolve(make_svc(c), user_id, c, {}, text=text, job_id=str(job_id))
    assert seen["counted"] == (c.id, user_message_id(job_id), text)
    assert seen["ingest"] == {
        "user_id": user_id, "conversation_id": c.id, "text": text, "context": {},
        "already_counted": True, "exclude_message_id": user_message_id(job_id)}


async def test_resolve_context_survives_link_ingest_failure(monkeypatch):
    import app.domain.link_ingest as link_ingest
    user_id = uuid4()
    c = conv(user_id)

    async def boom(*args, **kwargs):
        raise RuntimeError("github down")

    monkeypatch.setattr(link_ingest, "older_message_counted", boom)
    out = await _resolve(make_svc(c), user_id, c, {}, text="https://ex.com")
    assert out["attachments"] == [] and out["context_text"] == ""


# ---- generate_reply failure ----------------------------------------------

def _state(user_id, c, **over):
    base = {"user_id": user_id, "text": "안녕", "conversation": c, "context": {},
            "attachments": [], "ai": ai_dict(), "prepared": True,
            "prompt_user": "u", "prompt_system": ""}
    base.update(over)
    return base


async def test_generate_reply_failure_keeps_the_user_message_once():
    from app.infrastructure.store_chat_jobs import user_message_id
    user_id = uuid4()
    c = conv(user_id)
    job_id = uuid4()
    svc = make_svc(c, gate=Gate(err=RuntimeError("llm down")))
    with Sink(), pytest.raises(RuntimeError, match="llm down"):
        await svc.chat_nodes["generate_reply"](_state(user_id, c, job_id=str(job_id), text="질문"))
    [saved] = svc.conversations.created
    assert (saved.id, saved.role, saved.text, saved.conversation_id) == (
        user_message_id(job_id), "USER", "질문", c.id)


async def test_generate_reply_failure_raises_the_llm_error_when_saving_fails():
    user_id = uuid4()
    c = conv(user_id)
    svc = make_svc(c, gate=Gate(err=RuntimeError("llm down")), db=DB(run_err=OSError("db")))
    with Sink(), pytest.raises(RuntimeError, match="llm down"):
        await svc.chat_nodes["generate_reply"](_state(user_id, c))
    assert svc.conversations.created == []


async def test_prepare_reply_is_a_no_op_once_prepared():
    user_id = uuid4()
    c = conv(user_id)
    svc = make_svc(c)
    assert await svc.chat_nodes["prepare_reply"](_state(user_id, c)) == {}
    assert svc.conversations.pages == []


def test_stable_ids_accept_a_uuid_job_id():
    job = uuid4()
    assert chat._stable_ids(job) == chat._stable_ids(str(job))
    assert isinstance(chat._stable_ids(None)[0], UUID)
