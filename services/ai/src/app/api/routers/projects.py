from __future__ import annotations

from fastapi import APIRouter, Request

from app.api import schemas as s
from app.api.deps import ai_options, bind_json, current_user, data, deps, param_id

router = APIRouter()

# Blueprint list/get/select, CLI runs and project evidence create/list moved
# to push-be-core (services/core-api/src/routes/projects.ts).


@router.post("/projects/blueprints", status_code=202)
async def generate_blueprints(request: Request):
    d = deps(request)
    req = await bind_json(request, s.BlueprintsReq)
    op = await d.projects.generate_blueprints(
        current_user(request).id, req.application_id, req.gap_analysis_id,
        ai_options(req.ai))
    return data(202, op)


@router.post("/projects/{id}/evidence/{evidenceId}/verify", status_code=202)
async def verify_project_evidence(id: str, evidenceId: str, request: Request):
    d = deps(request)
    req = await bind_json(request, s.ExpectedRevisionReq)
    op = await d.projects.verify_evidence(current_user(request).id,
                                          param_id(id, "id"),
                                          param_id(evidenceId, "evidenceId"),
                                          req.expected_revision)
    return data(202, op)
