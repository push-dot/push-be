-- LlamaIndex RAG nodes, embedded with BAAI/bge-m3 (1024 dimensions) by default.
-- Every row has a tenant: a user, a company, or both. Search must filter on one.
-- rag_chunks (1536) stays until RAG_ENGINE=llamaindex is confirmed, then it is dropped.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE rag_nodes (
    id uuid PRIMARY KEY,
    user_id uuid NULL REFERENCES users(id) ON DELETE CASCADE,
    company_id uuid NULL REFERENCES companies(id) ON DELETE CASCADE,
    source_type text NOT NULL,
    source_id uuid NOT NULL,
    document_id uuid NULL,
    plan text NULL,
    seq int NOT NULL,
    text text NOT NULL,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    embedding vector(1024) NOT NULL,
    embedding_model text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT rag_nodes_tenant_chk CHECK (user_id IS NOT NULL OR company_id IS NOT NULL),
    UNIQUE (source_type, source_id, embedding_model, seq)
);

CREATE INDEX idx_rag_nodes_user ON rag_nodes (user_id, embedding_model) WHERE user_id IS NOT NULL;
CREATE INDEX idx_rag_nodes_company ON rag_nodes (company_id, embedding_model) WHERE company_id IS NOT NULL;
CREATE INDEX idx_rag_nodes_source ON rag_nodes (source_type, source_id);
CREATE INDEX idx_rag_nodes_embedding ON rag_nodes USING hnsw (embedding vector_cosine_ops);
CREATE INDEX idx_rag_nodes_text_trgm ON rag_nodes USING gin (text gin_trgm_ops);

CREATE FUNCTION rag_nodes_drop_source() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    DELETE FROM rag_nodes WHERE source_type = 'source' AND source_id = OLD.id;
    RETURN OLD;
END;
$$;

CREATE TRIGGER rag_nodes_drop_source
AFTER DELETE ON sources
FOR EACH ROW EXECUTE FUNCTION rag_nodes_drop_source();
