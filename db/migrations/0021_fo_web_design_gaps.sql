CREATE TABLE application_files (
  id uuid PRIMARY KEY,
  application_id uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  source_id uuid,
  document_id uuid,
  file_name text NOT NULL,
  mime_type text NOT NULL,
  size bigint NOT NULL,
  page_count int,
  storage_key text NOT NULL,
  content bytea,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_application_files ON application_files (application_id, created_at, id);

ALTER TABLE job_postings ADD COLUMN view_count int NOT NULL DEFAULT 0;
ALTER TABLE job_postings ADD COLUMN created_by uuid REFERENCES users(id) ON DELETE SET NULL;
CREATE TABLE posting_views (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  posting_id uuid NOT NULL REFERENCES job_postings(id) ON DELETE CASCADE,
  viewed_on date NOT NULL,
  PRIMARY KEY (user_id, posting_id, viewed_on)
);

ALTER TABLE post_comments ADD COLUMN parent_id uuid REFERENCES post_comments(id) ON DELETE SET NULL;
CREATE INDEX idx_post_comments_parent ON post_comments (parent_id);

ALTER TABLE calendar_events ADD COLUMN remind_at timestamptz;

ALTER TABLE user_settings ADD COLUMN default_effort text NOT NULL DEFAULT 'MEDIUM';
ALTER TABLE user_settings ADD CONSTRAINT user_settings_effort_chk CHECK (default_effort IN ('LOW', 'MEDIUM', 'HIGH', 'MAX'));
ALTER TABLE user_settings ADD COLUMN confirm_before_edit boolean NOT NULL DEFAULT true;

ALTER TABLE applications ADD COLUMN company_seen_at timestamptz;
ALTER TABLE profiles ADD COLUMN contact text NOT NULL DEFAULT '';

CREATE TABLE notification_dedupes (
  dedupe_key text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE search_queries (
  id uuid PRIMARY KEY,
  term text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_search_queries_recent ON search_queries (created_at DESC);
