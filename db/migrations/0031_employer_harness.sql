-- Employer harness (super-recruit): company research cache, review reports and interview kits.
-- Reports and kits belong to a company conversation and go away with it.

ALTER TABLE companies ADD COLUMN IF NOT EXISTS profile jsonb;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS profile_refreshed_at timestamptz;

CREATE TABLE employer_reviews (
    id uuid PRIMARY KEY,
    company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    application_id uuid REFERENCES applications(id) ON DELETE CASCADE,
    attachment_name text,
    report jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT employer_reviews_target_chk CHECK (application_id IS NOT NULL OR attachment_name IS NOT NULL)
);
CREATE INDEX idx_employer_reviews_application ON employer_reviews (company_id, application_id, created_at DESC);
CREATE INDEX idx_employer_reviews_conversation ON employer_reviews (conversation_id);

CREATE TABLE employer_interview_kits (
    id uuid PRIMARY KEY,
    company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    review_id uuid REFERENCES employer_reviews(id) ON DELETE SET NULL,
    application_id uuid REFERENCES applications(id) ON DELETE CASCADE,
    kit jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_employer_interview_kits_application ON employer_interview_kits (company_id, application_id, created_at DESC);
CREATE INDEX idx_employer_interview_kits_conversation ON employer_interview_kits (conversation_id);

ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_kind_chk;
ALTER TABLE approvals ADD CONSTRAINT approvals_kind_chk CHECK (kind IN (
    'EVIDENCE_USE',
    'DOCUMENT_FINALIZE',
    'APPLICATION_SUBMIT',
    'CLI_EXECUTE',
    'DOCUMENT_EDIT',
    'TOOL_ACTION',
    'RESUME_GATE',
    'EMPLOYER_GATE'
));
