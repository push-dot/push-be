from __future__ import annotations

from pathlib import Path

from app.domain.employer_chat import posting_system_prompt
from app.harness.employer.tools import EMPLOYER_TOOLS
from app.harness.personal.tools import PERSONAL_TOOLS
from app.harness.tools import HarnessSpec

_ROOT = Path(__file__).parent


def _prompt(name: str) -> str:
    return (_ROOT / name / "prompt.md").read_text(encoding="utf-8")


REGISTRY: dict[str, HarnessSpec] = {
    "personal": HarnessSpec(
        id="personal",
        audience="PERSONAL",
        prompt=_prompt("personal"),
        tools=PERSONAL_TOOLS,
    ),
    "employer": HarnessSpec(
        id="employer",
        audience="EMPLOYER",
        prompt=_prompt("employer") + "\n" + posting_system_prompt(),
        tools=EMPLOYER_TOOLS,
    ),
    "resume": HarnessSpec(id="resume", audience="PERSONAL", prompt="", tools=[]),
}
