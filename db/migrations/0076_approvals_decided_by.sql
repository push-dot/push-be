-- A company conversation's card may be answered by any member of that company, not only the member
-- whose turn opened it. decided_by keeps who answered; null for rows answered before this column.
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS decided_by uuid REFERENCES users(id) ON DELETE SET NULL;
