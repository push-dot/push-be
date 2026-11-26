from __future__ import annotations

import pytest

from app.harness.approval import approval_id_for
from app.harness.policy import Tier
from app.harness.runtime import _state
from app.harness.tools import ToolContext
from push_agent.harness.tools import EMPLOYER_TOOLS

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



async def test_a_flow_write_needs_the_claimed_gate_that_showed_it():
    from push_agent.harness.graph import claim_gate_for, gate_answered

    class Db:
        def __init__(self, row):
            self.row, self.asked = row, []

        def q(self):
            return self

        async def fetchrow(self, sql, *params):
            self.asked.append((sql, params))
            return self.row

    ctx = ToolContext(user_id=COMPANY, company_id=COMPANY, conversation_id=POSTING, job_id=JOB,
                      tool_call_id="flow:send_offer:x", db=None, core=Core())
    card = "41414141-4141-4141-8141-414141414141"
    offer = {"profile_id": PROFILE, "message": "커피챗 해요"}

    claimed = Db({"id": card})
    assert await claim_gate_for(claimed, ctx, card, "send", {"offers": [offer]})
    sql, params = claimed.asked[0]
    assert "consumed_at IS NULL OR consumed_key = $4" in sql, "spent once, by this job"
    assert "tool_args->'offers' = $5::jsonb" in sql, "on exactly the offers it showed"
    assert [str(p) for p in params[:4]] == [card, POSTING, "send", JOB] and params[4] == [offer]
    assert not await claim_gate_for(Db(None), ctx, card, "send", {"offers": [offer]})

    answered = Db({"?column?": 1})
    assert await gate_answered(answered, ctx, card, "send", offer)
    sql, params = answered.asked[0]
    assert "kind = 'EMPLOYER_GATE'" in sql and "consumed_key = $4" in sql
    assert "tool_args->'offers' @> $5::jsonb" in sql and params[4] == [offer]
    assert not await gate_answered(Db(None), ctx, card, "send", offer)

    for broken in ({"conversation_id": ""}, {"job_id": ""}):
        bad = ToolContext(**{**ctx.__dict__, **broken})
        assert not await gate_answered(answered, bad, card, "send", offer), broken
        assert not await claim_gate_for(claimed, bad, card, "send", {"offers": [offer]}), broken


def test_only_the_sourcing_send_gate_turns_an_answer_into_a_card():
    import ast
    from pathlib import Path

    root = Path(__file__).parents[1] / "src/push_agent"
    found = []
    for path in root.rglob("*.py"):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        parent = {child: node for node in ast.walk(tree) for child in ast.iter_child_nodes(node)}
        for node in ast.walk(tree):
            if (isinstance(node, ast.Call) and getattr(node.func, "id", "") == "call_tool"
                    and any(k.arg == "gate" for k in node.keywords)):
                fn = parent.get(node)
                while fn is not None and not isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    fn = parent.get(fn)
                found.append((path.name, getattr(fn, "name", "")))
    assert set(found) == {("flows.py", "sc_send")}, found
