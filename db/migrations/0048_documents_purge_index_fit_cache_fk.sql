-- The document purge scans status = 'ARCHIVED' by updated_at. Fit-cache rows had no
-- foreign key, so deleting a document or a posting left the score behind.
-- Orphans go first, then the keys. ON DELETE CASCADE covers every writer,
-- including the document purge. Additive: code that does not delete still
-- reads the same rows.
-- run_migrations wraps each file in one transaction, so the index is not
-- CONCURRENTLY: it blocks document writes while it builds.
-- Revert: DROP INDEX IF EXISTS idx_documents_archived;
--         ALTER TABLE posting_fit_cache DROP CONSTRAINT posting_fit_cache_document_fk;
--         ALTER TABLE posting_fit_cache DROP CONSTRAINT posting_fit_cache_posting_fk;

CREATE INDEX IF NOT EXISTS idx_documents_archived ON documents (updated_at) WHERE status = 'ARCHIVED';

DELETE FROM posting_fit_cache c
WHERE NOT EXISTS (SELECT 1 FROM documents d WHERE d.id = c.document_id)
   OR NOT EXISTS (SELECT 1 FROM job_postings p WHERE p.id = c.posting_id);

ALTER TABLE posting_fit_cache
    ADD CONSTRAINT posting_fit_cache_document_fk
    FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE NOT VALID;
ALTER TABLE posting_fit_cache VALIDATE CONSTRAINT posting_fit_cache_document_fk;

ALTER TABLE posting_fit_cache
    ADD CONSTRAINT posting_fit_cache_posting_fk
    FOREIGN KEY (posting_id) REFERENCES job_postings(id) ON DELETE CASCADE NOT VALID;
ALTER TABLE posting_fit_cache VALIDATE CONSTRAINT posting_fit_cache_posting_fk;
