from uuid import UUID

from app.domain import posting_fit as fit
from app.jsonutil import dump


async def load_fit(query, user_id: UUID, posting_id: UUID, document_id: UUID) -> dict | None:
    cached = await query.fetchrow(
        "SELECT fit_score, parts, top_gap, plan FROM posting_fit_cache "
        "WHERE user_id = $1 AND posting_id = $2 AND document_id = $3",
        user_id, posting_id, document_id)
    if cached is not None:
        return fit.cached_view(cached)
    posting = await query.fetchrow(
        "SELECT id, requirements, skills, description FROM job_postings "
        "WHERE id = $1",
        posting_id)
    document = await query.fetchrow(
        "SELECT d.id, d.user_id, v.content FROM documents d "
        "JOIN document_versions v ON v.id = d.latest_version_id "
        "WHERE d.id = $1",
        document_id)
    if posting is None or document is None or UUID(str(document["user_id"])) != user_id:
        return None
    plan_row = await query.fetchrow(
        "SELECT plan FROM users WHERE id = $1", user_id)
    plan = None if plan_row is None else plan_row["plan"]
    view = fit.compute_fit(
        posting["requirements"], posting["skills"], posting["description"],
        document_id, document["content"], plan)
    await query.execute(
        "INSERT INTO posting_fit_cache "
        "(user_id, posting_id, document_id, fit_score, parts, top_gap, plan) "
        "VALUES ($1, $2, $3, $4, $5, $6, $7) "
        "ON CONFLICT (user_id, posting_id, document_id) DO UPDATE SET "
        "fit_score = EXCLUDED.fit_score, parts = EXCLUDED.parts, "
        "top_gap = EXCLUDED.top_gap, plan = EXCLUDED.plan",
        user_id, posting_id, document_id, view["fitScore"],
        dump(view["parts"]), view["topGap"], view["plan"])
    return view
