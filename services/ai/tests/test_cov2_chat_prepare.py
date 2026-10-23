"""graphs/chat.py prepare step: history, pages, GitHub, company research,
application linking, saved artifacts, employer turns, and reference lines."""
from __future__ import annotations

from types import SimpleNamespace
from uuid import uuid4

import pytest

from app.db import NotFoundError
from app.domain import entities as ent
from app.graphs.resume_prompt import _phase_prompt
from tests.test_cov2_chat_context import (DB, NOW, Gate, Query, Sink, ai_dict, conv,
                                          make_svc, message)
from tests.test_cov2_chat_context import _isolated  # noqa: F401  (autouse env fixture)


@pytest.fixture
def web(monkeypatch):
    """Patch page/GitHub fetch and RAG; returns the call log and answer tables."""
    import app.framework.rag as rag
    import app.ingest.web_page as web_page
    log = {"pages": [], "github": [], "rag": [], "page_text": {}, "gh_text": {}, "rag_out": ""}

    async def fetch_page_text(url):
        log["pages"].append(url)
        out = log["page_text"].get(url, "")
        if isinstance(out, Exception):
            raise out
        return out

    async def fetch_github_context(user):
        log["github"].append(user)
        out = log["gh_text"].get(user, "")
        if isinstance(out, Exception):
            raise out
        return out

    async def collect(svc, state, seen):
        log["rag"].append(set(seen))
        if isinstance(log["rag_out"], Exception):
            raise log["rag_out"]
        return log["rag_out"]

    monkeypatch.setattr(web_page, "fetch_page_text", fetch_page_text)
    monkeypatch.setattr(web_page, "fetch_github_context", fetch_github_context)
    monkeypatch.setattr(rag, "collect_evidence", collect)
    return log


@pytest.fixture
def refs(monkeypatch):
    """Replace ReferenceSampleStore; tests set answers on the returned dict."""
    import app.infrastructure.store_jobs as store_jobs
    cfg = {"owner": None, "context": {}, "fit": None, "samples": [], "calls": []}

    class Store:
        def __init__(self, db):
            pass

        async def application_owner(self, app_id):
            cfg["calls"].append(("owner", app_id))
            return cfg["owner"]

        async def context(self, user_id):
            cfg["calls"].append(("context", user_id))
            return cfg["context"].get(user_id)

        async def latest_fit(self, app_id):
            cfg["calls"].append(("fit", app_id))
            return cfg["fit"]

        async def list_for_prompt(self, category):
            cfg["calls"].append(("samples", category))
            return cfg["samples"]

    monkeypatch.setattr(store_jobs, "ReferenceSampleStore", Store)
    return cfg


async def _prepare(svc, state):
    with Sink() as events:
        out = await svc.chat_nodes["prepare_reply"](state)
    return out, events


def _state(user_id, c, text, **over):
    base = {"user_id": user_id, "text": text, "conversation": c, "context": {},
            "attachments": [], "ai": ai_dict()}
    base.update(over)
    return base


def _evidence(user_id, title, text="근거 본문"):
    return ent.CareerEvidence(id=uuid4(), user_id=user_id, kind="CAREER", title=title,
                              source_text=text, created_at=NOW, updated_at=NOW)


async def test_prepare_builds_the_prompt_from_context_pages_history_and_evidence(web, refs):
    from tests.stubs import StubEvidenceStore
    user_id = uuid4()
    c = conv(user_id)
    mine = _evidence(user_id, "포트폴리오", "결제 시스템")
    in_context = _evidence(user_id, "이미 첨부")
    foreign = _evidence(uuid4(), "남의 자료")
    history = [
        message(user_id, c.id, "USER", "예전 링크 https://b.example/post", [
            ent.MessageAttachment(type="EVIDENCE", id=mine.id, title="포트폴리오"),
            ent.MessageAttachment(type="EVIDENCE", id=mine.id, title="중복"),
            ent.MessageAttachment(type="EVIDENCE", id=in_context.id),
            ent.MessageAttachment(type="EVIDENCE", id=foreign.id),
            ent.MessageAttachment(type="DOCUMENT_VERSION", id=uuid4()),
        ]),
        message(user_id, c.id, "ASSISTANT", "확인했어요"),
    ]
    ev = StubEvidenceStore({e.id: e for e in (mine, in_context, foreign)})
    svc = make_svc(c, history=history, ev=ev, gate=Gate())
    web["page_text"] = {"https://a.example/job": "PAGE A",
                        "https://b.example/post": RuntimeError("timeout")}
    text = "이 링크 https://a.example/job 봐줘"
    out, events = await _prepare(svc, _state(
        user_id, c, text, context={"evidenceIds": [str(in_context.id)]},
        context_text="[첨부 문서] 이력서\n본문"))

    assert out["prompt_user"] == "\n\n".join([
        "[첨부 문서] 이력서\n본문",
        "[웹 페이지] https://a.example/job\nPAGE A",
        "[첨부 자료] 포트폴리오\n결제 시스템",
        "[이전 대화]\nUSER: 예전 링크 https://b.example/post\nASSISTANT: 확인했어요",
        "[현재 메시지]\n" + text,
    ])
    assert "남의 자료" not in out["prompt_user"]
    assert (out["prompt_system"], out["resume_flow"], out["phase"]) == ("", False, 0)
    assert sorted(web["pages"]) == ["https://a.example/job", "https://b.example/post"]
    assert {"status": "웹 페이지 읽는 중"} in events
    assert svc.conversations.pages == [(user_id, c.id, 12)]
    # RAG skips evidence already shown to the model.
    assert web["rag"][0] == {str(in_context.id), str(mine.id), str(foreign.id)}
    assert refs["calls"] == []


async def test_prepare_without_ai_skips_the_prompt(web):
    user_id = uuid4()
    c = conv(user_id)
    svc = make_svc(c)
    out, _ = await _prepare(svc, _state(user_id, c, "hi", ai=None))
    assert out == {"prepared": True, "prompt_user": "", "prompt_system": "",
                   "resume_flow": False, "phase": 0}
    assert web["rag"] == []


async def test_prepare_reraises_a_lost_claim_but_tolerates_rag_errors(web, refs):
    from app.claimctx import LostClaim
    user_id = uuid4()
    c = conv(user_id)
    svc = make_svc(c, gate=Gate())
    web["rag_out"] = LostClaim()
    with pytest.raises(LostClaim):
        await _prepare(svc, _state(user_id, c, "hi"))
    web["rag_out"] = RuntimeError("pgvector down")
    out, _ = await _prepare(svc, _state(user_id, c, "hi"))
    assert out["prompt_user"] == "[현재 메시지]\nhi"


class _Jobs:
    def __init__(self, existing=None, err=None):
        self.existing = existing
        self.err = err
        self.created: list = []
        self.lookups: list = []
        self.jobs = self

    async def find_by_source_url(self, user_id, url):
        self.lookups.append((user_id, url))
        if self.err:
            raise self.err
        return self.existing

    async def create(self, *args):
        self.created.append(args)
        return SimpleNamespace(id=uuid4())


class _Apps:
    def __init__(self, existing=None):
        self.existing = existing
        self.created: list = []
        self.lookups: list = []
        self.applications = self

    async def find_by_job(self, user_id, job_id):
        self.lookups.append((user_id, job_id))
        return self.existing

    async def create(self, user_id, job_id, notes):
        self.created.append((user_id, job_id, notes))
        return SimpleNamespace(id=uuid4())


JOB_URL = "https://jobs.example/1"
JOB_PAGE = "[Acme] Backend Engineer | Seoul\n주요 업무"


async def test_ultra_resume_adds_github_and_company_research_and_links_an_application(web, refs):
    user_id = uuid4()
    c = conv(user_id, title="")
    gate = Gate(research="Acme는 결제 회사")
    jobs, apps = _Jobs(), _Apps()
    svc = make_svc(c, gate=gate, job_svc=jobs, application_svc=apps)
    web["page_text"] = {JOB_URL: JOB_PAGE}
    web["gh_text"] = {"alice": "alice/repo ★10", "bob": RuntimeError("rate limited")}
    text = f"이력서 만들어줘 {JOB_URL} github.com/alice github.com/Bob github.com/alice"
    out, events = await _prepare(svc, _state(
        user_id, c, text, job_id="job-9",
        ai=ai_dict(ultraResume=True, models={"research": "research-model"})))

    assert out["resume_flow"] is True and out["phase"] == 0
    assert out["prompt_system"] == _phase_prompt(0)
    assert "[GitHub] alice/repo ★10" in out["prompt_user"]
    assert "[회사 검색] Acme\nAcme는 결제 회사" in out["prompt_user"]
    assert web["github"] == ["alice", "bob"]
    company, model, research_text, uid, job_id = gate.research[0]
    assert (company, model, uid, job_id) == ("Acme", "research-model", user_id, "job-9")
    assert research_text.startswith(text + "\n[웹 페이지] " + JOB_URL)
    for status in ("GitHub 저장소 조회 중", "회사 정보 검색 중", "지원 항목 연결됨"):
        assert {"status": status} in events
    # The job page became a job + application owned by this user.
    assert jobs.lookups == [(user_id, JOB_URL)]
    (j_user, j_company, j_title, j_kind, j_url, j_text, *_rest, j_lang) = jobs.created[0]
    assert (j_user, j_company, j_title, j_kind, j_url, j_lang) == (
        user_id, "Acme", "Backend Engineer", "URL", JOB_URL, "ko")
    assert j_text == JOB_PAGE
    assert apps.created[0][0] == user_id
    assert c.application_id is not None
    assert svc.conversations.updates == [(c, 1)]
    assert out["conversation"] is c


async def test_resume_links_to_an_existing_job_and_application(web, refs):
    user_id = uuid4()
    c = conv(user_id)
    existing_app = SimpleNamespace(id=uuid4())
    jobs, apps = _Jobs(existing=SimpleNamespace(id=uuid4())), _Apps(existing=existing_app)
    svc = make_svc(c, gate=Gate(research=""), job_svc=jobs, application_svc=apps)
    web["page_text"] = {JOB_URL: JOB_PAGE}
    out, events = await _prepare(svc, _state(user_id, c, f"자소서 {JOB_URL}",
                                             ai=ai_dict(ultraResume=True)))
    assert jobs.created == [] and apps.created == []
    assert c.application_id == existing_app.id
    assert "[회사 검색]" not in out["prompt_user"]


async def test_resume_application_link_failure_leaves_the_conversation_unlinked(web, refs):
    user_id = uuid4()
    c = conv(user_id)
    jobs = _Jobs(err=RuntimeError("db down"))
    svc = make_svc(c, gate=Gate(), job_svc=jobs, application_svc=_Apps())
    web["page_text"] = {JOB_URL: JOB_PAGE}
    out, events = await _prepare(svc, _state(user_id, c, f"이력서 {JOB_URL}"))
    assert c.application_id is None
    assert {"status": "지원 항목 연결됨"} not in events
    assert out["prepared"] is True
    assert web["github"] == []


async def test_resume_flow_reads_saved_workspace_artifacts(web, refs):
    from app.infrastructure.resume_workspace import workspace_dir
    user_id = uuid4()
    c = conv(user_id, title="토스 지원")
    d = workspace_dir(c.id, "토스 지원")
    (d / "01_parsed_resume.json").write_text("{\"name\": \"kim\"}")
    (d / ".docs.json").write_text("{}")
    svc = make_svc(c, gate=Gate())
    out, _ = await _prepare(svc, _state(user_id, c, "이력서 계속"))
    assert out["phase"] == 2
    assert out["prompt_system"] == _phase_prompt(2)
    assert out["prompt_user"].endswith("### 01_parsed_resume.json\n{\"name\": \"kim\"}")
    assert ".docs.json" not in out["prompt_user"]
    assert "[저장된 산출물" in out["prompt_user"]


async def test_resume_flow_reads_artifacts_from_the_db_blob_store(web, refs, monkeypatch):
    monkeypatch.setenv("BLOB_STORE", "db")
    user_id = uuid4()
    c = conv(user_id)
    bodies = {"02_strategy.md": "전략", "03_empty.md": None}
    q = Query(
        fetch=lambda sql, args: [{"name": n} for n in
                                 ("02_strategy.md", "03_empty.md", ".docs.json", "resume.pdf")]
        if "workspace_files" in sql else [],
        fetchrow=lambda sql, args: {"body": bodies.get(args[1])}
        if "workspace_files" in sql else None)
    svc = make_svc(c, gate=Gate(), db=DB(q))
    out, _ = await _prepare(svc, _state(user_id, c, "포트폴리오 다듬기"))
    assert out["phase"] == 4
    assert "### 02_strategy.md\n전략" in out["prompt_user"]
    assert "03_empty.md" not in out["prompt_user"]
    read = [c_[2][1] for c_ in q.calls if c_[0] == "fetchrow" and "workspace_files" in c_[1]]
    assert sorted(read) == ["02_strategy.md", "03_empty.md"]
    assert all(c_[2][0] == c.id for c_ in q.calls if "workspace_files" in c_[1])


async def test_resume_flow_without_artifacts_keeps_the_prompt_short(web, refs, monkeypatch):
    monkeypatch.setenv("BLOB_STORE", "db")
    user_id = uuid4()
    c = conv(user_id)
    svc = make_svc(c, gate=Gate())
    out, _ = await _prepare(svc, _state(user_id, c, "이력서"))
    assert out["prompt_user"] == "[현재 메시지]\n이력서"


async def test_employer_turn_without_a_company_plan_uses_default_levers(web, refs):
    from app.config import load_config
    from app.domain.plan_levers import levers_for
    user_id = uuid4()
    c = conv(user_id, company_id=uuid4())
    svc = make_svc(c, gate=Gate())
    svc.conversations.plan = NotFoundError()
    out, _ = await _prepare(svc, _state(user_id, c, "지원자 요약", intent="general"))
    levers = levers_for("EMPLOYER", None, load_config())
    assert out["employer_owned"] is True and out["company_plan"] == ""
    assert (out["ai"]["model"], out["ai"]["effort"]) == (levers.model, levers.effort)
    assert out["ai"]["webSearch"] is False


async def test_employer_turn_uses_gate_levers_config(web, refs):
    from app.config import load_config
    from app.domain.plan_levers import levers_for
    user_id = uuid4()
    c = conv(user_id, company_id=uuid4())
    gate = Gate()
    cfg = load_config()
    gate._levers_config = lambda: cfg
    svc = make_svc(c, gate=gate)
    svc.conversations.plan = "PRO"
    out, _ = await _prepare(svc, _state(user_id, c, "공고", ai=None, intent="posting"))
    assert out["ai"]["model"] == levers_for("EMPLOYER", "PRO", cfg).model
    assert out["company_plan"] == "PRO"
    assert "```posting-draft" in out["prompt_system"]


@pytest.mark.parametrize(("setup", "expected_calls"), [
    ({"app": False}, []),
    ({"app": True, "owner": None}, ["owner"]),
    ({"app": True, "owner": "applicant", "context": None}, ["owner", "context"]),
    ({"app": True, "owner": "applicant", "context": {"job_category": None, "tenure_years": 3}},
     ["owner", "context", "fit"]),
])
async def test_employer_review_reference_lines_stop_when_data_is_missing(
        web, refs, setup, expected_calls):
    user_id, applicant = uuid4(), uuid4()
    c = conv(user_id, company_id=uuid4())
    svc = make_svc(c, gate=Gate())
    refs["owner"] = applicant if setup.get("owner") else None
    if setup.get("context") is not None:
        refs["context"] = {applicant: setup["context"]}
    state = _state(user_id, c, "지원자 검토", intent="review")
    if setup["app"]:
        state["application_id"] = uuid4()
    out, _ = await _prepare(svc, state)
    assert [call[0] for call in refs["calls"]] == expected_calls
    assert "건 수치" not in out["prompt_system"]


@pytest.mark.parametrize(("context", "expected_calls"), [
    (None, ["context"]),
    ({"job_category": "dev", "tenure_years": None}, ["context"]),
])
async def test_personal_reference_lines_need_a_full_profile(web, refs, context, expected_calls):
    user_id = uuid4()
    c = conv(user_id)
    if context is not None:
        refs["context"] = {user_id: context}
    svc = make_svc(c, gate=Gate())
    out, _ = await _prepare(svc, _state(user_id, c, "이력서 써줘"))
    assert [call[0] for call in refs["calls"]] == expected_calls
    assert refs["calls"][0][1] == user_id
    assert out["prompt_system"] == _phase_prompt(0)
