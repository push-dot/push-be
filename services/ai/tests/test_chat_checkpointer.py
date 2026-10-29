from __future__ import annotations

from contextlib import AsyncExitStack

import app.db as db
import app.main as main
from app.config import Config


async def test_external_jobs_keeps_a_checkpointer(monkeypatch):
    monkeypatch.setenv("CHAT_EXECUTOR", "external")
    monkeypatch.setenv("CHECKPOINTER", "memory")
    saver = await main._chat_checkpointer(
        Config(database_url="postgres://db"), AsyncExitStack())
    assert saver is not None


async def test_external_jobs_opens_the_postgres_saver(monkeypatch):
    opened: list[str] = []

    class Pool:
        async def close(self) -> None:
            opened.append("closed")

    async def open_saver(url):
        opened.append(url)
        return "saver", Pool()

    monkeypatch.setenv("CHAT_EXECUTOR", "external")
    monkeypatch.delenv("CHECKPOINTER", raising=False)
    monkeypatch.setattr(db, "open_chat_checkpointer", open_saver)
    stack = AsyncExitStack()
    saver = await main._chat_checkpointer(Config(database_url="postgres://db"), stack)
    assert saver == "saver"
    assert opened == ["postgres://db"]
    await stack.aclose()
    assert "closed" in opened


