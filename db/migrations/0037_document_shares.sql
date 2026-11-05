CREATE TABLE document_shares (
    id uuid PRIMARY KEY,
    document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    version_id uuid NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
    token_hash text NOT NULL UNIQUE,
    created_by uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    revoked_at timestamptz
);
CREATE UNIQUE INDEX document_shares_one_active
    ON document_shares (document_id)
    WHERE revoked_at IS NULL;
