from __future__ import annotations
from uuid import UUID, uuid4

from app.db import DB
from app.infrastructure.store_rag import EVIDENCE_SEARCH, lock_source, vector_literal


class EvidenceChunkStore:
    def __init__(self, db: DB):
        self.db = db

    async def evidence_ids_missing(self, user_id: UUID,
                                   limit: int = 50) -> list[UUID]:
        rows = await self.db.q().fetch(
            "SELECT e.id FROM career_evidence e WHERE e.user_id=$1 "
            "AND NOT e.archived AND e.source_text <> '' "
            "AND NOT EXISTS (SELECT 1 FROM evidence_chunks c "
            "              WHERE c.evidence_id = e.id) "
            "ORDER BY e.created_at DESC LIMIT $2", user_id, limit)
        return [r["id"] for r in rows]

    async def replace_chunks(self, user_id: UUID, evidence_id: UUID,
                             chunks: list[tuple[str, list[float]]]) -> None:
        async def work():
            await lock_source(self.db, f"evidence:{evidence_id}")
            await self.db.q().execute(
                "DELETE FROM evidence_chunks WHERE evidence_id=$1 AND user_id=$2",
                evidence_id, user_id)
            if not chunks:
                return
            await self.db.q().executemany(
                "INSERT INTO evidence_chunks "
                "(id, user_id, evidence_id, seq, text, embedding) "
                "VALUES ($1,$2,$3,$4,$5,$6::vector)",
                [(uuid4(), user_id, evidence_id, i, t, vector_literal(v))
                 for i, (t, v) in enumerate(chunks)])

        await self.db.do(work)

    async def search(self, user_id: UUID, vector: list[float],
                     k: int = 6) -> list[dict]:
        rows = await self.db.q().fetch(
            EVIDENCE_SEARCH, user_id, vector_literal(vector), k)
        return [dict(r) for r in rows]
