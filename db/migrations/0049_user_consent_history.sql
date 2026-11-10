-- A new terms version overwrites user_consents. The previous agreement is kept here
-- so the proof of the earlier consent is not lost. Rows follow the user.
-- Revert: DROP TABLE user_consent_history;

CREATE TABLE IF NOT EXISTS user_consent_history (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  terms_version text,
  age14_at timestamptz,
  service_terms_at timestamptz,
  privacy_at timestamptz,
  replaced_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_user_consent_history_user ON user_consent_history (user_id, replaced_at DESC);
