"""How chat jobs run outside a resident worker loop.

Cloudflare Workers have no background thread. On that runtime a Workflow
(one graph node per step, so each step gets its own 10 ms CPU budget)
claims the row. ``prepare_reply`` is its own step, ahead of the model
call. A cron trigger nudges anything left PENDING.
"""

from __future__ import annotations

import os
from typing import Awaitable, Callable, Optional
from uuid import uuid4

# (job_id, byok, claim). A 2-argument scheduler still works.
Scheduler = Callable[..., Awaitable[None]]
_scheduler: Optional[Scheduler] = None


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


def set_job_scheduler(fn: Scheduler) -> None:
    global _scheduler
    _scheduler = fn


def get_job_scheduler() -> Optional[Scheduler]:
    return _scheduler


def queue_backend() -> str:
    return os.environ.get("QUEUE_BACKEND", "postgres").strip().lower() or "postgres"


async def schedule_chat_job(job_id, byok: str = "") -> None:
    if queue_backend() == "redis":
        return
    if _scheduler is None:
        return
    claim = str(uuid4())
    try:
        await _scheduler(str(job_id), byok or "", claim)
    except TypeError:
        await _scheduler(str(job_id), byok or "")


def sse_max_polls() -> int:
    raw = os.environ.get("SSE_MAX_POLLS", "")
    if raw.isdigit():
        return max(1, int(raw))
    return 20 if external_jobs() else 1500
