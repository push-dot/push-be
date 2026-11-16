from __future__ import annotations

from pathlib import Path

from app.domain.employer_chat import posting_system_prompt
from app.framework.untrusted import DATA_RULE
from app.harness.employer.tools import EMPLOYER_TOOLS
from app.harness.personal.prompt import personal_prompt
from app.harness.personal.tools import PERSONAL_TOOLS
from app.harness.tools import HarnessSpec

_ROOT = Path(__file__).parent


def _prompt(name: str) -> str:
    return (_ROOT / name / "prompt.md").read_text(encoding="utf-8")


REGISTRY: dict[str, HarnessSpec] = {
    "personal": HarnessSpec(
        id="personal",
        prompt=personal_prompt() + "\n" + DATA_RULE + "\n",
        tools=PERSONAL_TOOLS,
    ),
    "employer": HarnessSpec(
        id="employer",
        prompt=_prompt("employer") + "\n" + posting_system_prompt() + "\n\n" + DATA_RULE + "\n",
        tools=EMPLOYER_TOOLS,
    ),
}
