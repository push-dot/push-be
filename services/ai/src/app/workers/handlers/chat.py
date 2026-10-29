from uuid import uuid4

_harness = None


def configure_harness(run) -> None:
    global _harness
    _harness = run


def approval_followup(job: dict) -> dict:
    payload = dict(job.get("payload") or {})
    payload["approved"] = True
    return {
        "id": uuid4(),
        "type": "chat",
        "queue": job.get("queue") or "q:chat",
        "status": "QUEUED",
        "user_id": job.get("user_id"),
        "company_id": job.get("company_id"),
        "conversation_id": job.get("conversation_id"),
        "payload": payload,
        "attempts": 0,
        "max_attempts": job.get("max_attempts") or 4,
    }


async def chat(ctx) -> dict:
    if _harness is None:
        raise RuntimeError("chat handler is not configured")
    handled = await _harness(ctx)
    if handled is None:
        raise RuntimeError("chat harness did not handle the job")
    return handled
