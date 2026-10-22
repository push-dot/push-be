from __future__ import annotations

import json
from uuid import UUID

from app.domain.errors import DomainError


class _ApprovedEdit:
    def __init__(self, svc, user_id, diff: dict):
        self.svc = svc
        self.user_id = user_id
        self.diff = diff

    async def astream(self, *args, **kwargs):
        try:
            await self.svc.document_svc.apply_hunks(self.user_id, self.diff)
        except DomainError as err:
            yield "custom", {"type": "tool", "name": "edit_document", "state": "err",
                             "summary": "서류 수정", "result": {"error": err.code}}
        else:
            yield "custom", {"type": "diff", **self.diff}
        yield "custom", {"type": "done"}


async def approved_edit(svc, payload: dict, user_id):
    resume = payload.get("resume") or {}
    if resume.get("optionId") != "apply" or getattr(svc, "document_svc", None) is None:
        return None
    approval_id = UUID(str(resume.get("approvalId")))
    row = await svc.db.q().fetchrow(
        "SELECT kind, job_id, tool_args FROM approvals WHERE id = $1 AND user_id = $2",
        approval_id, user_id)
    if row is None or row["kind"] != "DOCUMENT_EDIT" or row["job_id"] is not None:
        return None
    claimed = await svc.db.q().fetchrow(
        "UPDATE approvals SET status = 'CONSUMED', updated_at = now() "
        "WHERE id = $1 AND status = 'APPROVED' RETURNING id", approval_id)
    raw = row["tool_args"]
    diff = json.loads(raw) if isinstance(raw, str) else raw
    if claimed is None or not isinstance(diff, dict):
        return _Done()
    return _ApprovedEdit(svc, user_id, diff)


class _Done:
    async def astream(self, *args, **kwargs):
        yield "custom", {"type": "done"}


async def run_queue_turn(svc, ctx, cancelled) -> dict | None:
    from app.config import harness_enabled
    from app.domain.employer_chat import turn_from_payload
    from app.domain.services.conversation import _live_event
    from app.graphs.chat import byok_key_var
    from app.jsonutil import to_jsonable
    from app.queue.worker import JobCancelled, JobFailed

    job = ctx.job
    payload = dict(job.get("payload") or {})
    source = await approved_edit(svc, payload, job["user_id"]) if payload.get("resume") else None
    if source is None and not harness_enabled():
        return None
    source = source or svc.graph
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
    token = byok_key_var.set(svc._byok_from_payload(job["user_id"], payload))
    result: dict = {}
    try:
        async for mode, chunk in source.astream(
                state, config={"configurable": {"thread_id": str(job["conversation_id"])}},
                stream_mode=["custom", "values"]):
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
            elif mode == "values" and isinstance(chunk, dict) and chunk.get("operation"):
                operation = to_jsonable(chunk["operation"])
                result = {"operationId": str(operation.get("id") or "")}
                await ctx.emit("done", {"operation": operation})
    except DomainError as err:
        error = {"code": err.code, "message": err.message, "details": err.details}
        await ctx.emit("error", {"error": error})
        raise JobFailed(error)
    finally:
        byok_key_var.reset(token)
    return result
