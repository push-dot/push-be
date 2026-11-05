from __future__ import annotations

from app.harness.approval import tool_action_event
from app.harness.core_client import CoreClient
from app.harness.personal.resume.graph import _choice
from app.harness.registry import REGISTRY
from app.harness.tools import ToolContext


def test_review_gate_explains_the_pick_and_badges_the_recommended_template():
    choice = _choice({"conversation_id": "c", "job_id": "j"}, "review", auto=False)
    assert choice["detail"] == "템플릿을 골라 주세요. 처음이라면 클래식을 추천해요."
    assert choice["options"][0] == {"id": "CLASSIC", "label": "클래식", "badge": "추천"}
    assert all("badge" not in option for option in choice["options"][1:])


def test_applying_warns_that_it_cannot_be_undone():
    event = tool_action_event("a", "이 공고에 지원해요", "apply_to_posting", {})
    assert event["foot"] == "지원하면 취소할 수 없어요"
    assert "foot" not in tool_action_event("b", "일정을 삭제해요", "delete_calendar_event", {})


class _ActiveFlow:
    def __init__(self, resume_state):
        self.resume_state = resume_state

    def q(self):
        return self

    async def fetchrow(self, _sql, *_args):
        return {"resume_state": self.resume_state}

    async def execute(self, _sql, *_args):
        return "INSERT 1"


async def _start(resume_state) -> dict:
    tool = next(tool for tool in REGISTRY["personal"].tools if tool.name == "start_document")
    ctx = ToolContext(
        user_id="user-1",
        company_id=None,
        conversation_id="conv-1",
        job_id="job-1",
        tool_call_id="call-1",
        db=_ActiveFlow(resume_state),
        core=CoreClient("http://core.test", "secret"),
    )
    return (await tool.run(ctx, tool.args_model.model_validate({})))["choice"]


async def test_continue_choice_names_the_draft_in_progress():
    choice = await _start({"status": "active", "phase": "craft", "drafts": {"markdown": "# v1"}})
    assert choice["detail"] == "작성 중인 이력서 초안(v1)이 있어요."
    assert "detail" not in await _start({"status": "active", "phase": "intake"})
