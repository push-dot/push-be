from uuid import uuid4

from app.queue.worker import JobCancelled

NODES = ("resolve_context", "prepare_reply", "generate_reply", "persist")

_run_node = None
_cancelled = None
_set_state = None


def configure_chat(*, run_node, cancelled, set_state) -> None:
    global _run_node, _cancelled, _set_state
    _run_node = run_node
    _cancelled = cancelled
    _set_state = set_state


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
    if _run_node is None or _cancelled is None or _set_state is None:
        raise RuntimeError("chat handler is not configured")
    message_id = ""
    for name in NODES:
        if await _cancelled(ctx.job["id"]):
            await ctx.emit("cancelled", {})
            raise JobCancelled()
        out = await _run_node(ctx, name) or {}
        if out.get("messageId"):
            message_id = str(out["messageId"])
        if out.get("needs_approval"):
            await _set_state(ctx.job["id"], "NEEDS_APPROVAL")
            await ctx.emit("status", {"state": "NEEDS_APPROVAL"})
            return {"messageId": message_id}
    return {"messageId": message_id}
