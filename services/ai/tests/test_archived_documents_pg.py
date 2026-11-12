"""Archived documents leave search, matching and the prompt, on a migrated Postgres.

CI test-db sets BILLING_PG_URL; elsewhere these tests skip.
"""

import os
from types import SimpleNamespace
from uuid import uuid4

import pytest

from app.domain.errors import DomainError
from app.rag.pipeline import Ingestor
from app.rag.readers import read_document
from app.rag.store import RagNodeStore, vector_literal
from app.workers.handlers.ingest import make_ingest

asyncpg = pytest.importorskip("asyncpg")
URL = os.environ.get("BILLING_PG_URL", "")
pytestmark = pytest.mark.skipif(not URL, reason="BILLING_PG_URL is not set")

MODEL = "archived-test-model"
VECTOR = [1.0] + [0.0] * 1023


class Embedder:
    model = MODEL

    async def embed(self, texts):
        return [VECTOR for _ in texts]


@pytest.fixture
async def db():
    from app.db import DB, _init_conn

    pool = await asyncpg.create_pool(URL, init=_init_conn, min_size=0, max_size=2)
    try:
        yield DB(pool)
    finally:
        await pool.close()


async def seed_user(db) -> object:
    user = uuid4()
    await db.q().execute(
        "INSERT INTO users (id, provider, provider_subject, display_name) VALUES ($1, 'test', $2, 'a')",
        user,
        str(user),
    )
    return user


async def seed_document(db, user, status="DRAFT") -> object:
    doc = uuid4()
    version = uuid4()
    await db.q().execute(
        "INSERT INTO documents (id, user_id, title, kind, template, status) "
        "VALUES ($1, $2, '결제 서버 이력서', 'RESUME', 'SIMPLE', $3)",
        doc,
        user,
        status,
    )
    await db.q().execute(
        "INSERT INTO document_versions (id, user_id, document_id, number, content, blocks) "
        "VALUES ($1, $2, $3, 1, $4::jsonb, $5::jsonb)",
        version,
        user,
        doc,
        {
            "type": "doc",
            "content": [
                {
                    "type": "paragraph",
                    "content": [{"type": "text", "text": "결제 서버를 만들었어요"}],
                }
            ],
        },
        [{"id": "b1", "text": "결제 서버를 만들었어요"}],
    )
    await db.q().execute("UPDATE documents SET latest_version_id = $1 WHERE id = $2", version, doc)
    return doc


async def seed_posting(db) -> object:
    company = uuid4()
    posting = uuid4()
    await db.q().execute("INSERT INTO companies (id, name) VALUES ($1, 'archived test')", company)
    await db.q().execute(
        "INSERT INTO job_postings (id, company, title, job_category, career_min, location, employment_type, "
        "description, company_id, status) VALUES ($1, 'c', '백엔드', 'dev', 0, 'Seoul', 'full_time', 'd', $2, 'OPEN')",
        posting,
        company,
    )
    await db.q().execute(
        "INSERT INTO rag_nodes (id, company_id, source_type, source_id, seq, text, embedding, embedding_model) "
        "VALUES ($1, $2, 'posting', $3, 0, '백엔드', $4::vector, $5)",
        uuid4(),
        company,
        posting,
        vector_literal(VECTOR),
        MODEL,
    )
    return posting


async def nodes(db, kind, source_id) -> int:
    return await db.q().fetchval(
        "SELECT count(*) FROM rag_nodes WHERE source_type = $1 AND source_id = $2", kind, source_id
    )


async def ingest_document(db, user, doc):
    store = RagNodeStore(db)

    async def beat():
        return None

    handle = make_ingest(db.q, store, Ingestor(store, Embedder()), None)
    job = {"id": uuid4(), "user_id": user, "company_id": None, "payload": {"documentId": str(doc)}}
    return await handle(SimpleNamespace(job=job, heartbeat=beat))


async def test_document_nodes_carry_the_document_id_so_quick_match_finds_postings(db):
    from app.infrastructure.posting_match import load_corpus

    user = await seed_user(db)
    doc = await seed_document(db, user)
    posting = await seed_posting(db)
    assert (await ingest_document(db, user, doc))["nodes"] == 1
    assert (
        await db.q().fetchval(
            "SELECT document_id FROM rag_nodes WHERE source_type = 'document' AND source_id = $1",
            doc,
        )
        == doc
    )
    rows, _ = await load_corpus(db.q(), user, doc)
    assert posting in [row["id"] for row in rows]


async def test_archiving_drops_the_search_nodes_of_documents_evidence_and_jobs(db):
    user = await seed_user(db)
    doc = await seed_document(db, user)
    evidence = uuid4()
    job = uuid4()
    await db.q().execute(
        "INSERT INTO career_evidence (id, user_id, kind, title, source_text) VALUES ($1, $2, 'PROJECT', 't', 's')",
        evidence,
        user,
    )
    await db.q().execute(
        "INSERT INTO jobs (id, user_id, company, title, source_kind, source_text) VALUES ($1, $2, 'c', 't', 'TEXT', 's')",
        job,
        user,
    )
    for kind, source in (("document", doc), ("evidence", evidence), ("job", job)):
        await db.q().execute(
            "INSERT INTO rag_nodes (id, user_id, source_type, source_id, seq, text, embedding, embedding_model) "
            "VALUES ($1, $2, $3, $4, 0, 't', $5::vector, $6)",
            uuid4(),
            user,
            kind,
            source,
            vector_literal(VECTOR),
            MODEL,
        )

    await db.q().execute("UPDATE documents SET status = 'ARCHIVED' WHERE id = $1", doc)
    await db.q().execute("UPDATE career_evidence SET archived = true WHERE id = $1", evidence)
    await db.q().execute("UPDATE jobs SET archived = true WHERE id = $1", job)

    assert [
        await nodes(db, "document", doc),
        await nodes(db, "evidence", evidence),
        await nodes(db, "job", job),
    ] == [0, 0, 0]


async def test_archived_documents_are_not_read_or_reindexed(db):
    user = await seed_user(db)
    doc = await seed_document(db, user, status="ARCHIVED")
    store = RagNodeStore(db)
    assert await read_document(db.q(), doc) is None
    missing = await store.documents_missing(MODEL, after=None, limit=10_000)
    assert doc not in [row["id"] for row in missing]


async def test_quick_match_refuses_an_archived_or_foreign_document(db):
    from app.domain.services.posting_match import run_quick_match

    user = await seed_user(db)
    other = await seed_user(db)
    archived = await seed_document(db, user, status="ARCHIVED")
    foreign = await seed_document(db, other)
    with pytest.raises(DomainError) as gone:
        await run_quick_match(db, str(user), {"documentId": str(archived)})
    assert gone.value.code == "INVALID_TRANSITION"
    with pytest.raises(DomainError) as theirs:
        await run_quick_match(db, str(user), {"documentId": str(foreign)})
    assert theirs.value.code == "NOT_FOUND"


async def test_chat_document_context_reads_only_the_callers_live_documents(db):
    from app.harness.personal.resume.profile_document import load_document_markdown

    user = await seed_user(db)
    other = await seed_user(db)
    live = await seed_document(db, user)
    archived = await seed_document(db, user, status="ARCHIVED")
    foreign = await seed_document(db, other)

    async def read(doc):
        return await load_document_markdown(
            db, {"user_id": str(user), "inputs": {"documentId": str(doc)}}
        )

    assert "결제 서버" in await read(live)
    assert await read(foreign) == ""
    assert await read(archived) == ""


async def test_reingest_after_restore_brings_the_document_nodes_back(db):
    """Archive drops the nodes (0046). Restore's status SQL plus the ingest job brings them back."""
    from app.infrastructure.posting_match import load_corpus

    user = await seed_user(db)
    doc = await seed_document(db, user)
    posting = await seed_posting(db)
    assert (await ingest_document(db, user, doc))["nodes"] == 1
    await db.q().execute("UPDATE documents SET status = 'ARCHIVED' WHERE id = $1", doc)
    assert await nodes(db, "document", doc) == 0
    await db.q().execute(
        "UPDATE documents SET revision = revision + 1, "
        "status = CASE WHEN finalized_version_id IS NOT NULL THEN 'FINALIZED' ELSE 'DRAFT' END, "
        "updated_at = now() WHERE id = $1 AND status = 'ARCHIVED'",
        doc,
    )
    assert (await ingest_document(db, user, doc))["nodes"] == 1
    rows, _ = await load_corpus(db.q(), user, doc)
    assert posting in [row["id"] for row in rows]


async def test_a_document_archived_while_it_is_embedded_keeps_no_nodes(db):
    user = await seed_user(db)
    doc = await seed_document(db, user)
    store = RagNodeStore(db)

    class ArchivingEmbedder(Embedder):
        async def embed(self, texts):
            await db.q().execute("UPDATE documents SET status = 'ARCHIVED' WHERE id = $1", doc)
            return await super().embed(texts)

    async def beat():
        return None

    handle = make_ingest(db.q, store, Ingestor(store, ArchivingEmbedder()), None)
    job = {"id": uuid4(), "user_id": user, "company_id": None, "payload": {"documentId": str(doc)}}
    await handle(SimpleNamespace(job=job, heartbeat=beat))
    assert await nodes(db, "document", doc) == 0
