-- Indexes for AI runtime lookups that scanned whole tables.
-- chat_jobs is a view over ai_jobs (0023), so its indexes live on ai_jobs.
CREATE INDEX IF NOT EXISTS idx_gap_analyses_application ON gap_analyses (application_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_ai_usage_reserved ON ai_usage (created_at) WHERE status = 'RESERVED';
CREATE INDEX IF NOT EXISTS idx_access_tokens_refresh ON access_tokens (refresh_token_id);
CREATE INDEX IF NOT EXISTS idx_access_tokens_user ON access_tokens (user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_active ON refresh_tokens (user_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_users_stripe_customer ON users (stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_evidence_chunks_user ON evidence_chunks (user_id);
CREATE INDEX IF NOT EXISTS idx_interviews_user_list ON interviews (user_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_calendar_events_user_list ON calendar_events (user_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_ai_jobs_conversation ON ai_jobs (conversation_id, created_at DESC);
