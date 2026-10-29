from __future__ import annotations

from types import SimpleNamespace
from uuid import UUID, uuid4

from langchain_core.messages import AIMessage

from app.config import Config
from app.domain.plan_levers import levers_for
from app.harness.tools import ToolContext

USER = UUID("00000000-0000-4000-8000-0000000000aa")
_FIELDS = {"tech_stack", "experience_link", "career_level", "keyword", "domain"}


class _Scripted:
    def __init__(self, **kwargs):
        self.kwargs = kwargs
        self.schema = None
        self.structured = None

    def bind_tools(self, tools, **kwargs):
        self.schema = tools[0]
        self.structured = kwargs
        return self

    async def ainvoke(self, messages, config=None, **kwargs):
        _Scripted.last = {
            "messages": messages,
            "config": config,
            "schema": self.schema,
            "structured": self.structured,
            "model": self.kwargs.get("model"),
            "streaming": self.kwargs.get("streaming"),
        }
        return AIMessage(content="", tool_calls=[{
            "name": self.schema.__name__, "id": "call-fit",
            "args": {"tech_stack": 10, "experience_link": 8, "career_level": 6,
                     "keyword": 4, "domain": 2},
        }])


class _PlanDb:
    def __init__(self, plan):
        self.plan = plan

    def q(self):
        return self

    async def fetchrow(self, sql, *args):
        if "FROM users" in sql:
            return None if self.plan is None else {"plan": self.plan}
        return None


def _ctx(db):
    return ToolContext(
        user_id=str(USER), company_id=None, conversation_id=str(uuid4()),
        job_id="job-1", tool_call_id="call-1", db=db, core=None)


async def test_judge_weights_five_dimensions_from_structured_output():
    from app.framework.fit_judge import judge_fit

    config = Config()
    view = await judge_fit(
        [], ["Python"], "python service", "I use Python", "PRO",
        config=config, cls=_Scripted)
    assert set(_Scripted.last["schema"].model_fields) == _FIELDS
    assert _Scripted.last["structured"]["tool_choice"] == "auto"
    assert _Scripted.last["streaming"] is False
    assert _Scripted.last["model"] == levers_for("PERSONAL", "PRO", config).model
    system = _Scripted.last["messages"][0].content
    assert "35" in system and "기술 스택" in system and "도메인" in system
    assert "`FitDimensions` 도구를 한 번 호출" in system
    assert "python service" in _Scripted.last["messages"][1].content
    assert view["fitScore"] == 7.4
    assert view["plan"] == "PRO"
    assert view["topGap"] == "도메인"
    assert view["parts"] == {
        "techStack": 10, "experienceLink": 8, "careerLevel": 6,
        "keyword": 4, "domain": 2,
    }


async def test_judge_attaches_the_usage_callback():
    from app.framework.fit_judge import judge_fit

    store = object()
    reservation = uuid4()
    await judge_fit(
        ["Python"], [], "", "Python", "FREE",
        config=Config(), cls=_Scripted,
        usage=(store, USER, "job-1", reservation))
    callback = _Scripted.last["config"]["callbacks"][0]
    assert callback.store is store
    assert callback.reservation_id == reservation
    assert callback.user_id == USER
    assert callback.job_id == "job-1"


async def test_personal_fit_passes_the_gate_into_the_cache(monkeypatch):
    import app.harness.personal.tools as tools

    gate = SimpleNamespace(_reserve=object())
    seen = {}

    async def fake_load(query, user_id, posting_id, document_id, **kwargs):
        seen["gate"] = kwargs.get("gate")
        seen["job_id"] = kwargs.get("job_id")
        return {"fitScore": 7.4, "parts": {}, "topGap": "", "plan": "PRO"}

    monkeypatch.setattr(tools, "load_fit", fake_load, raising=False)
    token = tools.bound_services.set(SimpleNamespace(ai=gate))
    try:
        await tools._get_fit_score(_ctx(_PlanDb("PRO")), tools.FitArgs(
            posting_id=uuid4(), document_id=uuid4()))
    finally:
        tools.bound_services.reset(token)
    assert seen["gate"] is gate
    assert seen["job_id"] == "job-1"


async def test_personal_fit_uses_the_posting_and_the_user_plan(monkeypatch):
    import app.harness.personal.tools as tools

    seen = {}

    async def fake_load(query, user_id, posting_id, document_id, **kwargs):
        seen["load"] = (user_id, posting_id, document_id)
        return {
            "fitScore": 7.4,
            "parts": {
                "techStack": 10, "experienceLink": 8, "careerLevel": 6,
                "keyword": 4, "domain": 2,
            },
            "topGap": "도메인",
            "plan": "PRO",
        }

    async def fake_judge(*args, **kwargs):
        seen["plan"] = args[4]
        return {"fitScore": 1.0, "parts": {}, "topGap": "", "plan": args[4]}

    monkeypatch.setattr(tools, "load_fit", fake_load, raising=False)
    monkeypatch.setattr(tools, "judge_fit", fake_judge, raising=False)
    posting_id = uuid4()
    document_id = uuid4()
    loaded = await tools._get_fit_score(_ctx(_PlanDb("PRO")), tools.FitArgs(
        posting_id=posting_id, document_id=document_id, content="ignored"))
    inline = await tools._get_fit_score(_ctx(_PlanDb("ULTRA")), tools.FitArgs(
        requirements=["Python"], content="Python"))
    assert seen["load"] == (USER, posting_id, document_id)
    assert loaded["plan"] == "PRO"
    assert tuple(loaded["parts"]) == (
        "techStack", "experienceLink", "careerLevel", "keyword", "domain")
    assert seen["plan"] == "ULTRA"
    assert inline["plan"] == "ULTRA"


async def test_resume_fit_reads_the_user_plan(monkeypatch):
    from app.harness.personal.resume import tools as resume

    seen = []

    async def fake(*args, **kwargs):
        seen.append(args[4])
        return {"fitScore": 7.4, "parts": {}, "topGap": "", "plan": args[4]}

    monkeypatch.setattr(resume, "judge_fit", fake, raising=False)
    out = await resume._fit(_ctx(_PlanDb("PRO")), resume.FitArgs(
        requirements=["Python"], content="Python"))
    assert seen == ["PRO"]
    assert out["plan"] == "PRO"


COMPANY = UUID("00000000-0000-4000-8000-0000000000c1")
OTHER_COMPANY = UUID("00000000-0000-4000-8000-0000000000c2")
POSTING = UUID("00000000-0000-4000-8000-0000000000b2")


class _CompanyPostings:
    def __init__(self, rows):
        self.rows = rows

    def q(self):
        return self

    async def fetchrow(self, sql, *args):
        if "job_postings" not in sql or len(args) < 2:
            return None
        row = self.rows.get(args[0])
        if row is None or str(row["company_id"]) != str(args[1]):
            return None
        return row


def _employer_ctx(db, company_id):
    return ToolContext(
        user_id=str(USER), company_id=str(company_id),
        conversation_id=str(uuid4()), job_id="job-1", tool_call_id="call-1",
        db=db, core=None)


def _owned_posting(company_id=COMPANY):
    return {
        "company_id": company_id,
        "requirements": ["python service"],
        "skills": ["Python"],
        "description": "backend role",
    }


async def test_employer_basic_pro_and_ultra_pick_different_levers(monkeypatch):
    from app.config import Config
    from app.domain.employer_chat import bind_employer_plan, reset_employer_plan
    from app.domain.plan_levers import levers_for
    from app.harness.employer import tools as employer

    seen = []

    def capture(levers, **kwargs):
        seen.append(levers.model)
        return _Scripted()

    monkeypatch.setattr("app.framework.fit_judge.chat_model_for", capture)
    db = _CompanyPostings({POSTING: _owned_posting()})
    config = Config()
    expected = []
    for plan in ("BASIC", "PRO", "ULTRA"):
        expected.append(levers_for("EMPLOYER", plan, config).model)
        token = bind_employer_plan(plan)
        try:
            await employer._fit(_employer_ctx(db, COMPANY), employer.FitArgs(
                posting_id=POSTING, content="I use Python"))
        finally:
            reset_employer_plan(token)
    assert seen == expected
    assert len(set(expected)) == 3


async def test_employer_fit_rejects_another_companys_posting(monkeypatch):
    from app.domain.employer_chat import bind_employer_plan, reset_employer_plan
    from app.harness.employer import tools as employer

    seen = []

    def capture(levers, **kwargs):
        seen.append(levers.model)
        return _Scripted()

    monkeypatch.setattr("app.framework.fit_judge.chat_model_for", capture)
    db = _CompanyPostings({POSTING: _owned_posting(OTHER_COMPANY)})
    token = bind_employer_plan("PRO")
    try:
        out = await employer._fit(_employer_ctx(db, COMPANY), employer.FitArgs(
            posting_id=POSTING, content="I use Python"))
    finally:
        reset_employer_plan(token)
    assert out == {"error": "NOT_FOUND"}
    assert seen == []


def test_reference_writer_still_receives_fit_and_part_scores():
    import inspect

    from app.domain.services.job import JobService

    source = inspect.getsource(JobService._write_reference_samples)
    assert "document_fit_score" in source
    assert "part_scores(" in source
    assert "self.samples.insert" in source
