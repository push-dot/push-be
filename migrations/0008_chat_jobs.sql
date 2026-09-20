CREATE TABLE chat_jobs (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id),
    conversation_id uuid NOT NULL REFERENCES conversations(id),
    payload jsonb NOT NULL,
    status text NOT NULL DEFAULT 'PENDING',
    attempt int NOT NULL DEFAULT 0,
    run_at timestamptz NOT NULL DEFAULT now(),
    error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_chat_jobs_claim ON chat_jobs (status, run_at) WHERE status = 'PENDING';

CREATE TABLE chat_events (
    id bigserial PRIMARY KEY,
    job_id uuid NOT NULL REFERENCES chat_jobs(id),
    type text NOT NULL,
    payload jsonb NOT NULL DEFAULT '{}',
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_chat_events_job ON chat_events (job_id, id);
