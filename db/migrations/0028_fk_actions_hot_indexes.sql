-- Foreign-key delete actions that 0018 got wrong, and indexes for hot queries.
-- run_migrations wraps each file in a transaction, so CREATE INDEX IF NOT EXISTS cannot be
-- CONCURRENTLY: each statement blocks writes on its table while it builds.
-- Apply off-peak. db/tests/schema_checks.sql guards the delete actions.
-- 0027_ai_runtime_indexes.sql (audit/ai-runtime) adds the gap_analyses, ai_usage reserved,
-- token, stripe, evidence_chunks, interviews, calendar and ai_jobs conversation indexes.

-- 0018 turned every FK into a user-owned table into ON DELETE CASCADE. For
-- these, the child is owned by someone else, so the cascade destroys data:
--   DELETE FROM sources (removing a resume file) deleted the whole profile;
--   deleting a posting would delete candidates' saved jobs, applications and offers.
ALTER TABLE profiles DROP CONSTRAINT profiles_resume_source_id_fkey,
    ADD CONSTRAINT profiles_resume_source_id_fkey FOREIGN KEY (resume_source_id)
        REFERENCES sources(id) ON DELETE SET NULL;
ALTER TABLE jobs DROP CONSTRAINT jobs_source_posting_fk,
    ADD CONSTRAINT jobs_source_posting_fk FOREIGN KEY (source_posting_id)
        REFERENCES job_postings(id) ON DELETE SET NULL;
ALTER TABLE offers DROP CONSTRAINT offers_posting_id_fkey,
    ADD CONSTRAINT offers_posting_id_fkey FOREIGN KEY (posting_id)
        REFERENCES job_postings(id) ON DELETE SET NULL;

-- FKs added after 0018 default to NO ACTION, which blocks deleting the parent.
ALTER TABLE approvals DROP CONSTRAINT approvals_conversation_id_fkey,
    ADD CONSTRAINT approvals_conversation_id_fkey FOREIGN KEY (conversation_id)
        REFERENCES conversations(id) ON DELETE CASCADE;
ALTER TABLE conversations DROP CONSTRAINT conversations_posting_id_fkey,
    ADD CONSTRAINT conversations_posting_id_fkey FOREIGN KEY (posting_id)
        REFERENCES job_postings(id) ON DELETE SET NULL;
-- Company deletion follows the 0018 user policy: owned rows go, payment records stay.
ALTER TABLE conversations DROP CONSTRAINT conversations_company_id_fkey,
    ADD CONSTRAINT conversations_company_id_fkey FOREIGN KEY (company_id)
        REFERENCES companies(id) ON DELETE CASCADE;
ALTER TABLE job_postings DROP CONSTRAINT job_postings_company_fk,
    ADD CONSTRAINT job_postings_company_fk FOREIGN KEY (company_id)
        REFERENCES companies(id) ON DELETE CASCADE;
ALTER TABLE billing_ledger DROP CONSTRAINT billing_ledger_company_id_fkey,
    ADD CONSTRAINT billing_ledger_company_id_fkey FOREIGN KEY (company_id)
        REFERENCES companies(id) ON DELETE SET NULL;

-- Conversation list (gateway): per-row status subqueries and the page order.
CREATE INDEX IF NOT EXISTS idx_approvals_conversation_pending ON approvals (conversation_id)
    WHERE status = 'PENDING';
CREATE INDEX IF NOT EXISTS idx_conversations_user_updated ON conversations (user_id, updated_at DESC, id DESC)
    WHERE archived = false AND company_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_conversations_company_updated ON conversations (company_id, updated_at DESC, id DESC)
    WHERE archived = false AND company_id IS NOT NULL;

-- Queue and credit paths: sweepers on every worker loop, balance on every AI call.
CREATE INDEX IF NOT EXISTS idx_approvals_pending_expiry ON approvals (expires_at) WHERE status = 'PENDING';
CREATE INDEX IF NOT EXISTS idx_ai_jobs_running_heartbeat ON ai_jobs (heartbeat_at) WHERE status = 'RUNNING';
CREATE INDEX IF NOT EXISTS idx_ai_usage_settled ON ai_usage (user_id) INCLUDE (cost_micro_credits)
    WHERE status = 'SETTLED';
CREATE INDEX IF NOT EXISTS idx_ai_usage_job ON ai_usage (job_id) WHERE job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_credit_reservations_user ON credit_reservations (user_id, status);
CREATE INDEX IF NOT EXISTS idx_credit_reservations_company ON credit_reservations (company_id, status)
    WHERE company_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_outbox_job ON outbox (job_id);
CREATE INDEX IF NOT EXISTS idx_outbox_dispatched ON outbox (dispatched_at) WHERE dispatched_at IS NOT NULL;

-- Email login.
CREATE INDEX IF NOT EXISTS idx_email_signups_email_lower ON email_signups (lower(email));

-- Lists and per-row subqueries without a matching index.
CREATE INDEX IF NOT EXISTS idx_jobs_source_posting ON jobs (source_posting_id) WHERE source_posting_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_applications_job ON applications (job_id);
CREATE INDEX IF NOT EXISTS idx_sources_list ON sources (user_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_interviews_application ON interviews (application_id);
CREATE INDEX IF NOT EXISTS idx_project_blueprints_list ON project_blueprints (user_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_cli_runs_project ON cli_runs (project_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_project_evidence_project ON project_evidence (project_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_document_exports_document ON document_exports (document_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_submissions_application ON submissions (application_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_profiles_updated ON profiles (updated_at DESC, user_id DESC);
CREATE INDEX IF NOT EXISTS idx_profiles_resume_source ON profiles (resume_source_id) WHERE resume_source_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_company_invites_company ON company_invites (company_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_conversation_attachments_conversation ON conversation_attachments (conversation_id);
CREATE INDEX IF NOT EXISTS idx_iap_subscriptions_user ON iap_subscriptions (user_id);

-- Cron and webhooks.
CREATE INDEX IF NOT EXISTS idx_calendar_events_remind ON calendar_events (remind_at) WHERE remind_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_postings_open_deadline ON job_postings (deadline) WHERE closed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_bookmarks_posting ON bookmarks (posting_id);
CREATE INDEX IF NOT EXISTS idx_companies_stripe_customer ON companies (stripe_customer_id)
    WHERE stripe_customer_id IS NOT NULL;

-- Account purge deletes users in batches; each cascade scans these tables per user.
CREATE INDEX IF NOT EXISTS idx_messages_user ON messages (user_id);
CREATE INDEX IF NOT EXISTS idx_operations_user ON operations (user_id);
CREATE INDEX IF NOT EXISTS idx_document_versions_user ON document_versions (user_id);
CREATE INDEX IF NOT EXISTS idx_application_events_user ON application_events (user_id);
CREATE INDEX IF NOT EXISTS idx_experiment_events_user ON experiment_events (user_id);
CREATE INDEX IF NOT EXISTS idx_exchange_codes_user ON exchange_codes (user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_integration_codes_user ON integration_codes (user_id);
CREATE INDEX IF NOT EXISTS idx_upload_images_user ON upload_images (user_id) WHERE user_id IS NOT NULL;
