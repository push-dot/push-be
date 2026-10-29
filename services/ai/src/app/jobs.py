"""How chat jobs run outside a resident worker loop.

On the VPS the queue workers claim chat jobs; ``CHAT_EXECUTOR=external``
tells the API process not to run its own claim loop.
"""

from __future__ import annotations

import os
from collections.abc import Awaitable, Callable
from uuid import UUID, uuid4

type Scheduler = Callable[[str, str], Awaitable[None]]
"""Called with (job_id, claim)."""

_scheduler: Scheduler | None = None


def external_jobs() -> bool:
    mode = os.environ.get("CHAT_EXECUTOR", "")
    return mode == "external"


def set_job_scheduler(fn: Scheduler | None) -> None:
    global _scheduler
    _scheduler = fn


def get_job_scheduler() -> Scheduler | None:
    return _scheduler


def queue_backend() -> str:
    return os.environ.get("QUEUE_BACKEND", "postgres").strip().lower() or "postgres"


def runs_local_chat_worker() -> bool:
    return not external_jobs() and queue_backend() != "redis"


async def schedule_chat_job(job_id: str | UUID) -> None:
    if queue_backend() == "redis" or _scheduler is None:
        return
    await _scheduler(str(job_id), str(uuid4()))
