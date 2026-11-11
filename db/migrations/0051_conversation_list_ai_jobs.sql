-- Conversation list (gateway): owner-wide pending queue and per-row active job lookups.
-- chat_jobs is a view over ai_jobs (0023); indexes belong on ai_jobs.
-- Apply off-peak; run_migrations wraps each file in a transaction (no CONCURRENTLY).

-- chat_jobs maps QUEUED+RETRY -> PENDING and leaves RUNNING as RUNNING (0023).
CREATE INDEX IF NOT EXISTS idx_ai_jobs_owner_pending ON ai_jobs (created_at)
    WHERE type IN ('chat', 'employer_ai') AND status IN ('QUEUED', 'RETRY') AND conversation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ai_jobs_conv_active ON ai_jobs (conversation_id, created_at DESC)
    WHERE type IN ('chat', 'employer_ai') AND status IN ('QUEUED', 'RETRY', 'RUNNING') AND conversation_id IS NOT NULL;
