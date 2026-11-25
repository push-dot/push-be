from __future__ import annotations

import asyncio
import contextlib
from contextlib import aclosing
from time import monotonic
from typing import Final

from app.domain.errors import DomainError

_CANCEL_CHECK_SECONDS: Final = 1.0
# Tokens are stored as one chat_events row per batch, not per model chunk.
_TOKEN_FLUSH_SECONDS: Final = 0.1
_TOKEN_FLUSH_CHARS: Final = 200


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
    pending: list[str] = []
    pending_chars = 0
    pending_at = 0.0

    writing = asyncio.Lock()

    async def flush() -> None:
        nonlocal pending, pending_chars
        if pending:
            text = "".join(pending)
            pending, pending_chars = [], 0
            async with writing:
                await ctx.emit("token", {"text": text})

    async def emit(kind: str, body: dict) -> None:
        await flush()
        async with writing:
            await ctx.emit(kind, body)

    # Flushes a batch whose model went quiet, so a pause, a cancel or a crash keeps what streamed.
    async def tick() -> None:
        while True:
            await asyncio.sleep(_TOKEN_FLUSH_SECONDS)
            if pending and monotonic() - pending_at >= _TOKEN_FLUSH_SECONDS:
                await flush()

    checked_at = -_CANCEL_CHECK_SECONDS
    stream = source.astream(
        state, config={"configurable": {"thread_id": str(job["conversation_id"])}},
        stream_mode=["custom", "values"])
    ticker = asyncio.create_task(tick())
    try:
        # aclosing: close the graph stream here, in this Context, so its contextvar resets succeed.
        async with aclosing(stream):
            async for mode, chunk in stream:
                final = mode == "values" and isinstance(chunk, dict) and bool(chunk.get("operation"))
                ending = final or (isinstance(chunk, dict) and chunk.get("type") == "done")
                # One cancelled() query per second instead of per token, and always before done.
                if ending or monotonic() - checked_at >= _CANCEL_CHECK_SECONDS:
                    checked_at = monotonic()
                    # The cancel itself wrote the cancelled event: the trigger on the status (0055).
                    if await cancelled(job["id"]):
                        raise JobCancelled()
                if mode == "custom" and isinstance(chunk, dict):
                    if chunk.get("type") == "done" and chunk.get("awaiting"):
                        result["awaiting"] = chunk["awaiting"]
                    if "token" in chunk:
                        if not pending:
                            pending_at = monotonic()
                        pending.append(chunk["token"])
                        pending_chars += len(chunk["token"])
                        if (pending_chars >= _TOKEN_FLUSH_CHARS
                                or monotonic() - pending_at >= _TOKEN_FLUSH_SECONDS):
                            await flush()
                    elif (live := _live_event(chunk, job["id"])) is not None:
                        await emit(*live)
                elif final:
                    operation = to_jsonable(chunk["operation"])
                    result = {"operationId": str(operation.get("id") or "")}
                    await emit("done", {"operation": operation})
        await flush()
    except DomainError as err:
        error = {"code": err.code, "message": err.message, "details": err.details}
        await emit("error", {"error": error})
        raise JobFailed(error) from None
    except JobCancelled:
        raise
    except Exception:
        await flush()
        raise
    finally:
        ticker.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await ticker
    return result
