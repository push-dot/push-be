ALTER TABLE approvals ADD COLUMN IF NOT EXISTS tool_name text;
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS tool_args jsonb;
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS tool_call_id text;
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS job_id uuid;
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS expires_at timestamptz;

ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_kind_chk;
ALTER TABLE approvals ADD CONSTRAINT approvals_kind_chk CHECK (kind IN (
    'EVIDENCE_USE',
    'DOCUMENT_FINALIZE',
    'APPLICATION_SUBMIT',
    'CLI_EXECUTE',
    'DOCUMENT_EDIT',
    'TOOL_ACTION',
    'RESUME_GATE'
));

ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_status_chk;
ALTER TABLE approvals ADD CONSTRAINT approvals_status_chk CHECK (status IN (
    'PENDING',
    'APPROVED',
    'DENIED',
    'EXPIRED',
    'CONSUMED',
    'REJECTED'
));

CREATE UNIQUE INDEX IF NOT EXISTS approvals_job_tool_call_uidx
    ON approvals (job_id, tool_call_id)
    WHERE tool_call_id IS NOT NULL;

ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS ai_access_mode text NOT NULL DEFAULT 'AUTO';
ALTER TABLE user_settings DROP CONSTRAINT IF EXISTS user_settings_ai_access_mode_chk;
ALTER TABLE user_settings ADD CONSTRAINT user_settings_ai_access_mode_chk
    CHECK (ai_access_mode IN ('ALWAYS_ASK','AUTO','BYPASS'));

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS harness text;
ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_harness_chk;
ALTER TABLE conversations ADD CONSTRAINT conversations_harness_chk
    CHECK (harness IN ('personal','employer'));
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS resume_state jsonb;
