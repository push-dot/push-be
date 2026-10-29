from __future__ import annotations

from pydantic import BaseModel

from app.harness.employer.tools import EMPLOYER_TOOLS
from app.harness.personal.tools import PERSONAL_TOOLS
from app.harness.policy import Tier
from app.harness.personal.resume.tools import RESUME_TOOLS
from app.harness.tools import ToolContext, ToolSpec
from tests.test_harness_employer import _TIERS as EMPLOYER_TIERS
from tests.test_harness_personal import _TIERS as PERSONAL_TIERS

_RESUME_TIERS = {
    "parse_attachment": Tier.READ,
    "fetch_url": Tier.READ,
    "explore_github": Tier.READ,
    "get_posting": Tier.READ,
    "compute_fit": Tier.READ,
    "save_artifact": Tier.SAFE_WRITE,
    "render_pdf": Tier.SAFE_WRITE,
    "save_to_documents": Tier.SAFE_WRITE,
}


class _Empty(BaseModel):
    pass


def test_every_tool_keeps_its_tier():
    from app.harness.tools import to_structured_tool

    groups = (
        (PERSONAL_TOOLS, PERSONAL_TIERS),
        (EMPLOYER_TOOLS, EMPLOYER_TIERS),
        (RESUME_TOOLS, _RESUME_TIERS),
    )
    for specs, expected in groups:
        got = {}
        for spec in specs:
            tool = to_structured_tool(spec)
            assert tool.args_schema is spec.args_model
            assert tool.metadata["tier"] is spec.tier
            assert tool.metadata["approval_kind"] == spec.approval_kind
            assert tool.metadata["summary"] is spec.summarize
            assert tool.description == spec.summarize(None)
            assert tool.description != spec.name.replace("_", " ")
            got[spec.name] = tool.metadata["tier"]
        assert got == expected


async def test_tool_context_comes_from_runnable_config():
    from app.harness.tools import call_structured

    seen = {}

    async def run(ctx, _args):
        seen["user_id"] = ctx.user_id
        seen["tool_call_id"] = ctx.tool_call_id
        return {"echo": True}

    spec = ToolSpec("echo", Tier.READ, _Empty, run, lambda _args: "에코해요")
    ctx = ToolContext(
        user_id="user-1",
        company_id=None,
        conversation_id="conv-1",
        job_id="job-1",
        tool_call_id="call-1",
        db=None,
        core=None,
    )
    result, ok = await call_structured(spec, _Empty(), ctx)
    assert ok is True
    assert result == {"echo": True}
    assert seen == {"user_id": "user-1", "tool_call_id": "call-1"}


def test_tool_schema_is_gone():
    import app.harness.model as model

    assert not hasattr(model, "tool_schema")
