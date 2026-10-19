CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE evidence_chunks (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id),
    evidence_id uuid NOT NULL REFERENCES career_evidence(id) ON DELETE CASCADE,
    seq int NOT NULL,
    text text NOT NULL,
    embedding vector(1536),
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_evidence_chunks_ev ON evidence_chunks (evidence_id);
CREATE INDEX idx_evidence_chunks_vec ON evidence_chunks
    USING hnsw (embedding vector_cosine_ops);
