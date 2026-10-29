ALTER TABLE users ADD COLUMN phone text;

CREATE UNIQUE INDEX users_personal_phone_idx
    ON users (phone)
    WHERE phone IS NOT NULL AND is_employer = false;

CREATE TABLE phone_codes (
    id uuid PRIMARY KEY,
    phone text NOT NULL,
    code_hash text NOT NULL,
    expires_at timestamptz NOT NULL,
    attempts integer NOT NULL DEFAULT 0,
    sent_at timestamptz NOT NULL,
    consumed_at timestamptz
);

CREATE INDEX phone_codes_phone_sent_idx ON phone_codes (phone, sent_at DESC);

CREATE TABLE user_identities (
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider text NOT NULL,
    provider_subject text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (provider, provider_subject)
);

CREATE INDEX user_identities_user_idx ON user_identities (user_id);
