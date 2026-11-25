"""The employer harness as push-agent hands it to the shared engine."""

from __future__ import annotations

from pathlib import Path

from app.framework.untrusted import DATA_RULE
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
    if name in ("review", "interview") and application_id:
        start["application_id"] = str(application_id)
    return start


EMPLOYER = HarnessSpec(
    id="employer",
    prompt=((Path(__file__).parent / "prompt.md").read_text(encoding="utf-8")
            + "\n" + posting_system_prompt() + "\n\n" + DATA_RULE + "\n"),
    tools=EMPLOYER_TOOLS,
    build_graph=build_employer_graph,
    start_flow=employer_start,
)


def register() -> HarnessSpec:
    register_harness(EMPLOYER)
    return EMPLOYER
