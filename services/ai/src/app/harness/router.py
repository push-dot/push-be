from __future__ import annotations

from app.harness.registry import REGISTRY
from app.harness.tools import HarnessSpec


def select_harness(conversation: dict) -> HarnessSpec:
    if conversation.get("company_id"):
        return REGISTRY["employer"]
    return REGISTRY["personal"]
