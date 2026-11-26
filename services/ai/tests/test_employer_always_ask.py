from __future__ import annotations

import pytest

from app.harness.approval import approval_id_for
from push_agent.harness.tools import EMPLOYER_TOOLS
from app.harness.policy import Tier
from app.harness.runtime import _state
from app.harness.tools import ToolContext

COMPANY = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
POSTING = "21212121-2121-4121-8121-212121212121"
PROFILE = "81818181-8181-4181-8181-818181818181"
JOB = "31313131-3131-4131-8131-313131313131"


@pytest.mark.parametrize(
    ("company", "requested", "expected"),
    [
        (COMPANY, "BYPASS", "AUTO"),
        (COMPANY, "ALWAYS_ASK", "ALWAYS_ASK"),
        (COMPANY, "AUTO", "AUTO"),
        (None, "BYPASS", "BYPASS"),
    ],
)
def test_a_company_conversation_never_runs_in_bypass(company, requested, expected):
    state = _state({"access_mode": requested, "text": "공고 마감해 줘"}, {"company_id": company})
    assert state["access_mode"] == expected


class Core:
    def __init__(self):
        self.calls = []

    async def call(self, method, path, **kw):
        self.calls.append((method, path, kw))
        return {"status": "OPEN", "revision": 3} if method == "GET" else {"ok": True}


ARGS = {
    "publish_posting": {"posting_id": POSTING},
    "update_published_posting": {"posting_id": POSTING, "title": "새 제목"},
    "close_posting": {"posting_id": POSTING},
    "send_offer": {"profile_id": PROFILE, "message": "커피챗 해요"},
    "create_company_post": {"category": "work", "title": "채용 소식", "body": "함께해요"},
    "change_applicant_stage": {
        "posting_id": POSTING,
        "application_id": PROFILE,
        "stage": "REJECTED",
    },
}


async def test_every_company_write_that_reaches_outside_sends_its_card():
    risky = {tool.name for tool in EMPLOYER_TOOLS if tool.tier is Tier.RISKY_WRITE}
    assert risky == set(ARGS)
    for tool in EMPLOYER_TOOLS:
        if tool.name not in ARGS:
            continue
        core = Core()
        ctx = ToolContext(
            user_id="u",
            company_id=COMPANY,
            conversation_id="c",
            job_id=JOB,
            tool_call_id="call-1",
            db=None,
            core=core,
        )
        await tool.run(ctx, tool.args_model.model_validate(ARGS[tool.name]))
        writes = [kw for method, _path, kw in core.calls if method != "GET"]
        assert [kw["approval_id"] for kw in writes] == [approval_id_for(JOB, "call-1")], tool.name


async def test_a_flow_gate_answer_becomes_the_card_core_checks():
    from push_agent.harness.graph import record_gate_approval

    class Db:
        def __init__(self):
            self.rows = []

        def q(self):
            return self

        async def execute(self, sql, *params):
            self.rows.append((sql, params))

    db = Db()
    tool = next(t for t in EMPLOYER_TOOLS if t.name == "send_offer")
    ctx = ToolContext(
        user_id=COMPANY,
        company_id=COMPANY,
        conversation_id=POSTING,
        job_id=JOB,
        tool_call_id="flow:send_offer:x",
        db=db,
        core=Core(),
    )
    await record_gate_approval(
        db,
        ctx,
        tool,
        tool.args_model.model_validate(
            {"profileId": PROFILE, "message": "커피챗 해요", "postingId": None}
        ),
    )
    sql, params = db.rows[0]
    assert "'APPROVED','approve'" in sql
    assert str(params[0]) == approval_id_for(JOB, "flow:send_offer:x")
    assert params[5] == "send_offer"
    assert isinstance(params[6], dict), "tool_args goes in as an object, not a JSON string"
    assert {"profile_id": PROFILE, "message": "커피챗 해요"}.items() <= params[6].items()
