-- GET /postings (total), /postings/facets and /search/trending read open postings only: status = 'OPEN' AND closed_at IS NULL.
-- This partial index holds just those rows, with every column the filters and facet groupings touch, so the counts
-- are Index Only Scans over open rows instead of a Seq Scan over the whole table.
--
-- Plain CREATE INDEX on purpose: run_migrations (services/ai/src/app/db.py) runs each file in one transaction and
-- CREATE INDEX CONCURRENTLY cannot run inside one. The build takes a SHARE lock on job_postings, so writes to
-- job_postings (create, edit, close, view_count) wait until it finishes; reads are not blocked.
-- Build time grows with open rows; it was well under a second at 20k rows.
-- Additive and idempotent. Revert: DROP INDEX IF EXISTS idx_postings_open_facets;

CREATE INDEX IF NOT EXISTS idx_postings_open_facets
    ON job_postings (job_category, location, employment_type, career_min, career_max)
    WHERE status = 'OPEN' AND closed_at IS NULL;
