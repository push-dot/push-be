from uuid import UUID


def vector_literal(values: list[float]) -> str:
    return "[" + ",".join(repr(float(v)) for v in values) + "]"


async def lock_source(db, key: str) -> None:
    await db.q().execute("SELECT pg_advisory_xact_lock(hashtext($1))", key)


class RagNodeStore:
    def __init__(self, db):
        self.db = db

    async def replace(self, source_type: str, source_id: UUID, model: str, rows: list[dict]) -> None:
        async def work():
            q = self.db.q()
            await lock_source(self.db, f"{source_type}:{source_id}")
            user_id = rows[0]["user_id"] if rows else None
            company_id = rows[0]["company_id"] if rows else None
            if rows and (user_id is not None or company_id is not None):
                await q.execute(
                    "DELETE FROM rag_nodes WHERE source_type = $1 AND source_id = $2 "
                    "AND embedding_model = $3 AND ($4::uuid IS NULL OR user_id = $4) "
                    "AND ($5::uuid IS NULL OR company_id = $5)",
                    source_type, source_id, model, user_id, company_id)
            else:
                await q.execute(
                    "DELETE FROM rag_nodes WHERE source_type = $1 AND source_id = $2 "
                    "AND embedding_model = $3",
                    source_type, source_id, model)
            for row in rows:
                await q.execute(
                    "INSERT INTO rag_nodes (id, user_id, company_id, source_type, source_id, document_id, "
                    "plan, seq, text, metadata, embedding, embedding_model) "
                    "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::vector,$12)",
                    row["id"], row["user_id"], row["company_id"], row["source_type"], row["source_id"],
                    row["document_id"], row["plan"], row["seq"], row["text"], row["metadata"],
                    vector_literal(row["embedding"]), model)
        await self.db.run(work)

    async def sources_missing(self, model: str, after: UUID | None = None, limit: int = 100) -> list[dict]:
        rows = await self.db.q().fetch(
            "SELECT s.id, s.user_id FROM sources s WHERE NOT EXISTS ("
            "SELECT 1 FROM rag_nodes n WHERE n.source_type = 'source' AND n.source_id = s.id "
            "AND n.embedding_model = $1) AND ($2::uuid IS NULL OR s.id > $2) ORDER BY s.id LIMIT $3",
            model, after, limit)
        return [dict(r) for r in rows]

    async def _missing(self, sql: str, model: str, after: UUID | None, limit: int) -> list[dict]:
        rows = await self.db.q().fetch(sql, model, after, limit)
        return [dict(row) for row in rows]

    async def evidence_ids_missing_for_user(
        self, user_id: UUID, model: str, limit: int = 10,
    ) -> list[UUID]:
        rows = await self.db.q().fetch(
            "SELECT e.id FROM career_evidence e WHERE e.user_id = $1 "
            "AND NOT e.archived AND e.source_text <> '' "
            "AND NOT EXISTS (SELECT 1 FROM rag_nodes n "
            "WHERE n.source_type = 'evidence' AND n.source_id = e.id "
            "AND n.user_id = $1 AND n.embedding_model = $2) "
            "ORDER BY e.created_at DESC LIMIT $3",
            user_id, model, limit)
        return [row["id"] for row in rows]

    async def evidence_missing(
        self, model: str, after: UUID | None = None, limit: int = 100,
    ) -> list[dict]:
        return await self._missing(
            "SELECT e.id, e.user_id FROM career_evidence e WHERE e.archived = false AND NOT EXISTS ("
            "SELECT 1 FROM rag_nodes n WHERE n.source_type = 'evidence' AND n.source_id = e.id "
            "AND n.embedding_model = $1) AND ($2::uuid IS NULL OR e.id > $2) ORDER BY e.id LIMIT $3",
            model, after, limit)

    async def documents_missing(
        self, model: str, after: UUID | None = None, limit: int = 100,
    ) -> list[dict]:
        return await self._missing(
            "SELECT d.id, d.user_id FROM documents d "
            "JOIN document_versions v ON v.id = COALESCE(d.finalized_version_id, d.latest_version_id) "
            "WHERE NOT EXISTS (SELECT 1 FROM rag_nodes n WHERE n.source_type = 'document' "
            "AND n.source_id = d.id AND n.embedding_model = $1) "
            "AND ($2::uuid IS NULL OR d.id > $2) ORDER BY d.id LIMIT $3",
            model, after, limit)

    async def jobs_missing(
        self, model: str, after: UUID | None = None, limit: int = 100,
    ) -> list[dict]:
        return await self._missing(
            "SELECT j.id, j.user_id FROM jobs j WHERE j.archived = false AND NOT EXISTS ("
            "SELECT 1 FROM rag_nodes n WHERE n.source_type = 'job' AND n.source_id = j.id "
            "AND n.embedding_model = $1) AND ($2::uuid IS NULL OR j.id > $2) ORDER BY j.id LIMIT $3",
            model, after, limit)

    async def postings_missing(
        self, model: str, after: UUID | None = None, limit: int = 100,
    ) -> list[dict]:
        return await self._missing(
            "SELECT p.id, p.company_id FROM job_postings p WHERE NOT EXISTS ("
            "SELECT 1 FROM rag_nodes n WHERE n.source_type = 'posting' AND n.source_id = p.id "
            "AND n.embedding_model = $1) AND ($2::uuid IS NULL OR p.id > $2) ORDER BY p.id LIMIT $3",
            model, after, limit)
