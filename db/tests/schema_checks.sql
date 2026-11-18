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

-- The company purge (services/ai account_purge.py) deletes companies rows the same way.
DO $$
DECLARE bad text;
BEGIN
    WITH RECURSIVE owned(rel) AS (
        SELECT 'companies'::regclass
        UNION
        SELECT c.conrelid::regclass FROM pg_constraint c JOIN owned o ON c.confrelid = o.rel
        WHERE c.contype = 'f'
    )
    SELECT string_agg(format('%s.%s', c.conrelid::regclass, c.conname), ', ') INTO bad
    FROM pg_constraint c
    WHERE c.contype = 'f' AND c.confrelid IN (SELECT rel FROM owned) AND c.confdeltype IN ('a', 'r');
    IF bad IS NOT NULL THEN
        RAISE EXCEPTION 'FKs block the company purge (need CASCADE or SET NULL): %', bad;
    END IF;
END $$;

-- Everything a chat thread holds is deleted with it, and what a bot holds (its thread, read marker,
-- site grants) is deleted with the bot (0053, 0058).
-- A table that gains a conversation_id or bot_id column fails here until that column is a cascading key.
DO $$
DECLARE bad text;
BEGIN
    SELECT string_agg(format('%s.%s', a.attrelid::regclass, a.attname), ', ') INTO bad
    FROM pg_attribute a
    JOIN pg_class t ON t.oid = a.attrelid AND t.relkind IN ('r', 'p') AND t.relnamespace = 'public'::regnamespace
    CROSS JOIN LATERAL (
        SELECT CASE
            WHEN a.attname = 'conversation_id' THEN 'conversations'::regclass
            WHEN a.attname = 'bot_id' THEN 'bots'::regclass
        END AS parent
    ) owner
    WHERE NOT a.attisdropped AND owner.parent IS NOT NULL
      AND NOT EXISTS (
          SELECT 1 FROM pg_constraint c
          WHERE c.contype = 'f' AND c.conrelid = a.attrelid AND c.conkey = ARRAY[a.attnum]
            AND c.confrelid = owner.parent AND c.confdeltype = 'c');
    IF bad IS NOT NULL THEN
        RAISE EXCEPTION 'columns that must be ON DELETE CASCADE keys to their thread or bot: %', bad;
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

-- One bot per company, one thread per bot, and a bot thread is a personal conversation (0053).
INSERT INTO bots (id, user_id, kind, company_name, display_name)
VALUES ('00000000-0000-4000-8000-0000000000b2', '00000000-0000-4000-8000-0000000000a1', 'company', 'Acme', 'Acme'),
       ('00000000-0000-4000-8000-0000000000b3', '00000000-0000-4000-8000-0000000000a1', 'push', '', 'Push Bot');
INSERT INTO conversations (id, user_id, title, bot_id)
VALUES ('00000000-0000-4000-8000-0000000000a8', '00000000-0000-4000-8000-0000000000a1', 'Acme',
        '00000000-0000-4000-8000-0000000000b2'),
       ('00000000-0000-4000-8000-0000000000a9', '00000000-0000-4000-8000-0000000000a1', 'Push Bot',
        '00000000-0000-4000-8000-0000000000b3');
DO $$
BEGIN
    BEGIN
        INSERT INTO bots (id, user_id, kind, company_name, display_name)
        VALUES ('00000000-0000-4000-8000-0000000000b4', '00000000-0000-4000-8000-0000000000a1', 'company', ' ACME ', 'again');
    EXCEPTION WHEN unique_violation THEN RETURN;
    END;
    RAISE EXCEPTION 'a second bot for one company was accepted';
END $$;
DO $$
BEGIN
    BEGIN
        INSERT INTO conversations (id, user_id, title, bot_id)
        VALUES ('00000000-0000-4000-8000-0000000000a7', '00000000-0000-4000-8000-0000000000a1', 'again',
                '00000000-0000-4000-8000-0000000000b2');
    EXCEPTION WHEN unique_violation THEN RETURN;
    END;
    RAISE EXCEPTION 'a second thread for one bot was accepted';
END $$;
DO $$
BEGIN
    BEGIN
        UPDATE conversations SET company_id = '00000000-0000-4000-8000-0000000000c1'
        WHERE id = '00000000-0000-4000-8000-0000000000a8';
    EXCEPTION WHEN check_violation THEN RETURN;
    END;
    RAISE EXCEPTION 'a bot thread was accepted as an employer conversation';
END $$;

-- Deleting a bot deletes its thread and what the thread holds.
INSERT INTO messages (id, user_id, conversation_id, role, text)
SELECT gen_random_uuid(), user_id, id, 'USER', 'hi' FROM conversations WHERE bot_id IS NOT NULL;
INSERT INTO workspace_files (conversation_id, name, body)
SELECT id, 'resume.md', 'x' FROM conversations WHERE bot_id IS NOT NULL;
INSERT INTO notifications (id, user_id, type, title, conversation_id)
SELECT gen_random_uuid(), user_id, 'AI_DONE', 'done', id FROM conversations WHERE bot_id IS NOT NULL;
DELETE FROM bots WHERE id = '00000000-0000-4000-8000-0000000000b2';
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM conversations WHERE id = '00000000-0000-4000-8000-0000000000a8')
       OR (SELECT count(*) FROM messages WHERE user_id = '00000000-0000-4000-8000-0000000000a1') <> 1
       OR (SELECT count(*) FROM notifications WHERE user_id = '00000000-0000-4000-8000-0000000000a1') <> 1
       OR EXISTS (SELECT 1 FROM workspace_files WHERE conversation_id = '00000000-0000-4000-8000-0000000000a8') THEN
        RAISE EXCEPTION 'deleting a bot left its thread, a message, a workspace file or a notification';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM workspace_files WHERE conversation_id = '00000000-0000-4000-8000-0000000000a9') THEN
        RAISE EXCEPTION 'deleting a bot removed the workspace file of another bot';
    END IF;
END $$;

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
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM bots WHERE id = '00000000-0000-4000-8000-0000000000b3')
       OR EXISTS (SELECT 1 FROM conversations WHERE id = '00000000-0000-4000-8000-0000000000a9')
       OR EXISTS (SELECT 1 FROM workspace_files WHERE conversation_id = '00000000-0000-4000-8000-0000000000a9') THEN
        RAISE EXCEPTION 'the account purge left a bot, its thread or a workspace file';
    END IF;
END $$;

ROLLBACK;
\echo 'schema checks passed'
