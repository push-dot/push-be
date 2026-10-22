ALTER TABLE approvals ADD COLUMN conversation_id uuid REFERENCES conversations(id);
ALTER TABLE approvals ADD COLUMN title text NOT NULL DEFAULT '';
ALTER TABLE approvals ADD COLUMN options jsonb NOT NULL DEFAULT '[]';
ALTER TABLE approvals ADD COLUMN option_id text;

ALTER TABLE sources ADD COLUMN page_count int;
ALTER TABLE sources ADD COLUMN origin text NOT NULL DEFAULT 'UPLOAD';
ALTER TABLE sources DROP CONSTRAINT IF EXISTS sources_origin_chk;
ALTER TABLE sources ADD CONSTRAINT sources_origin_chk CHECK (origin IN ('UPLOAD', 'AI'));

CREATE TABLE posting_fit_cache (
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    posting_id uuid NOT NULL,
    document_id uuid NOT NULL,
    fit_score numeric(3,1) NOT NULL,
    parts jsonb NOT NULL,
    top_gap text NOT NULL DEFAULT '',
    plan text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, posting_id, document_id)
);

CREATE TABLE conversation_shares (
    conversation_id uuid PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
    token_hash text NOT NULL UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now()
);
