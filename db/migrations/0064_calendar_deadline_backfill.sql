-- Gives the bookmarks and applications made before 0063 the deadline event that bookmarking or applying now adds
-- (same key: one DEADLINE event per user and posting, same title, time and source as deadlineEventSelect in core-api).
-- An applied posting gets its event even when the deadline has passed and the event points at the application, as apply
-- does; a bookmark gets one only while the deadline is today or later. A posting without a deadline adds nothing.
-- Idempotent: ON CONFLICT on (user_id, posting_id) leaves an existing event alone, so a rerun inserts nothing, and the
-- application link is only filled in where it is still empty. Data only, no schema change.
-- Revert: DELETE FROM calendar_events WHERE source = 'POSTING' AND posting_id IS NOT NULL (also removes events made since).

INSERT INTO calendar_events (id, user_id, revision, application_id, type, title, starts_at, ends_at, time_zone, source, external_id, notes, posting_id, created_at, updated_at)
SELECT DISTINCT ON (a.user_id, p.id)
    gen_random_uuid(), a.user_id, 1, a.id, 'DEADLINE', left(p.company || ' ' || p.title, 300),
    ((p.deadline + time '23:59') AT TIME ZONE 'Asia/Seoul'), ((p.deadline + time '23:59') AT TIME ZONE 'Asia/Seoul') + interval '1 minute',
    'Asia/Seoul', 'POSTING', NULL, '', p.id, now(), now()
FROM applications a
JOIN jobs j ON j.id = a.job_id
JOIN job_postings p ON p.id = j.source_posting_id
WHERE p.deadline IS NOT NULL
ORDER BY a.user_id, p.id, a.created_at, a.id
ON CONFLICT (user_id, posting_id) WHERE posting_id IS NOT NULL
DO UPDATE SET application_id = EXCLUDED.application_id, revision = calendar_events.revision + 1, updated_at = EXCLUDED.updated_at
WHERE calendar_events.application_id IS NULL;

INSERT INTO calendar_events (id, user_id, revision, application_id, type, title, starts_at, ends_at, time_zone, source, external_id, notes, posting_id, created_at, updated_at)
SELECT
    gen_random_uuid(), k.user_id, 1, NULL, 'DEADLINE', left(p.company || ' ' || p.title, 300),
    ((p.deadline + time '23:59') AT TIME ZONE 'Asia/Seoul'), ((p.deadline + time '23:59') AT TIME ZONE 'Asia/Seoul') + interval '1 minute',
    'Asia/Seoul', 'POSTING', NULL, '', p.id, now(), now()
FROM bookmarks k
JOIN job_postings p ON p.id = k.posting_id
WHERE p.deadline >= (now() AT TIME ZONE 'Asia/Seoul')::date
ON CONFLICT (user_id, posting_id) WHERE posting_id IS NOT NULL DO NOTHING;
