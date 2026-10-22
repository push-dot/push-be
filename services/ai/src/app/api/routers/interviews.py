from __future__ import annotations

from fastapi import APIRouter, Request

from app.api import schemas as s
from app.api.deps import ai_options, bind_json, current_user, data, deps, param_id

router = APIRouter()

# Interview list/create/get/patch moved to push-be-core
# (services/core-api/src/routes/interviews.ts).


@router.post("/interviews/{id}/prepare", status_code=202)
async def prepare_interview(id: str, request: Request):
    d = deps(request)
    req = await bind_json(request, s.PrepareReq)
    op = await d.interviews.prepare(current_user(request).id,
                                    param_id(id, "id"),
                                    req.expected_revision, ai_options(req.ai))
    return data(202, op)
