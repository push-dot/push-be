from __future__ import annotations

import json

from app.harness.registry import REGISTRY
from app.harness.tools import HarnessSpec


def select_harness(conversation: dict) -> HarnessSpec:
    state = conversation.get("resume_state") or {}
    if isinstance(state, str):
        try:
            state = json.loads(state)
        except json.JSONDecodeError:
            state = {}
    if isinstance(state, dict) and state.get("status") == "active":
        return REGISTRY["resume"]
    if conversation.get("company_id"):
        return REGISTRY["employer"]
    return REGISTRY["personal"]
