from uuid import UUID


def vector_literal(values: list[float]) -> str:
    return "[" + ",".join(repr(float(v)) for v in values) + "]"


class RagNodeStore:
    def __init__(self, db):
        self.db = db

    async def replace(self, source_type: str, source_id: UUID, model: str, rows: list[dict]) -> None:
        async def work():
            q = self.db.q()
            await q.execute(
                "DELETE FROM rag_nodes WHERE source_type = $1 AND source_id = $2 AND embedding_model = $3",
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
