from __future__ import annotations

from fastapi import APIRouter, Request

from app.domain import entities as ent
from app.domain.errors import validation_field
from app.api import schemas as s
from app.api.deps import deps, ai_options, bind_json, current_user, data

router = APIRouter()




@router.get("/ai/models")
async def ai_models(request: Request):
    d = deps(request)
    provider = request.query_params.get("provider", "")
    if provider and not ent.valid_ai_provider(provider):
        raise validation_field("provider", "unsupported provider")
    models = []
    for m in ent.OPENAI_MODELS:
        if provider and provider != m.provider:
            continue
        available = d.cfg.managed_go if m.model.startswith("opencode-go/") \
            else d.cfg.managed_ai
        models.append({"provider": m.provider, "model": m.model,
                       "label": m.label, "available": available,
                       "supportedEfforts": ["LOW", "MEDIUM", "HIGH"]})
    return data(200, models)


@router.post("/ai/generate", status_code=202)
async def ai_generate(request: Request):
    d = deps(request)
    req = await bind_json(request, s.AiGenerateReq)
    op = await d.ai.generate(current_user(request).id, ai_options(req.ai),
                             req.prompt, req.application_id,
                             req.evidence_ids)
    return data(202, op)
