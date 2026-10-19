"""Schedule a chat Workflow. Only the core worker may call this.

The path is outside ``/api/v1``, so the public auth middleware does not
run. ``workers_dev`` is off, and the gateway refuses ``/internal`` before
it can be proxied. The header is a second check for a request that
reaches this worker through the service binding.
"""

from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from app.api.deps import data
from app.api.errors import error_body
from app.jobs import schedule_chat_job

router = APIRouter()


@router.post("/internal/chat/schedule")
async def schedule_chat(request: Request):
    rid = getattr(request.state, "request_id", "")
    if request.headers.get("x-push-internal") != "1":
        return JSONResponse(
            status_code=404,
            content=error_body("NOT_FOUND", "resource not found", rid))
    try:
        body = await request.json()
    except Exception:
        body = None
    if not isinstance(body, dict) or not body.get("jobId"):
        return JSONResponse(
            status_code=400,
            content=error_body("VALIDATION_ERROR", "invalid request body", rid))
    await schedule_chat_job(str(body["jobId"]), str(body.get("byok") or ""))
    return data(200, {"scheduled": True})
