from __future__ import annotations

from uuid import UUID, uuid4

from app.db import DB


def vector_literal(vector: list[float]) -> str:
    return "[" + ",".join(str(x) for x in vector) + "]"


_EVIDENCE_SEARCH = (
    "SELECT c.text, c.evidence_id, e.title, "
    "       c.embedding <=> $2::vector AS dist "
    "FROM evidence_chunks c "
    "JOIN career_evidence e ON e.id = c.evidence_id "
    "WHERE c.user_id=$1 AND NOT e.archived "
    "AND c.embedding IS NOT NULL "
    "ORDER BY dist LIMIT $3"
)

_UNION_SEARCH = (
    "SELECT text, evidence_id, title, dist FROM ("
    "SELECT c.text, c.evidence_id, e.title, "
    "       c.embedding <=> $2::vector AS dist "
    "FROM evidence_chunks c "
    "JOIN career_evidence e ON e.id = c.evidence_id "
    "WHERE c.user_id=$1 AND NOT e.archived "
    "AND c.embedding IS NOT NULL "
    "UNION ALL "
    "SELECT r.text, r.source_id AS evidence_id, r.title, "
    "       r.embedding <=> $2::vector AS dist "
    "FROM rag_chunks r "
    "WHERE r.user_id=$1 AND r.embedding IS NOT NULL"
    ") hits ORDER BY dist LIMIT $3"
)

RESUME_SQL = (
    "SELECT s.id, s.file_name AS title, s.mime_type, s.path "
    "FROM profiles p "
    "JOIN sources s ON s.id = p.resume_source_id "
    "WHERE p.user_id = $1 "
    "AND NOT EXISTS ("
    "SELECT 1 FROM rag_chunks r "
    "WHERE r.user_id = p.user_id AND r.source_kind = 'resume' "
    "AND r.source_id = s.id) "
    "LIMIT $2"
)

JOB_SQL = (
    "SELECT j.id, j.company, j.title, j.source_text "
    "FROM jobs j "
    "WHERE j.user_id = $1 AND NOT j.archived AND j.source_text <> '' "
    "AND NOT EXISTS ("
    "SELECT 1 FROM rag_chunks r "
    "WHERE r.user_id = j.user_id AND r.source_kind = 'job' "
    "AND r.source_id = j.id) "
    "LIMIT $2"
)

POSTING_SQL = (
    "SELECT p.id, p.company, p.title, p.description "
    "FROM job_postings p "
    "WHERE p.closed_at IS NULL "
    "AND (EXISTS ("
    "SELECT 1 FROM company_members m "
    "WHERE m.company_id = p.company_id AND m.user_id = $1) OR EXISTS ("
    "SELECT 1 FROM bookmarks b "
    "WHERE b.posting_id = p.id AND b.user_id = $1)) "
    "AND NOT EXISTS ("
    "SELECT 1 FROM rag_chunks r "
    "WHERE r.user_id = $1 AND r.source_kind = 'posting' "
    "AND r.source_id = p.id) "
    "LIMIT $2"
)

LINK_SQL = (
    "SELECT l.id, l.title, l.url, l.kind "
    "FROM user_links l "
    "WHERE l.user_id = $1 "
    "AND NOT EXISTS ("
    "SELECT 1 FROM rag_chunks r "
    "WHERE r.user_id = l.user_id AND r.source_kind = 'link' "
    "AND r.source_id = l.id) "
    "LIMIT $2"
)

_MISSING = {
    "resume": RESUME_SQL,
    "job": JOB_SQL,
    "posting": POSTING_SQL,
    "link": LINK_SQL,
}


class RagStore:
    """pgvector retrieval over evidence_chunks and rag_chunks.

    LlamaIndex's PGVectorStore expects its own table shape. This store keeps
    the existing evidence_chunks rows and adds rag_chunks for resumes,
    postings, and links.
    """

    def __init__(self, db: DB):
        self.db = db

    async def search(self, user_id: UUID, vector: list[float],
                     k: int = 6) -> list[dict]:
        vec = vector_literal(vector)
        try:
            rows = await self.db.q().fetch(_UNION_SEARCH, user_id, vec, k)
        except Exception:
            rows = await self.db.q().fetch(_EVIDENCE_SEARCH, user_id, vec, k)
        return [dict(r) for r in rows]

    async def replace(self, user_id: UUID, kind: str, source_id: UUID,
                      title: str, chunks: list[tuple[str, list[float]]]) -> None:
        await self.db.q().execute(
            "DELETE FROM rag_chunks WHERE user_id=$1 AND source_kind=$2 "
            "AND source_id=$3",
            user_id, kind, source_id)
        if not chunks:
            return
        await self.db.q().executemany(
            "INSERT INTO rag_chunks "
            "(id, user_id, source_kind, source_id, seq, title, text, embedding) "
            "VALUES ($1,$2,$3,$4,$5,$6,$7,$8::vector)",
            [(uuid4(), user_id, kind, source_id, i, title, text,
              vector_literal(vec))
             for i, (text, vec) in enumerate(chunks)])

    async def missing(self, kind: str, user_id: UUID, limit: int) -> list[dict]:
        try:
            rows = await self.db.q().fetch(_MISSING[kind], user_id, limit)
        except Exception:
            return []
        return [dict(r) for r in rows]
