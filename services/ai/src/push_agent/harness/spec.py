"""The employer harness as push-agent hands it to the shared engine."""

from __future__ import annotations

from pathlib import Path

from app.framework.untrusted import DATA_RULE, as_data
from app.harness.registry import register_harness
from app.harness.tools import HarnessSpec
from push_agent.harness.graph import build_employer_graph
from push_agent.harness.tools import EMPLOYER_TOOLS

_FLOW_INTENTS = ("posting", "review", "interview")


def posting_system_prompt() -> str:
    return (
        "공고 초안은 다음 펜스 안에 JSON으로만 쓴다.\n"
        "```posting-draft\n"
        "{\n"
        '  "title": "",\n'
        '  "description": "",\n'
        '  "requirements": [],\n'
        '  "preferred": [],\n'
        '  "workConditions": {}\n'
        "}\n"
        "```\n"
        "title은 공고 제목, description은 하는 일, requirements는 자격 요건, "
        "preferred는 우대 사항, workConditions는 근무 조건이다."
    )


def employer_start(payload: dict, conversation: dict) -> dict | None:
    """A web entry point (intent) starts an employer flow; plain chat goes to the agent."""
    name = str(payload.get("intent") or "")
    if name not in _FLOW_INTENTS:
        return None
    application_id = (payload.get("application_id") or payload.get("applicationId")
                      or conversation.get("application_id"))
    start = {"name": name}
    if name == "posting" and conversation.get("posting_id"):
        start["reference_posting_id"] = conversation["posting_id"]
    if name == "posting":
        # This turn's own words only: an intent button sends none, and an older message in the
        # thread is not this request.
        start["asked"] = str(payload.get("text") or "").strip()
    if name in ("review", "interview") and application_id:
        start["application_id"] = str(application_id)
    return start


def employer_context(state: dict) -> str | None:
    """The company's own posting this conversation is about, so the agent works on that id
    instead of finding a posting by title, which two postings can share."""
    posting = state.get("own_posting")
    if not isinstance(posting, dict) or not posting.get("id"):
        return None
    return (
        f"이 대화는 이 회사의 공고 하나에 묶여 있다 (posting_id {posting['id']}). "
        "담당자가 다른 공고를 말하지 않으면 이 공고를 뜻한다. 제목으로 찾지 말고 이 posting_id로 "
        "`get_posting`, `update_posting_draft`, `update_published_posting`을 부른다. 공고 제목:\n"
        # An employer wrote the title. Tagged, it stays data.
        + as_data(str(posting.get("title") or "제목 없음"), "posting_title", 200)
    )


EMPLOYER = HarnessSpec(
    id="employer",
    prompt=((Path(__file__).parent / "prompt.md").read_text(encoding="utf-8")
            + "\n" + posting_system_prompt() + "\n\n" + DATA_RULE + "\n"),
    tools=EMPLOYER_TOOLS,
    build_graph=build_employer_graph,
    start_flow=employer_start,
    context=employer_context,
)


def register() -> HarnessSpec:
    register_harness(EMPLOYER)
    return EMPLOYER
