from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Request

from app.api import schemas as s
from app.api.deps import bind_json, current_user, data, param_id
from app.domain import posting_fit as fit
from app.domain.errors import not_found
from app.jsonutil import dump

router = APIRouter()


@router.post("/postings/{id}/fit")
async def posting_fit(id: str, request: Request):
    user = current_user(request)
    posting_id = param_id(id, "id")
    body = await bind_json(request, s.PostingFitReq)
    query = request.app.state.db.q()
    cached = await query.fetchrow(
        "SELECT fit_score, parts, top_gap, plan FROM posting_fit_cache "
        "WHERE user_id = $1 AND posting_id = $2 AND document_id = $3",
        user.id, posting_id, body.document_id)
    if cached is not None:
        return data(200, fit.cached_view(cached))
    posting = await query.fetchrow(
        "SELECT id, requirements, skills, description FROM job_postings "
        "WHERE id = $1",
        posting_id)
    document = await query.fetchrow(
        "SELECT d.id, d.user_id, v.content FROM documents d "
        "JOIN document_versions v ON v.id = d.latest_version_id "
        "WHERE d.id = $1",
        body.document_id)
    if posting is None or document is None or not _same_user(document["user_id"], user.id):
        raise not_found()
    plan_row = await query.fetchrow(
        "SELECT plan FROM users WHERE id = $1", user.id)
    plan = None if plan_row is None else plan_row["plan"]
    view = fit.compute_fit(
        posting["requirements"], posting["skills"], posting["description"],
        body.document_id, document["content"], plan)
    await query.execute(
        "INSERT INTO posting_fit_cache "
        "(user_id, posting_id, document_id, fit_score, parts, top_gap, plan) "
        "VALUES ($1, $2, $3, $4, $5, $6, $7) "
        "ON CONFLICT (user_id, posting_id, document_id) DO UPDATE SET "
        "fit_score = EXCLUDED.fit_score, parts = EXCLUDED.parts, "
        "top_gap = EXCLUDED.top_gap, plan = EXCLUDED.plan",
        user.id, posting_id, body.document_id, view["fitScore"],
        dump(view["parts"]), view["topGap"], view["plan"])
    return data(200, view)


def _same_user(row_user, caller: UUID) -> bool:
    return UUID(str(row_user)) == caller
