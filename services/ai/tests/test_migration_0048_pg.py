"""0048 deletes orphan fit-cache rows, then the foreign keys cascade.

Runs on a migrated Postgres (BILLING_PG_URL) and rolls the trial back.
"""

import os
from pathlib import Path
from uuid import uuid4

import pytest

asyncpg = pytest.importorskip("asyncpg")
URL = os.environ.get("BILLING_PG_URL", "")
pytestmark = pytest.mark.skipif(not URL, reason="BILLING_PG_URL is not set")

SQL = (Path(__file__).resolve().parents[3] / "db" / "migrations"
       / "0048_documents_purge_index_fit_cache_fk.sql").read_text()


def statements(sql: str) -> list[str]:
    lines = [line for line in sql.splitlines() if not line.strip().startswith("--")]
    return [part.strip() for part in "\n".join(lines).split(";") if part.strip()]


@pytest.fixture
async def conn():
    connection = await asyncpg.connect(URL.replace("?sslmode=disable", "").replace("&sslmode=disable", ""))
    try:
        yield connection
    finally:
        await connection.close()


@pytest.mark.asyncio
async def test_0048_drops_orphans_then_cascades(conn):
    user, company, posting, doc = uuid4(), uuid4(), uuid4(), uuid4()
    missing_doc, missing_posting = uuid4(), uuid4()
    tx = conn.transaction()
    await tx.start()
    try:
        await conn.execute(
            "ALTER TABLE posting_fit_cache DROP CONSTRAINT IF EXISTS posting_fit_cache_document_fk")
        await conn.execute(
            "ALTER TABLE posting_fit_cache DROP CONSTRAINT IF EXISTS posting_fit_cache_posting_fk")
        await conn.execute(
            "INSERT INTO users (id, provider, provider_subject, display_name) VALUES ($1, 'test', $2, 'm')",
            user, str(user))
        await conn.execute("INSERT INTO companies (id, name) VALUES ($1, 'm')", company)
        await conn.execute(
            "INSERT INTO job_postings (id, company, title, job_category, career_min, location, employment_type, "
            "description, company_id) VALUES ($1, 'c', 't', 'dev', 0, 'Seoul', 'full_time', 'd', $2)",
            posting, company)
        await conn.execute(
            "INSERT INTO documents (id, user_id, title, kind, template, status) "
            "VALUES ($1, $2, 't', 'RESUME', 'SIMPLE', 'DRAFT')",
            doc, user)
        await conn.executemany(
            "INSERT INTO posting_fit_cache (user_id, posting_id, document_id, fit_score, parts, plan) "
            "VALUES ($1, $2, $3, 1.0, '{}'::jsonb, $4)",
            [
                (user, missing_posting, doc, "ORPHAN_POSTING"),
                (user, posting, missing_doc, "ORPHAN_DOC"),
                (user, posting, doc, "KEEP"),
            ])
        for statement in statements(SQL):
            await conn.execute(statement)
        left = await conn.fetch("SELECT plan FROM posting_fit_cache WHERE user_id = $1 ORDER BY plan", user)
        assert [row["plan"] for row in left] == ["KEEP"]
        index = await conn.fetchval("SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_documents_archived'")
        assert index is not None and "ARCHIVED" in index
        keys = await conn.fetch(
            "SELECT conname, convalidated, confdeltype FROM pg_constraint "
            "WHERE conname IN ('posting_fit_cache_document_fk', 'posting_fit_cache_posting_fk') "
            "ORDER BY conname")
        def action(value):
            return value.decode() if isinstance(value, (bytes, memoryview)) else value

        assert [(row["conname"], row["convalidated"], action(row["confdeltype"])) for row in keys] == [
            ("posting_fit_cache_document_fk", True, "c"),
            ("posting_fit_cache_posting_fk", True, "c"),
        ]
        await conn.execute("DELETE FROM documents WHERE id = $1", doc)
        assert await conn.fetchval(
            "SELECT count(*) FROM posting_fit_cache WHERE user_id = $1", user) == 0
    finally:
        await tx.rollback()
