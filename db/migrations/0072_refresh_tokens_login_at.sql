-- Time of the original sign-in, copied through refresh rotation; DELETE /me needs it within 10 minutes. Null (older sessions) means sign in again.
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS login_at timestamptz;
