-- Where an employer reaches a personal applicant. users.phone is already set only after an SMS code;
-- contact_email may differ from the login email, so it is verified on its own with a 6-digit mail code.
ALTER TABLE users ADD COLUMN contact_email text;
ALTER TABLE users ADD COLUMN contact_email_verified_at timestamptz;

CREATE TABLE contact_email_codes (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    email text NOT NULL,
    code_hash text NOT NULL,
    expires_at timestamptz NOT NULL,
    attempts integer NOT NULL DEFAULT 0,
    sent_at timestamptz NOT NULL,
    consumed_at timestamptz
);

CREATE INDEX contact_email_codes_user_sent_idx ON contact_email_codes (user_id, sent_at DESC);
