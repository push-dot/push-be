ALTER TABLE job_postings ADD COLUMN status text;

UPDATE job_postings
SET status = CASE WHEN closed_at IS NOT NULL THEN 'CLOSED' ELSE 'OPEN' END;

ALTER TABLE job_postings ALTER COLUMN status SET NOT NULL;
ALTER TABLE job_postings ALTER COLUMN status SET DEFAULT 'OPEN';
ALTER TABLE job_postings ADD CONSTRAINT job_postings_status_chk CHECK (status IN ('DRAFT', 'OPEN', 'CLOSED'));

ALTER TABLE companies ADD COLUMN logo_key text;
ALTER TABLE companies ADD COLUMN industry text;
ALTER TABLE companies ADD COLUMN website text;
ALTER TABLE companies ADD COLUMN intro text;
ALTER TABLE companies ADD COLUMN representative_name text;

ALTER TABLE company_invites ADD COLUMN inviter_user_id uuid REFERENCES users(id);
