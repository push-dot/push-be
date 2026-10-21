ALTER TABLE users ADD COLUMN password_hash text;
ALTER TABLE users ADD COLUMN email_verified_at timestamptz;
CREATE UNIQUE INDEX users_email_lower_idx ON users (lower(email)) WHERE email IS NOT NULL;

ALTER TABLE oauth_states ADD COLUMN account_type text NOT NULL DEFAULT 'PERSONAL';
ALTER TABLE oauth_states ADD CONSTRAINT oauth_states_account_type_chk CHECK (account_type IN ('PERSONAL', 'EMPLOYER'));

CREATE TABLE companies (
    id uuid PRIMARY KEY,
    b_no text,
    name text NOT NULL,
    verified_at timestamptz,
    plan text,
    stripe_customer_id text,
    deletion_requested_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT companies_plan_chk CHECK (plan IS NULL OR plan IN ('BASIC', 'PRO', 'ULTRA'))
);
CREATE UNIQUE INDEX companies_b_no_idx ON companies (b_no) WHERE b_no IS NOT NULL;

CREATE TABLE company_members (
    company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    user_id uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    role text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (company_id, user_id),
    CONSTRAINT company_members_role_chk CHECK (role IN ('ADMIN', 'MEMBER'))
);

INSERT INTO companies (id, name, created_at)
SELECT DISTINCT p.company_user_id, COALESCE(NULLIF(u.display_name, ''), '회사'), now()
FROM job_postings p JOIN users u ON u.id = p.company_user_id;

INSERT INTO company_members (company_id, user_id, role, created_at)
SELECT c.id, c.id, 'ADMIN', now() FROM companies c
WHERE EXISTS (SELECT 1 FROM users u WHERE u.id = c.id);

ALTER TABLE job_postings ADD COLUMN company_id uuid;
ALTER TABLE job_postings ADD COLUMN revision bigint NOT NULL DEFAULT 1;
ALTER TABLE job_postings ADD COLUMN preferred jsonb NOT NULL DEFAULT '[]';
UPDATE job_postings SET company_id = company_user_id;
ALTER TABLE job_postings ALTER COLUMN company_id SET NOT NULL;
ALTER TABLE job_postings ADD CONSTRAINT job_postings_company_fk FOREIGN KEY (company_id) REFERENCES companies(id);
ALTER TABLE job_postings DROP COLUMN company_user_id;
CREATE INDEX idx_postings_company ON job_postings (company_id, created_at DESC, id DESC);

CREATE TABLE company_invites (
    id uuid PRIMARY KEY,
    company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    email text NOT NULL,
    token_hash text NOT NULL UNIQUE,
    expires_at timestamptz NOT NULL,
    accepted_at timestamptz
);

CREATE TABLE email_signups (
    id uuid PRIMARY KEY,
    email text NOT NULL UNIQUE,
    password_hash text NOT NULL,
    is_employer boolean NOT NULL,
    display_name text NOT NULL,
    consent_reference boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE email_tokens (
    id uuid PRIMARY KEY,
    user_id uuid REFERENCES users(id) ON DELETE CASCADE,
    signup_id uuid REFERENCES email_signups(id) ON DELETE CASCADE,
    kind text NOT NULL,
    token_hash text NOT NULL UNIQUE,
    expires_at timestamptz NOT NULL,
    used_at timestamptz,
    CONSTRAINT email_tokens_kind_chk CHECK (kind IN ('VERIFY', 'RESET')),
    CONSTRAINT email_tokens_owner_chk CHECK ((user_id IS NULL) <> (signup_id IS NULL))
);

CREATE TABLE application_snapshots (
    id uuid PRIMARY KEY,
    application_id uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    document_id uuid,
    title text NOT NULL,
    content text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_application_snapshots ON application_snapshots (application_id, created_at DESC, id DESC);

CREATE TABLE reference_samples (
    id uuid PRIMARY KEY,
    source_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    job_category text NOT NULL,
    tenure_years int NOT NULL,
    fit_score int NOT NULL,
    score_band int NOT NULL,
    part_scores jsonb NOT NULL DEFAULT '{}',
    plan text NOT NULL,
    features jsonb NOT NULL DEFAULT '{}',
    sentence_templates jsonb NOT NULL DEFAULT '[]',
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT reference_samples_plan_chk CHECK (plan IN ('FREE', 'PRO', 'ULTRA'))
);
CREATE INDEX idx_reference_samples_bucket ON reference_samples (job_category, tenure_years, score_band);

CREATE TABLE user_consents (
    user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    reference_data boolean NOT NULL DEFAULT false,
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE iap_subscriptions (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    platform text NOT NULL,
    original_transaction_id text NOT NULL UNIQUE,
    product_id text NOT NULL,
    expires_at timestamptz,
    status text NOT NULL,
    CONSTRAINT iap_subscriptions_platform_chk CHECK (platform IN ('APP_STORE', 'GOOGLE_PLAY'))
);

ALTER TABLE billing_ledger ADD COLUMN company_id uuid REFERENCES companies(id);
-- Purged personal rows already have user_id NULL (migration 0018). Reject only rows that name both owners.
ALTER TABLE billing_ledger ADD CONSTRAINT billing_ledger_owner_chk CHECK (NOT (user_id IS NOT NULL AND company_id IS NOT NULL));
CREATE UNIQUE INDEX idx_billing_ledger_company_ref ON billing_ledger (company_id, type, reference_id) WHERE company_id IS NOT NULL;
CREATE INDEX idx_billing_ledger_company ON billing_ledger (company_id, created_at DESC, id DESC) WHERE company_id IS NOT NULL;

ALTER TABLE conversations ADD COLUMN company_id uuid REFERENCES companies(id);
ALTER TABLE conversations ADD COLUMN posting_id uuid REFERENCES job_postings(id);
CREATE INDEX idx_conversations_company ON conversations (company_id, created_at DESC, id DESC) WHERE company_id IS NOT NULL;

CREATE TABLE conversation_attachments (
    id uuid PRIMARY KEY,
    conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    file_name text NOT NULL,
    mime_type text NOT NULL,
    content bytea NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE user_settings ADD COLUMN notify_application_stage boolean NOT NULL DEFAULT true;

ALTER TABLE notifications DROP CONSTRAINT notifications_type_chk;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_chk CHECK (type IN ('DEADLINE', 'OFFER', 'COMMENT', 'AI_DONE', 'APPLICATION_STAGE'));
