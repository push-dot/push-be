from __future__ import annotations

from app.harness.approval import tool_action_event
from app.harness.core_client import CoreClient
from app.harness.personal.resume.graph import _choice
from app.harness.registry import REGISTRY
from app.harness.tools import ToolContext


def test_review_choice_has_template_and_photo_sections():
    choice = _choice({"conversation_id": "c", "job_id": "j"}, "review", auto=False)
    assert choice["sections"][0]["kind"] == "thumbnails"
    assert [item["id"] for item in choice["sections"][0]["options"]] == [
        "CLASSIC",
        "MODERN",
        "COMPACT",
        "ATS",
    ]
    assert choice["sections"][1] == {
        "id": "photo",
        "kind": "toggle",
        "options": [
            {
                "id": "photo",
                "label": "프로필 사진 넣기",
                "desc": "마이 › 프로필 사진을 써요 · 모든 템플릿",  # noqa: RUF001
            }
        ],
        "selected": ["photo"],
    }
    assert choice["submit"]["optionLabels"]["ATS"] == "ATS로 만들기"
    assert choice["submit"]["label"] == "만들기"
    assert choice["options"][0]["id"] == "CLASSIC"
    assert choice["options"][-1]["id"] == "cancel"


def test_quality_copy():
    from app.harness.personal.resume.graph import _GATES
    from app.harness.personal.resume.progress import quality_choice

    assert _GATES["quality"]["title"] == "추천 수정도 반영할까요?"
    event = quality_choice([{"label": "숫자로", "priority": "P1"}])
    assert event["title"] == "추천 수정도 반영할까요?"
    assert event["submit"]["label"] == "{n}개 반영하고 디자인으로"


def test_read_failed_copy():
    from app.harness.personal.resume.graph import _GATES

    gate = _GATES["read_failed"]
    assert gate["title"] == "어떻게 할까요?"
    assert gate["recommended"] == "paste"
    assert gate["options"] == [
        {"id": "paste", "label": "공고 내용을 붙여넣을게요"},
        {"id": "proceed", "label": "이대로 진행해 주세요"},
        {"id": "pick", "label": "Push 공고에서 고를게요"},
    ]
    assert all(item["id"] != "cancel" for item in gate["options"])


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
