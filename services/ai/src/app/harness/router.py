from __future__ import annotations

from app.harness.registry import REGISTRY
from app.harness.tools import HarnessSpec


class HarnessNotLoaded(RuntimeError):
    """This service does not run the harness the conversation needs."""


def select_harness(conversation: dict) -> HarnessSpec:
    if not conversation.get("company_id"):
        return REGISTRY["personal"]
    spec = REGISTRY.get("employer")
    if spec is None:
        raise HarnessNotLoaded("a company conversation runs on push-agent; this service has no employer harness")
    return spec
