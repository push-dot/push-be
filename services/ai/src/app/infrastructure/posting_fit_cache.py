from uuid import UUID

from app.domain import posting_fit as fit
from app.framework.fit_judge import judge_fit
from app.jsonutil import dump

_CACHED = (
    "SELECT c.fit_score, c.parts, c.top_gap, c.plan FROM posting_fit_cache c "
    "JOIN documents d ON d.id = c.document_id "
    "JOIN job_postings p ON p.id = c.posting_id "
    "WHERE c.user_id = $1 AND c.posting_id = $2 AND c.document_id = $3 "
    "AND c.plan = $4 "
    "AND c.created_at >= d.updated_at "
    "AND c.posting_revision = p.revision")

# One round trip for the inputs; the document must belong to the user.
_INPUTS = (
    "SELECT p.requirements, p.skills, p.description, p.revision, v.content, u.plan "
    "FROM job_postings p, documents d "
    "JOIN document_versions v ON v.id = d.latest_version_id "
    "JOIN users u ON u.id = d.user_id "
    "WHERE p.id = $2 AND d.id = $3 AND d.user_id = $1")

_COMPANY_POSTING = (
    "SELECT requirements, skills, description FROM job_postings "
    "WHERE id = $1 AND company_id = $2")

_PLAN = "SELECT plan FROM users WHERE id = $1"


async def read_plan(query, user_id) -> str:
    if query is None or user_id is None:
        return "FREE"
    row = await query.fetchrow(_PLAN, user_id)
    if row is None:
        return "FREE"
    return fit.plan_name(row["plan"])


async def company_posting(query, posting_id, company_id):
    if query is None or posting_id is None or company_id is None:
        return None
    return await query.fetchrow(_COMPANY_POSTING, posting_id, company_id)


async def load_fit(
    query, user_id: UUID, posting_id: UUID, document_id: UUID, *,
    gate=None, job_id=None, cls=None,
) -> dict | None:
    row = await query.fetchrow(_INPUTS, user_id, posting_id, document_id)
    if row is None:
        return None
    plan = fit.plan_name(row["plan"])
    cached = await query.fetchrow(_CACHED, user_id, posting_id, document_id, plan)
    if cached is not None:
        return fit.cached_view(cached)
    view = await judge_fit(
        row["requirements"], row["skills"], row["description"], row["content"], plan,
        gate=gate, job_id=job_id, user_id=user_id, cls=cls)
    await query.execute(
        "INSERT INTO posting_fit_cache "
        "(user_id, posting_id, document_id, fit_score, parts, top_gap, plan, "
        "posting_revision) "
        "VALUES ($1, $2, $3, $4, $5, $6, $7, $8) "
        "ON CONFLICT (user_id, posting_id, document_id, plan) DO UPDATE SET "
        "fit_score = EXCLUDED.fit_score, parts = EXCLUDED.parts, "
        "top_gap = EXCLUDED.top_gap, plan = EXCLUDED.plan, "
        "posting_revision = EXCLUDED.posting_revision, created_at = now()",
        user_id, posting_id, document_id, view["fitScore"],
        dump(view["parts"]), view["topGap"], view["plan"], int(row["revision"]))
    return view
