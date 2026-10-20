-- Extra pgvector chunks for resumes, saved jobs, postings, and links.
-- career evidence stays in evidence_chunks. Apply on Neon before enabling
-- AI_FRAMEWORK=langchain. The VPS image sets RUN_MIGRATIONS=0.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE rag_chunks (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id),
    source_kind text NOT NULL,
    source_id uuid NOT NULL,
    seq int NOT NULL,
    title text NOT NULL DEFAULT '',
    text text NOT NULL,
    embedding vector(1536),
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT rag_chunks_kind_chk CHECK (
        source_kind IN ('resume', 'posting', 'link', 'job')),
    UNIQUE (user_id, source_kind, source_id, seq)
);

CREATE INDEX idx_rag_chunks_source
    ON rag_chunks (user_id, source_kind, source_id);
CREATE INDEX idx_rag_chunks_vec ON rag_chunks
    USING hnsw (embedding vector_cosine_ops);
