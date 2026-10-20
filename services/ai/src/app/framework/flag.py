from __future__ import annotations

import os

_MODES = {"legacy", "langchain"}


def framework() -> str:
    """``legacy`` unless ``AI_FRAMEWORK=langchain`` and this is not a Worker."""
    if os.environ.get("CF_WORKER") == "1":
        return "legacy"
    mode = (os.environ.get("AI_FRAMEWORK") or "legacy").strip().lower()
    if mode not in _MODES:
        return "legacy"
    return mode


def use_langchain() -> bool:
    return framework() == "langchain"
