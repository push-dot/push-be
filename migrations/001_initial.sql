CREATE TABLE IF NOT EXISTS resources (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL, kind text NOT NULL,
 application_id uuid, body jsonb NOT NULL CHECK (jsonb_typeof(body) = 'object'),
 revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS resources_owner_kind ON resources(owner_id,kind,created_at);
CREATE INDEX IF NOT EXISTS resources_application ON resources(owner_id,application_id);
CREATE TABLE IF NOT EXISTS identities (provider text NOT NULL, subject text NOT NULL, user_id uuid NOT NULL, PRIMARY KEY(provider,subject));
CREATE TABLE IF NOT EXISTS sessions (access_hash text PRIMARY KEY, refresh_hash text UNIQUE NOT NULL, user_id uuid NOT NULL, access_expires timestamptz NOT NULL, refresh_expires timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS oauth_states (state_hash text PRIMARY KEY, provider text NOT NULL, challenge text NOT NULL, redirect_uri text NOT NULL, expires_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS auth_codes (code_hash text PRIMARY KEY, user_id uuid NOT NULL, challenge text NOT NULL, expires_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS ai_keys (owner_id uuid NOT NULL, provider text NOT NULL, ciphertext bytea NOT NULL, last_four text NOT NULL, PRIMARY KEY(owner_id,provider));
CREATE TABLE IF NOT EXISTS billing (owner_id uuid PRIMARY KEY, customer_id text UNIQUE, active boolean NOT NULL DEFAULT false, credits bigint NOT NULL DEFAULT 0 CHECK (credits >= 0));
CREATE TABLE IF NOT EXISTS billing_events (id text PRIMARY KEY, received_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS google_connections (owner_id uuid PRIMARY KEY, ciphertext bytea NOT NULL, gmail_history text NOT NULL DEFAULT '', calendar_sync text NOT NULL DEFAULT '');
