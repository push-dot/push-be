-- The materials read model of the app (core routes/materials.ts): who made a material, which bots
-- used it, when a bot last opened a link, and a 30-day bin for the kinds that had no deleted state.
-- Documents already archive and links already soft-delete. Files and bookmarks were deleted
-- outright, so the app's undo could not bring them back and the delete dialog's "kept 30 days"
-- was false for them. A deleted one now waits in material_bin as its own row, and the retention
-- purge erases it after the period of an archived document (services/ai account_purge.py).
-- Additive. Apply off-peak: run_migrations wraps each file in one transaction (no CONCURRENTLY),
-- so the GIN build blocks writes to messages while it runs.
-- Revert: DROP TABLE material_bin;
--         DROP INDEX messages_attachments_gin, user_links_deleted_idx;
--         ALTER TABLE user_links DROP COLUMN last_checked_at, DROP COLUMN last_check_ok;
--         ALTER TABLE documents DROP COLUMN created_by_bot_id;
--         ALTER TABLE sources DROP COLUMN created_by_bot_id;

-- The bot that made a file or a document. A deleted bot leaves the material, made by no one known.
ALTER TABLE sources ADD COLUMN created_by_bot_id uuid REFERENCES bots(id) ON DELETE SET NULL;
ALTER TABLE documents ADD COLUMN created_by_bot_id uuid REFERENCES bots(id) ON DELETE SET NULL;
CREATE INDEX sources_created_by_bot_idx ON sources (created_by_bot_id) WHERE created_by_bot_id IS NOT NULL;
CREATE INDEX documents_created_by_bot_idx ON documents (created_by_bot_id) WHERE created_by_bot_id IS NOT NULL;

-- Written when a bot opens the link. Null until one has.
ALTER TABLE user_links ADD COLUMN last_checked_at timestamptz, ADD COLUMN last_check_ok boolean;

-- Which bots used a material: messages whose attachments contain {kind, id}. The fact is the
-- message, so there is no usage table to keep in step.
CREATE INDEX messages_attachments_gin ON messages USING gin (attachments jsonb_path_ops);

-- For the purge of deleted links.
CREATE INDEX user_links_deleted_idx ON user_links (deleted_at) WHERE deleted_at IS NOT NULL;

-- A deleted file or bookmark, as the row it was, until it is restored or purged.
CREATE TABLE material_bin (
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind text NOT NULL CONSTRAINT material_bin_kind_chk CHECK (kind IN ('file', 'posting')),
    id uuid NOT NULL,
    deleted_at timestamptz NOT NULL,
    snapshot jsonb NOT NULL,
    PRIMARY KEY (user_id, kind, id)
);
CREATE INDEX material_bin_deleted_idx ON material_bin (deleted_at);
