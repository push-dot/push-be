from __future__ import annotations

from fastapi import APIRouter, Request

from app.api import schemas as s
from app.api.deps import bind_json, current_user, data, param_id
from app.domain.errors import not_found
from app.infrastructure.posting_fit_cache import load_fit

router = APIRouter()


@router.post("/postings/{id}/fit")
async def posting_fit(id: str, request: Request):
    user = current_user(request)
    posting_id = param_id(id, "id")
    body = await bind_json(request, s.PostingFitReq)
    view = await load_fit(request.app.state.db.q(), user.id, posting_id, body.document_id)
    if view is None:
        raise not_found()
    return data(200, view)
