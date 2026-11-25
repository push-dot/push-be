"""A stage: tasks start together, each owns its own state entry, and a late or failed one is dropped,
not waited for. What a late task verified before the limit is kept through its shared findings list."""
from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from app.harness.kstyle import stats
from app.harness.kstyle.subagent import timed


@dataclass(frozen=True)
class Task:
    name: str                                  # owns state entry "01_agent_<name>.json"
    run: Callable[[], Awaitable[dict]]         # must return a dict
    seconds: float | None = None               # None: subagent.SUB_SECONDS, read when the stage runs
    findings: list[dict] | None = None         # shared list, so a late task keeps what it verified


def entry(name: str) -> str:
    return f"01_agent_{name}.json"


async def run_stage(tasks: list[Task], *,
                    save: Callable[[str, dict], Awaitable[None]] | None = None,
                    name: str | None = None) -> dict:
    """{"out": {name: dict}, "late": [name], "failed": [name], "seconds": float}. `save(entry, out)` runs
    for each task that finished in time. The stage is marked on the bound turn as `name`, by default
    the task names joined with `+`."""
    started = time.monotonic()
    jobs = [asyncio.ensure_future(timed(task.run(), task.findings, seconds=task.seconds))
            for task in tasks]
    try:
        results = await asyncio.gather(*jobs)
    except BaseException:
        # An error that ends the turn must not leave the other subagents billing a settled turn.
        for job in jobs:
            job.cancel()
        await asyncio.gather(*jobs, return_exceptions=True)
        raise
    out = {task.name: result for task, result in zip(tasks, results, strict=True)}
    late = [key for key, result in out.items() if result.get("late")]
    failed = [key for key, result in out.items() if result.get("failed")]
    if save is not None:
        for key, result in out.items():
            if key not in late and key not in failed:
                await save(entry(key), result)
    seconds = time.monotonic() - started
    turn = stats.current.get()
    if turn is not None:
        stats.mark(turn, name or "+".join(task.name for task in tasks), seconds, late + failed)
    return {"out": out, "late": late, "failed": failed, "seconds": seconds}
