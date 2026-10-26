-- Schema invariants checked after all migrations are applied (CI job test-db).
-- Run: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/tests/schema_checks.sql
-- Everything runs in one transaction that is rolled back.
BEGIN;

-- Account purge deletes users rows. Every FK that leads back to users (directly or
-- through rows a user owns) must CASCADE or SET NULL, or the purge fails.
DO $$
DECLARE bad text;
BEGIN
    WITH RECURSIVE owned(rel) AS (
        SELECT 'users'::regclass
        UNION
        SELECT c.conrelid::regclass FROM pg_constraint c JOIN owned o ON c.confrelid = o.rel
        WHERE c.contype = 'f'
    )
    SELECT string_agg(format('%s.%s', c.conrelid::regclass, c.conname), ', ') INTO bad
    FROM pg_constraint c
    WHERE c.contype = 'f' AND c.confrelid IN (SELECT rel FROM owned) AND c.confdeltype IN ('a', 'r');
    IF bad IS NOT NULL THEN
        RAISE EXCEPTION 'FKs block the account purge (need CASCADE or SET NULL): %', bad;
    END IF;
END $$;

-- Deleting a row one user owns must not delete rows another user (or company) owns.
INSERT INTO users (id, provider, provider_subject, display_name)
VALUES ('00000000-0000-4000-8000-0000000000a1', 'test', 'a1', 'candidate'),
       ('00000000-0000-4000-8000-0000000000a2', 'test', 'a2', 'employer');
INSERT INTO companies (id, name) VALUES ('00000000-0000-4000-8000-0000000000c1', 'co');
INSERT INTO sources (id, user_id, file_name, mime_type, size, sha256, path)
VALUES ('00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000a1',
        'cv.pdf', 'application/pdf', 1, 'x', 'p');
INSERT INTO profiles (user_id, resume_source_id)
VALUES ('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000b1');
INSERT INTO job_postings (id, company_id, company, title, job_category, career_min, location,
                          employment_type, description)
VALUES ('00000000-0000-4000-8000-0000000000d1', '00000000-0000-4000-8000-0000000000c1',
        'co', 'dev', 'dev', 0, 'Seoul', 'full_time', 'd');
INSERT INTO jobs (id, user_id, company, title, source_kind, source_text, source_posting_id)
VALUES ('00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-0000000000a1',
        'co', 'dev', 'posting', 't', '00000000-0000-4000-8000-0000000000d1');
INSERT INTO offers (id, sender_id, profile_user_id, message, posting_id)
VALUES ('00000000-0000-4000-8000-0000000000f1', '00000000-0000-4000-8000-0000000000a2',
        '00000000-0000-4000-8000-0000000000a1', 'hi', '00000000-0000-4000-8000-0000000000d1');
INSERT INTO billing_ledger (id, company_id, type, amount_micro_credits, balance_after)
VALUES ('00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-0000000000c1',
        'TOPUP', 1, 1);

DELETE FROM sources WHERE id = '00000000-0000-4000-8000-0000000000b1';
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM profiles
                   WHERE user_id = '00000000-0000-4000-8000-0000000000a1' AND resume_source_id IS NULL) THEN
        RAISE EXCEPTION 'deleting a resume source removed the profile';
    END IF;
END $$;

-- Deleting the company removes its postings; the candidate's job and offer stay.
DELETE FROM companies WHERE id = '00000000-0000-4000-8000-0000000000c1';
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM jobs
                   WHERE id = '00000000-0000-4000-8000-0000000000e1' AND source_posting_id IS NULL) THEN
        RAISE EXCEPTION 'deleting a posting removed a candidate job';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM offers
                   WHERE id = '00000000-0000-4000-8000-0000000000f1' AND posting_id IS NULL) THEN
        RAISE EXCEPTION 'deleting a posting removed an offer';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM billing_ledger
                   WHERE id = '00000000-0000-4000-8000-000000000011' AND company_id IS NULL) THEN
        RAISE EXCEPTION 'deleting a company removed its payment records';
    END IF;
END $$;

-- The purge itself: deleting both users succeeds and keeps the ledger row.
DELETE FROM users WHERE id IN ('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000a2');

ROLLBACK;
\echo 'schema checks passed'
