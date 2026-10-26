"""Schedule a chat Workflow. Only the core worker may call this.

The path is outside ``/api/v1``, so the public auth middleware does not
run. ``workers_dev`` is off, and the gateway refuses ``/internal`` before
it can be proxied. The header is a second check for a request that
reaches this worker through the service binding.
"""

from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, ValidationError

from app.api.deps import data
from app.api.errors import error_body, request_id_of
from app.jobs import schedule_chat_job

router = APIRouter()


class ScheduleReq(BaseModel):
    job_id: UUID = Field(alias="jobId")


@router.post("/internal/chat/schedule")
async def schedule_chat(request: Request) -> JSONResponse:
    rid = request_id_of(request)
    if request.headers.get("x-push-internal") != "1":
        return JSONResponse(
            status_code=404,
            content=error_body("NOT_FOUND", "resource not found", rid))
    try:
        req = ScheduleReq.model_validate_json(await request.body())
    except ValidationError:
        return JSONResponse(
            status_code=400,
            content=error_body("VALIDATION_ERROR", "invalid request body", rid))
    await schedule_chat_job(str(req.job_id))
    return data(200, {"scheduled": True})
