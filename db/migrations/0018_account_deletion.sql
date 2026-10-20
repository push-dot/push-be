-- Account deletion: DELETE /me marks the account, logging in again within
-- 30 days restores it, and the cron purges it after that.

ALTER TABLE users ADD COLUMN deletion_requested_at timestamptz;
CREATE INDEX users_deletion_requested_idx ON users (deletion_requested_at)
    WHERE deletion_requested_at IS NOT NULL;

-- Purging deletes the user row, so every foreign key that leads back to users
-- (directly or through rows the user owns) becomes ON DELETE CASCADE.
-- SET NULL keys are left as they are.
DO $$
DECLARE r record;
BEGIN
    FOR r IN
        WITH RECURSIVE owned(rel) AS (
            SELECT 'users'::regclass
            UNION
            SELECT c.conrelid::regclass FROM pg_constraint c JOIN owned o ON c.confrelid = o.rel
            WHERE c.contype = 'f'
        )
        SELECT c.conname, c.conrelid::regclass AS tbl, pg_get_constraintdef(c.oid) AS def
        FROM pg_constraint c
        WHERE c.contype = 'f' AND c.confrelid IN (SELECT rel FROM owned) AND c.confdeltype IN ('a', 'r')
    LOOP
        EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.tbl, r.conname);
        EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I %s ON DELETE CASCADE', r.tbl, r.conname, r.def);
    END LOOP;
END $$;
