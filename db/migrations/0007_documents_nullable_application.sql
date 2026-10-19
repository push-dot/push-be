ALTER TABLE documents ALTER COLUMN application_id DROP NOT NULL;
ALTER TABLE document_versions ALTER COLUMN application_id DROP NOT NULL;
