from __future__ import annotations

from contextlib import aclosing
from time import monotonic
from typing import Final

from app.domain.errors import DomainError

_CANCEL_CHECK_SECONDS: Final = 1.0


async def run_queue_turn(svc, ctx, cancelled) -> dict:
    from app.domain.employer_chat import turn_from_payload
    from app.domain.services.conversation import _live_event
    from app.jsonutil import to_jsonable
    from app.queue.worker import JobCancelled, JobFailed

    job = ctx.job
    payload = dict(job.get("payload") or {})
    source = svc.graph
    state = {
        "user_id": job["user_id"],
        "conversation_id": job["conversation_id"],
        "text": payload.get("text") or "",
        "context": payload.get("context") or {},
        "ai": payload.get("ai"),
        "access_mode": payload.get("access_mode") or payload.get("accessMode") or "AUTO",
        "job_id": str(job["id"]),
        **turn_from_payload(payload),
        **({"resume": payload["resume"]} if payload.get("resume") else {}),
    }
    result: dict = {}
    checked_at = -_CANCEL_CHECK_SECONDS
    stream = source.astream(
        state, config={"configurable": {"thread_id": str(job["conversation_id"])}},
        stream_mode=["custom", "values"])
    try:
        # aclosing: close the graph stream here, in this Context, so its contextvar resets succeed.
        async with aclosing(stream):
            async for mode, chunk in stream:
                final = mode == "values" and isinstance(chunk, dict) and bool(chunk.get("operation"))
                ending = final or (isinstance(chunk, dict) and chunk.get("type") == "done")
                # One cancelled() query per second instead of per token, and always before done.
                if ending or monotonic() - checked_at >= _CANCEL_CHECK_SECONDS:
                    checked_at = monotonic()
                    if await cancelled(job["id"]):
                        await ctx.emit("cancelled", {})
                        raise JobCancelled()
                if mode == "custom" and isinstance(chunk, dict):
                    if "token" in chunk:
                        await ctx.emit("token", {"text": chunk["token"]})
                    elif "status" in chunk:
                        await ctx.emit("status", {"text": chunk["status"]})
                    elif (live := _live_event(chunk)) is not None:
                        await ctx.emit(*live)
                elif final:
                    operation = to_jsonable(chunk["operation"])
                    result = {"operationId": str(operation.get("id") or "")}
                    await ctx.emit("done", {"operation": operation})
    except DomainError as err:
        error = {"code": err.code, "message": err.message, "details": err.details}
        await ctx.emit("error", {"error": error})
        raise JobFailed(error)
    return result
