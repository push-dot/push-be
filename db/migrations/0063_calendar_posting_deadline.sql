-- A posting's deadline enters the user's calendar by itself when the user bookmarks or applies (owner decision 2026-11-16).
-- The event keeps the posting it came from, so a repeat bookmark or apply finds it (one DEADLINE event per user and
-- posting) and an un-bookmark removes it. Events made by hand or by Google sync leave posting_id NULL.
-- Additive and idempotent. The nullable column is a catalog-only change; the unique index is built over an empty
-- column, so it holds the table lock only for the build of an index with no rows. Existing bookmarks get no event.
-- Revert: DROP INDEX IF EXISTS idx_calendar_posting; ALTER TABLE calendar_events DROP COLUMN IF EXISTS posting_id;

ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS posting_id uuid REFERENCES job_postings(id) ON DELETE CASCADE;
CREATE UNIQUE INDEX IF NOT EXISTS idx_calendar_posting ON calendar_events (user_id, posting_id) WHERE posting_id IS NOT NULL;
