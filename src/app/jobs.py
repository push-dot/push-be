"""How chat jobs run outside a resident worker loop.

Cloudflare Workers have no background thread. On that runtime a Workflow
(one graph node per step, so each step gets its own 10 ms CPU budget)
claims the row. A cron trigger nudges anything left PENDING.
"""

from __future__ import annotations

import os
from typing import Awaitable, Callable, Optional

Scheduler = Callable[[str, str], Awaitable[None]]
_scheduler: Optional[Scheduler] = None


def external_jobs() -> bool:
    mode = os.environ.get("CHAT_EXECUTOR", "")
    return os.environ.get("CF_WORKER") == "1" or mode in ("workflow", "external")


def set_job_scheduler(fn: Scheduler) -> None:
    global _scheduler
    _scheduler = fn


async def schedule_chat_job(job_id, byok: str = "") -> None:
    if _scheduler is not None:
        await _scheduler(str(job_id), byok or "")


def sse_max_polls() -> int:
    raw = os.environ.get("SSE_MAX_POLLS", "")
    if raw.isdigit():
        return max(1, int(raw))
    return 20 if external_jobs() else 1500
