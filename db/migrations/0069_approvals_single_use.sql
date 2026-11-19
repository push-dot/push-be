ALTER TABLE approvals ADD COLUMN IF NOT EXISTS consumed_at timestamptz;
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS consumed_key uuid;
