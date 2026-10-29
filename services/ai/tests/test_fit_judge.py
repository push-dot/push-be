from __future__ import annotations

from uuid import UUID, uuid4

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

    def with_structured_output(self, schema, **kwargs):
        self.schema = schema
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
        return self.schema(
            tech_stack=10, experience_link=8, career_level=6, keyword=4, domain=2)


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
    assert _Scripted.last["structured"]["method"] == "function_calling"
    assert _Scripted.last["streaming"] is False
    assert _Scripted.last["model"] == levers_for("PERSONAL", "PRO", config).model
    system = _Scripted.last["messages"][0].content
    assert "35" in system and "기술 스택" in system and "도메인" in system
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


async def test_personal_fit_uses_the_posting_and_the_user_plan(monkeypatch):
    import app.harness.personal.tools as tools

    seen = {}

    async def fake_load(query, user_id, posting_id, document_id):
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


async def test_employer_fit_still_passes_free(monkeypatch):
    from app.harness.employer import tools as employer

    seen = []

    async def fake(*args, **kwargs):
        seen.append(args[4])
        return {"fitScore": 1.0, "parts": {}, "topGap": "", "plan": args[4]}

    monkeypatch.setattr(employer, "judge_fit", fake, raising=False)
    out = await employer._fit(None, employer.FitArgs(
        requirements=["Python"], content="Python"))
    assert seen == ["FREE"]
    assert out["plan"] == "FREE"


def test_reference_writer_still_receives_fit_and_part_scores():
    import inspect

    from app.domain.services.job import JobService

    source = inspect.getsource(JobService._write_reference_samples)
    assert "document_fit_score" in source
    assert "part_scores(" in source
    assert "self.samples.insert" in source
