from uuid import UUID

from app.domain import posting_fit as fit
from app.jsonutil import dump

# shortcut: freshness tracks document edits only; job_postings has no updated_at, add one if posting edits must invalidate
_CACHED = (
    "SELECT c.fit_score, c.parts, c.top_gap, c.plan FROM posting_fit_cache c "
    "JOIN documents d ON d.id = c.document_id "
    "WHERE c.user_id = $1 AND c.posting_id = $2 AND c.document_id = $3 "
    "AND c.created_at >= d.updated_at")

# One round trip for the inputs; the document must belong to the user.
_INPUTS = (
    "SELECT p.requirements, p.skills, p.description, v.content, u.plan "
    "FROM job_postings p, documents d "
    "JOIN document_versions v ON v.id = d.latest_version_id "
    "JOIN users u ON u.id = d.user_id "
    "WHERE p.id = $2 AND d.id = $3 AND d.user_id = $1")


async def load_fit(query, user_id: UUID, posting_id: UUID, document_id: UUID) -> dict | None:
    cached = await query.fetchrow(_CACHED, user_id, posting_id, document_id)
    if cached is not None:
        return fit.cached_view(cached)
    row = await query.fetchrow(_INPUTS, user_id, posting_id, document_id)
    if row is None:
        return None
    view = fit.compute_fit(
        row["requirements"], row["skills"], row["description"],
        document_id, row["content"], row["plan"])
    await query.execute(
        "INSERT INTO posting_fit_cache "
        "(user_id, posting_id, document_id, fit_score, parts, top_gap, plan) "
        "VALUES ($1, $2, $3, $4, $5, $6, $7) "
        "ON CONFLICT (user_id, posting_id, document_id) DO UPDATE SET "
        "fit_score = EXCLUDED.fit_score, parts = EXCLUDED.parts, "
        "top_gap = EXCLUDED.top_gap, plan = EXCLUDED.plan, created_at = now()",
        user_id, posting_id, document_id, view["fitScore"],
        dump(view["parts"]), view["topGap"], view["plan"])
    return view
