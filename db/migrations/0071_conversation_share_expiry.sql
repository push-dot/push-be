ALTER TABLE conversation_shares
    ADD COLUMN IF NOT EXISTS shared_at timestamptz,
    ADD COLUMN IF NOT EXISTS expires_at timestamptz;

UPDATE conversation_shares
SET shared_at = COALESCE(shared_at, created_at), expires_at = COALESCE(expires_at, now() + interval '30 days')
WHERE shared_at IS NULL OR expires_at IS NULL;

ALTER TABLE conversation_shares
    ALTER COLUMN shared_at SET NOT NULL,
    ALTER COLUMN shared_at SET DEFAULT now(),
    ALTER COLUMN expires_at SET NOT NULL;
