CREATE TABLE bots (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id),
    kind text NOT NULL,
    company_id uuid REFERENCES companies(id),
    company_name text NOT NULL DEFAULT '',
    posting_id uuid REFERENCES job_postings(id),
    posting_url text,
    display_name text NOT NULL,
    avatar_key text,
    mascot_key text,
    notifications_muted boolean NOT NULL DEFAULT false,
    revision bigint NOT NULL DEFAULT 1,
    deleted_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT bots_kind_chk CHECK (kind IN ('push', 'company')),
    CONSTRAINT bots_display_name_chk CHECK (char_length(display_name) >= 1 AND char_length(display_name) <= 120),
    CONSTRAINT bots_company_name_chk CHECK (char_length(company_name) <= 200),
    CONSTRAINT bots_posting_url_chk CHECK (posting_url IS NULL OR char_length(posting_url) <= 2000),
    CONSTRAINT bots_company_posting_chk CHECK (
        kind = 'push' OR (company_name <> '' OR company_id IS NOT NULL)
    )
);

CREATE UNIQUE INDEX idx_bots_push_user ON bots (user_id) WHERE kind = 'push' AND deleted_at IS NULL;
CREATE INDEX idx_bots_user_list ON bots (user_id, kind, updated_at DESC, id DESC) WHERE deleted_at IS NULL;

CREATE TABLE bot_read_markers (
    user_id uuid NOT NULL REFERENCES users(id),
    bot_id uuid NOT NULL REFERENCES bots(id),
    read_at timestamptz NOT NULL,
    PRIMARY KEY (user_id, bot_id)
);

ALTER TABLE conversations ADD COLUMN bot_id uuid REFERENCES bots(id);
CREATE INDEX idx_conversations_bot_list ON conversations (bot_id, updated_at DESC, id DESC) WHERE bot_id IS NOT NULL;
