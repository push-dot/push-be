-- The company-bot posting watch (services/core-api/src/routes/notification-jobs.ts DUE_WATCH) keeps its state in
-- notification_dedupes: 'watch:baseline' (when watching began), 'watch:closed:<user>:<posting>' (a close was
-- sent) and 'watch:new:<user>:<company>' (the newest posting announced). A cleanup that removed a per-user key
-- would make the next run announce that user's postings of the last 30 days again, or re-send a close of the last
-- 2 days. A removed key now comes back at once with the time of removal, so only that user and company or
-- posting starts again from now; nobody else's watch and the shared baseline are left as they were. A close key
-- older than 3 days stays removed: the watch looks back only 2 days for closes, so it can never be sent again.
-- Revert: DROP TRIGGER notification_dedupes_watch_reset ON notification_dedupes;
--         DROP FUNCTION notification_dedupes_watch_reset();

CREATE FUNCTION notification_dedupes_watch_reset() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO notification_dedupes (dedupe_key, created_at)
    SELECT dedupe_key, now() FROM gone
    WHERE dedupe_key LIKE 'watch:new:%'
       OR (dedupe_key LIKE 'watch:closed:%' AND created_at > now() - interval '3 days')
    ON CONFLICT (dedupe_key) DO NOTHING;
    RETURN NULL;
END
$$;

CREATE TRIGGER notification_dedupes_watch_reset
    AFTER DELETE ON notification_dedupes
    REFERENCING OLD TABLE AS gone
    FOR EACH STATEMENT EXECUTE FUNCTION notification_dedupes_watch_reset();
