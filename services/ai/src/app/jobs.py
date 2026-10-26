"""How chat jobs run outside a resident worker loop.

Cloudflare Workers have no background thread. On that runtime a Workflow
(one graph node per step, so each step gets its own 10 ms CPU budget)
claims the row. ``prepare_reply`` is its own step, ahead of the model
call. A cron trigger nudges anything left PENDING.
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
    return os.environ.get("CF_WORKER") == "1" or mode in ("workflow", "external")


def remote_executor() -> bool:
    """The VPS worker claims chat_jobs. Cloudflare must not schedule them too.

    Clearing ``AI_ORIGIN`` and ``CHAT_EXECUTOR_REMOTE`` restores the Workflow.
    """
    flag = os.environ.get("CHAT_EXECUTOR_REMOTE", "").strip().lower()
    if flag in ("1", "true", "yes"):
        return True
    return bool(os.environ.get("AI_ORIGIN", "").strip())


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


def sse_max_polls() -> int:
    raw = os.environ.get("SSE_MAX_POLLS", "")
    if raw.isdigit():
        return max(1, int(raw))
    return 20 if external_jobs() else 1500
