from __future__ import annotations

import os


def framework() -> str:
    """``langchain``, except on Cloudflare Python Workers, which cannot load it."""
    return "legacy" if os.environ.get("CF_WORKER") == "1" else "langchain"


def use_langchain() -> bool:
    return framework() == "langchain"
