from __future__ import annotations

from fastapi import APIRouter, Request

from app.api import schemas as s
from app.api.deps import deps, ai_options, bind_json, current_user, data, param_id

router = APIRouter()


@router.post("/jobs/{id}/analyze", status_code=202)
async def analyze_job(id: str, request: Request):
    d = deps(request)
    req = await bind_json(request, s.AnalyzeReq)
    op = await d.jobs.analyze(current_user(request).id, param_id(id, "id"),
                              req.application_id, req.expected_revision,
                              req.evidence_ids, ai_options(req.ai))
    return data(202, op)
