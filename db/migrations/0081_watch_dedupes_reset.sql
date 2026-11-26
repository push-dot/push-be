-- The company-bot posting watch (services/core-api/src/routes/notification-jobs.ts DUE_WATCH) keeps its state in
-- notification_dedupes: 'watch:baseline' (when watching began), 'watch:closed:<user>:<posting>' (a close was
-- sent) and 'watch:new:<user>:<company>' (the newest posting announced). A cleanup that removed the per-posting
-- or per-company keys but kept the old baseline would make the next run announce every posting of the last 30
-- days again. Removing any of those keys now removes the baseline in the same statement, so watching restarts
-- from the next run and announces nothing older.
-- Revert: DROP TRIGGER notification_dedupes_watch_reset ON notification_dedupes;
--         DROP FUNCTION notification_dedupes_watch_reset();

CREATE FUNCTION notification_dedupes_watch_reset() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM gone WHERE dedupe_key LIKE 'watch:%' AND dedupe_key <> 'watch:baseline') THEN
        DELETE FROM notification_dedupes WHERE dedupe_key = 'watch:baseline';
    END IF;
    RETURN NULL;
END
$$;

CREATE TRIGGER notification_dedupes_watch_reset
    AFTER DELETE ON notification_dedupes
    REFERENCING OLD TABLE AS gone
    FOR EACH STATEMENT EXECUTE FUNCTION notification_dedupes_watch_reset();
