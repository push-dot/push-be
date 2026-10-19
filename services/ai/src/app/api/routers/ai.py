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
    cred_mode = request.query_params.get("credentialMode", "")
    if provider and not ent.valid_ai_provider(provider):
        raise validation_field("provider", "unsupported provider")
    if cred_mode and not ent.valid_credential_mode(cred_mode):
        raise validation_field("credentialMode", "unsupported credentialMode")
    if cred_mode == "BYOK" and provider:
        key = request.headers.get("x-byok-key", "")
        if not key:
            return data(200, [])
        ids = await d.ai.gate.list_byok_models(provider, key)
        return data(200, [{"provider": provider, "model": m, "label": m,
                           "available": True,
                           "supportedEfforts": ["LOW", "MEDIUM", "HIGH"]}
                          for m in ids])
    byok_openai = False
    if d.cfg.byok_enabled and d.ai_keys is not None:
        try:
            await d.ai_keys.get(current_user(request).id, "OPENAI")
            byok_openai = True
        except Exception:
            pass
    models = []
    for m in ent.OPENAI_MODELS:
        if provider and provider != m.provider:
            continue
        managed_ok = d.cfg.managed_go if m.model.startswith("opencode-go/") \
            else d.cfg.managed_ai
        available = managed_ok or byok_openai
        if cred_mode == "MANAGED":
            available = managed_ok
        elif cred_mode == "BYOK":
            available = byok_openai
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
