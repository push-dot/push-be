from __future__ import annotations


def framework() -> str:
    return "langchain"


def use_langchain() -> bool:
    return framework() == "langchain"
