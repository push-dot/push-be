ALTER TABLE companies ADD COLUMN legal_name text;
ALTER TABLE companies ADD CONSTRAINT companies_legal_name_chk CHECK (legal_name IS NULL OR char_length(legal_name) <= 120);

ALTER TABLE offers ADD COLUMN responded_at timestamptz;

ALTER TABLE job_postings ADD COLUMN draft_source text;
ALTER TABLE job_postings ADD CONSTRAINT job_postings_draft_source_chk CHECK (draft_source IS NULL OR draft_source IN ('AGENT', 'MANUAL'));
