CREATE TABLE ai_jobs (
    id uuid PRIMARY KEY,
    type text NOT NULL,
    queue text NOT NULL,
    user_id uuid NOT NULL REFERENCES users(id),
    company_id uuid NULL REFERENCES companies(id) ON DELETE SET NULL,
    plan text NULL,
    status text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED', 'RUNNING', 'RETRY', 'DONE', 'FAILED', 'DEAD', 'CANCELLED')),
    attempts int NOT NULL DEFAULT 0,
    max_attempts int NOT NULL,
    run_after timestamptz NOT NULL DEFAULT now(),
    heartbeat_at timestamptz NULL,
    payload jsonb NOT NULL,
    result jsonb NULL,
    error jsonb NULL,
    idempotency_key text NULL,
    conversation_id uuid NULL REFERENCES conversations(id),
    checkpoint jsonb NOT NULL DEFAULT '{}',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, idempotency_key)
);

CREATE INDEX idx_ai_jobs_queued ON ai_jobs (queue, run_after) WHERE status IN ('QUEUED', 'RETRY');

CREATE TABLE outbox (
    id bigserial PRIMARY KEY,
    job_id uuid NOT NULL REFERENCES ai_jobs(id) ON DELETE CASCADE,
    queue text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    dispatched_at timestamptz NULL
);

CREATE INDEX idx_outbox_pending ON outbox (id) WHERE dispatched_at IS NULL;

CREATE TABLE credit_reservations (
    job_id uuid PRIMARY KEY REFERENCES ai_jobs(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES users(id),
    company_id uuid NULL REFERENCES companies(id) ON DELETE SET NULL,
    amount_micro bigint NOT NULL,
    status text NOT NULL CHECK (status IN ('RESERVED', 'SETTLED', 'RELEASED')),
    settled_micro bigint NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION notify_outbox() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_notify('outbox', NEW.id::text);
    RETURN NEW;
END;
$$;

CREATE TRIGGER outbox_notify
AFTER INSERT ON outbox
FOR EACH ROW EXECUTE FUNCTION notify_outbox();

ALTER TABLE ai_usage ADD COLUMN job_id uuid NULL REFERENCES ai_jobs(id);

INSERT INTO ai_jobs (
    id, type, queue, user_id, status, attempts, max_attempts, run_after,
    payload, error, conversation_id, checkpoint, created_at, updated_at
)
SELECT
    id,
    'chat',
    'q:chat',
    user_id,
    CASE status
        WHEN 'PENDING' THEN 'QUEUED'
        WHEN 'RUNNING' THEN 'RUNNING'
        WHEN 'FAILED' THEN 'FAILED'
        WHEN 'CANCELLED' THEN 'CANCELLED'
        WHEN 'DONE' THEN 'DONE'
        ELSE 'QUEUED'
    END,
    attempt,
    3,
    run_at,
    payload,
    CASE WHEN error IS NULL THEN NULL ELSE jsonb_build_object('message', error) END,
    conversation_id,
    COALESCE(checkpoint, '{}'::jsonb),
    created_at,
    updated_at
FROM chat_jobs;

ALTER TABLE chat_events DROP CONSTRAINT chat_events_job_id_fkey;
ALTER TABLE chat_events
    ADD CONSTRAINT chat_events_job_id_fkey FOREIGN KEY (job_id) REFERENCES ai_jobs(id);

DROP TABLE chat_jobs;

CREATE VIEW chat_jobs AS
SELECT
    id,
    user_id,
    conversation_id,
    payload,
    CASE status
        WHEN 'QUEUED' THEN 'PENDING'
        WHEN 'RETRY' THEN 'PENDING'
        WHEN 'DEAD' THEN 'FAILED'
        ELSE status
    END AS status,
    attempts AS attempt,
    run_after AS run_at,
    error->>'message' AS error,
    created_at,
    updated_at,
    checkpoint
FROM ai_jobs
WHERE type = 'chat' AND conversation_id IS NOT NULL;

CREATE FUNCTION chat_jobs_view_status(old_status text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE old_status
        WHEN 'PENDING' THEN 'QUEUED'
        WHEN 'QUEUED' THEN 'QUEUED'
        WHEN 'RUNNING' THEN 'RUNNING'
        WHEN 'RETRY' THEN 'RETRY'
        WHEN 'DONE' THEN 'DONE'
        WHEN 'FAILED' THEN 'FAILED'
        WHEN 'DEAD' THEN 'DEAD'
        WHEN 'CANCELLED' THEN 'CANCELLED'
        ELSE 'QUEUED'
    END;
$$;

CREATE FUNCTION chat_jobs_view_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO ai_jobs (
        id, type, queue, user_id, status, attempts, max_attempts, run_after,
        payload, error, conversation_id, checkpoint, created_at, updated_at
    ) VALUES (
        NEW.id,
        'chat',
        'q:chat',
        NEW.user_id,
        chat_jobs_view_status(NEW.status),
        COALESCE(NEW.attempt, 0),
        3,
        COALESCE(NEW.run_at, now()),
        COALESCE(NEW.payload, '{}'::jsonb),
        CASE WHEN NEW.error IS NULL THEN NULL ELSE jsonb_build_object('message', NEW.error) END,
        NEW.conversation_id,
        COALESCE(NEW.checkpoint, '{}'::jsonb),
        COALESCE(NEW.created_at, now()),
        COALESCE(NEW.updated_at, now())
    );
    RETURN NEW;
END;
$$;

CREATE FUNCTION chat_jobs_view_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    UPDATE ai_jobs SET
        user_id = NEW.user_id,
        conversation_id = NEW.conversation_id,
        payload = COALESCE(NEW.payload, '{}'::jsonb),
        status = chat_jobs_view_status(NEW.status),
        attempts = COALESCE(NEW.attempt, 0),
        run_after = COALESCE(NEW.run_at, now()),
        error = CASE WHEN NEW.error IS NULL THEN NULL ELSE jsonb_build_object('message', NEW.error) END,
        checkpoint = COALESCE(NEW.checkpoint, '{}'::jsonb),
        updated_at = COALESCE(NEW.updated_at, now())
    WHERE id = OLD.id;
    RETURN NEW;
END;
$$;

CREATE FUNCTION chat_jobs_view_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    DELETE FROM ai_jobs WHERE id = OLD.id;
    RETURN OLD;
END;
$$;

CREATE TRIGGER chat_jobs_insert
INSTEAD OF INSERT ON chat_jobs
FOR EACH ROW EXECUTE FUNCTION chat_jobs_view_insert();

CREATE TRIGGER chat_jobs_update
INSTEAD OF UPDATE ON chat_jobs
FOR EACH ROW EXECUTE FUNCTION chat_jobs_view_update();

CREATE TRIGGER chat_jobs_delete
INSTEAD OF DELETE ON chat_jobs
FOR EACH ROW EXECUTE FUNCTION chat_jobs_view_delete();
