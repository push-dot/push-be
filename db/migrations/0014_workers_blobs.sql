ALTER TABLE chat_jobs ADD COLUMN checkpoint jsonb NOT NULL DEFAULT '{}';

ALTER TABLE sources ADD COLUMN content bytea;

CREATE TABLE workspace_files (
    conversation_id uuid NOT NULL,
    name text NOT NULL,
    body text,
    content bytea,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (conversation_id, name)
);
