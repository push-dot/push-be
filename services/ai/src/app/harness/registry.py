from __future__ import annotations

from app.framework.untrusted import DATA_RULE
from app.harness.personal.prompt import personal_prompt
from app.harness.personal.tools import PERSONAL_TOOLS
from app.harness.tools import HarnessSpec

REGISTRY: dict[str, HarnessSpec] = {
    "personal": HarnessSpec(
        id="personal",
        prompt=personal_prompt() + "\n" + DATA_RULE + "\n",
        tools=PERSONAL_TOOLS,
    ),
}


def register_harness(spec: HarnessSpec) -> None:
    """A service adds the harness it owns: push-agent registers `employer`."""
    REGISTRY[spec.id] = spec
