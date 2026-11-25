from __future__ import annotations

import asyncio

import pytest

from app.domain.errors import CREDIT_EXHAUSTED, DomainError
from app.harness.kstyle import subagent
from app.harness.kstyle.stage import Task, run_stage


async def test_a_late_task_is_dropped_and_keeps_what_it_verified():
    findings: list[dict] = []

    async def slow() -> dict:
        findings.append({"path": "acme/widgets:README.md", "quote": "widgets ship weekly"})
        await asyncio.sleep(1)
        return {"summary": "never"}

    async def quick() -> dict:
        return {"summary": "done"}

    saved = {}

    async def save(name: str, out: dict) -> None:
        saved[name] = out

    staged = await run_stage([Task("slow", slow, seconds=0.05, findings=findings), Task("quick", quick)],
                             save=save)
    assert staged["late"] == ["slow"] and staged["failed"] == []
    assert staged["out"]["slow"]["findings"] == findings and staged["out"]["quick"]["summary"] == "done"
    assert list(saved) == ["01_agent_quick.json"]
    assert staged["seconds"] < 1


async def test_a_failed_task_is_isolated():
    async def broken() -> dict:
        raise RuntimeError("boom")

    async def fine() -> dict:
        return {"summary": "ok"}

    staged = await run_stage([Task("broken", broken), Task("fine", fine)])
    assert staged["failed"] == ["broken"] and staged["late"] == []
    assert staged["out"]["fine"]["summary"] == "ok"


async def test_the_default_limit_is_read_when_the_stage_runs(monkeypatch):
    monkeypatch.setattr(subagent, "SUB_SECONDS", 0.05)

    async def slow() -> dict:
        await asyncio.sleep(1)
        return {}

    staged = await run_stage([Task("slow", slow)])
    assert staged["late"] == ["slow"]


async def test_a_stage_marks_itself_on_the_bound_turn():
    from app.harness.kstyle import stats

    async def slow() -> dict:
        await asyncio.sleep(1)
        return {}

    async def quick() -> dict:
        return {}

    turn: dict = {}
    token = stats.current.set(turn)
    try:
        await run_stage([Task("slow", slow, seconds=0.05), Task("quick", quick)])
        await run_stage([Task("quick", quick)], name="reviewers")
    finally:
        stats.current.reset(token)
    rows = stats.summary(turn)["stages"]
    assert [(row["stage"], row["late"]) for row in rows] == [
        ("slow+quick", ["slow"]), ("reviewers", [])]
    assert rows[0]["seconds"] < 1


async def test_an_error_that_ends_the_turn_stops_the_other_tasks():
    finished = []

    async def broke():
        raise DomainError(402, CREDIT_EXHAUSTED, "no credit")

    async def slow():
        await asyncio.sleep(0.05)
        finished.append("slow")
        return {"summary": ""}

    with pytest.raises(DomainError):
        await run_stage([Task("broke", broke), Task("slow", slow)])
    await asyncio.sleep(0.1)
    assert finished == []
