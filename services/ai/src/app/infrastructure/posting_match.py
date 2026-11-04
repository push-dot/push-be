from __future__ import annotations

# shortcut: cross join of every open posting, switch to ANN when open postings pass a few thousand.

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
    "GROUP BY p.id"
)

_LATEST_DOCUMENT = (
    "SELECT id FROM documents WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 1")

_USER_KINDS = ["document", "evidence"]


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
    rows = await query.fetch(POSTING_MATCH_SQL, user_id, _USER_KINDS, document_id)
    return [dict(row) for row in rows], []
