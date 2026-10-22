from __future__ import annotations

from fastapi import APIRouter, Request

from app.api import schemas as s
from app.api.deps import ai_options, bind_json, current_user, data, deps, param_id

router = APIRouter()

# Application CRUD, timeline, checklist, drafts and submissions moved to
# push-be-core (services/core-api/src/routes/applications.ts).


@router.post("/applications/{id}/resume-run", status_code=202)
async def resume_run(id: str, request: Request):
    d = deps(request)
    req = await bind_json(request, s.ResumeRunReq)
    op = await d.resume_workflow.run(
        current_user(request).id, param_id(id, "id"), ai_options(req.ai))
    return data(202, op)
