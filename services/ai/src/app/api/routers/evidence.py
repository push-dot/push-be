from __future__ import annotations

from fastapi import APIRouter, Request

from app.api import schemas as s
from app.api.deps import bind_json, current_user, data, deps, param_id
from app.db import NotFoundError
from app.domain.errors import not_found
from app.domain.profile_draft import parse_profile_draft

router = APIRouter()

# Career evidence CRUD, source list/get/content/delete/upload and image
# uploads moved to push-be-core. Import and the profile draft parse files,
# which core does not do, so they stay here.

MAX_SOURCE_BYTES = 20 << 20


@router.post("/career-evidence/import", status_code=202)
async def import_evidence(request: Request):
    d = deps(request)
    req = await bind_json(request, s.ImportEvidenceReq)
    op = await d.evidence.import_(current_user(request).id, req.source_id,
                                  req.text, req.source_url, req.content_hash,
                                  req.format, req.kind, req.title)
    return data(202, op)


@router.get("/sources/{id}/profile-draft")
async def get_source_profile_draft(id: str, request: Request):
    d = deps(request)
    user_id = current_user(request).id
    sid = param_id(id, "id")
    try:
        await d.sources.get(user_id, sid)
    except NotFoundError:
        raise not_found()
    text = await d.evidence._source_text(user_id, sid)
    return data(200, parse_profile_draft(text))
