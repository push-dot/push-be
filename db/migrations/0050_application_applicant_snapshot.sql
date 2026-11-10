-- The profile an applicant submitted, captured in the apply statement.
-- NULL means the row predates this column: readers use the live profile and say so.
-- Additive. Code that does not read the column sees the same rows.
-- Revert: ALTER TABLE applications DROP COLUMN applicant_snapshot;

ALTER TABLE applications ADD COLUMN IF NOT EXISTS applicant_snapshot jsonb;
