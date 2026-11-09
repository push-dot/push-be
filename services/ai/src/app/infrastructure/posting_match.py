from __future__ import annotations

from app.domain.errors import invalid_transition, not_found
from app.domain.posting_match import CANDIDATE_CAP

# shortcut: LIMIT 60 trims the cross join, switch to ANN when open postings pass a few thousand.

POSTING_MATCH_SQL = (
    "SELECT p.id, p.company, p.title, p.job_category, p.career_min, p.career_max, "
    "p.location, p.skills, p.description, p.status, p.closed_at, p.requirements, p.revision, "
    "max(1 - (posting.embedding <=> user_node.embedding)) AS similarity "
    "FROM job_postings p "
    "JOIN rag_nodes posting ON posting.source_type = 'posting' AND posting.source_id = p.id "
    "JOIN rag_nodes user_node ON user_node.user_id = $1 "
    "AND user_node.source_type = ANY($2::text[]) "
    "AND ($3::uuid IS NULL OR user_node.document_id = $3) "
    "WHERE p.status = 'OPEN' AND p.closed_at IS NULL "
    "GROUP BY p.id "
    "ORDER BY similarity DESC "
    "LIMIT $4"
)

_LATEST_DOCUMENT = (
    "SELECT id FROM documents WHERE user_id = $1 AND status <> 'ARCHIVED' "
    "ORDER BY updated_at DESC LIMIT 1")

_DOCUMENT_STATUS = "SELECT status FROM documents WHERE id = $1 AND user_id = $2"

_USER_KINDS = ["document", "evidence"]


async def require_live_document(query, user_id, document_id) -> None:
    """The caller's document, not archived: core-api rejects the same ids with the same codes."""
    row = await query.fetchrow(_DOCUMENT_STATUS, document_id, user_id)
    if row is None:
        raise not_found()
    if row["status"] == "ARCHIVED":
        raise invalid_transition("document is archived")


async def latest_document_id(query, user_id):
    if query is None or user_id is None:
        return None
    row = await query.fetchrow(_LATEST_DOCUMENT, user_id)
    if row is None:
        return None
    return row["id"]


async def load_corpus(query, user_id, document_id):
    if query is None or user_id is None:
        return [], []
    rows = await query.fetch(
        POSTING_MATCH_SQL, user_id, _USER_KINDS, document_id, CANDIDATE_CAP)
    return [dict(row) for row in rows], []
