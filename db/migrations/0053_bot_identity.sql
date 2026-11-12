-- One bot per company, one thread per bot, and what belongs to a bot is deleted with it.
-- A bot row could stand for a company twice, own many conversations, and turn a personal
-- chat into an employer chat (POST /bots/{id}/conversations copied bots.company_id onto
-- the conversation). Deleting a bot kept its conversations.
-- No statement deletes a message or a conversation. Duplicate company bots are
-- soft-deleted, and the conversations a bot may no longer keep become plain personal
-- conversations (bot_id NULL), as the old delete left them. The copies of chat messages
-- inside operations.result are replaced by the message ids.
-- Not additive: code from before this file can no longer start a second conversation
-- under a bot, and DELETE FROM bots now removes the thread and everything keyed to it.
-- run_migrations wraps each file in one transaction.
-- Revert: ALTER TABLE notifications DROP COLUMN conversation_id;
--         ALTER TABLE workspace_files DROP CONSTRAINT workspace_files_conversation_id_fkey;
--         ALTER TABLE conversations DROP CONSTRAINT conversations_bot_id_fkey,
--           ADD CONSTRAINT conversations_bot_id_fkey FOREIGN KEY (bot_id) REFERENCES bots(id) ON DELETE SET NULL;
--         ALTER TABLE conversations DROP CONSTRAINT conversations_bot_thread_personal_chk;
--         DROP INDEX conversations_bot_thread_uidx;
--         CREATE INDEX idx_conversations_bot_list ON conversations (bot_id, updated_at DESC, id DESC) WHERE bot_id IS NOT NULL;
--         DROP INDEX bots_company_uidx;
--         ALTER TABLE bots DROP COLUMN company_key, DROP COLUMN color;
--         DROP FUNCTION bot_company_key(text);
--         The detached conversations, the soft-deleted duplicates and the message copies in
--         operations.result are not restored.

-- A bot thread is a personal conversation, and a bot names its company by text only.
-- bots_company_posting_chk needs a name once company_id is gone.
UPDATE conversations SET company_id = NULL WHERE bot_id IS NOT NULL AND company_id IS NOT NULL;
UPDATE bots
SET company_id = NULL,
    company_name = CASE WHEN company_name = '' THEN display_name ELSE company_name END
WHERE company_id IS NOT NULL;
ALTER TABLE conversations ADD CONSTRAINT conversations_bot_thread_personal_chk
    CHECK (bot_id IS NULL OR company_id IS NULL);

ALTER TABLE bots ADD COLUMN color text NOT NULL DEFAULT 'teal'
    CONSTRAINT bots_color_chk CHECK (color IN ('teal', 'sky', 'blue', 'violet', 'pink', 'red', 'coral', 'amber', 'green', 'brown', 'gray'));
UPDATE bots SET color = mascot_key
WHERE mascot_key IN ('teal', 'sky', 'blue', 'violet', 'pink', 'red', 'coral', 'amber', 'green', 'brown', 'gray');

-- The only definition of "same company". The column and every reader call it.
CREATE FUNCTION bot_company_key(name text) RETURNS text
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    RETURN lower(btrim(name));
ALTER TABLE bots ADD COLUMN company_key text GENERATED ALWAYS AS (bot_company_key(company_name)) STORED;

-- Of two bots for one company, the one whose conversation has the newest message stays.
WITH ranked AS (
    SELECT b.id,
           row_number() OVER (
               PARTITION BY b.user_id, b.company_key
               ORDER BY (SELECT max(m.created_at) FROM conversations c JOIN messages m ON m.conversation_id = c.id
                         WHERE c.bot_id = b.id) DESC NULLS LAST,
                        b.created_at DESC, b.id DESC
           ) AS n
    FROM bots b
    WHERE b.kind = 'company' AND b.deleted_at IS NULL
)
UPDATE bots b SET deleted_at = now() FROM ranked r WHERE r.id = b.id AND r.n > 1;
CREATE UNIQUE INDEX bots_company_uidx ON bots (user_id, company_key) WHERE kind = 'company' AND deleted_at IS NULL;

-- A soft-deleted bot keeps no thread, and a live bot keeps the conversation with the newest message.
UPDATE conversations c SET bot_id = NULL FROM bots b WHERE b.id = c.bot_id AND b.deleted_at IS NOT NULL;
WITH ranked AS (
    SELECT c.id,
           row_number() OVER (
               PARTITION BY c.bot_id
               ORDER BY (SELECT max(m.created_at) FROM messages m WHERE m.conversation_id = c.id) DESC NULLS LAST,
                        c.created_at DESC, c.id DESC
           ) AS n
    FROM conversations c
    WHERE c.bot_id IS NOT NULL
)
UPDATE conversations c SET bot_id = NULL FROM ranked r WHERE r.id = c.id AND r.n > 1;
UPDATE conversations SET archived = false WHERE bot_id IS NOT NULL AND archived;
DROP INDEX idx_conversations_bot_list;
CREATE UNIQUE INDEX conversations_bot_thread_uidx ON conversations (bot_id) WHERE bot_id IS NOT NULL;

-- Ownership is foreign keys that cascade: bot -> thread -> everything in the thread.
-- An erase deletes one row and lists no table, so a table added later cannot be forgotten,
-- and a thread that a first send commits while its bot is being deleted goes too.
-- messages, approvals and ai_jobs (with chat_events, outbox, credit_reservations) already
-- cascade from the conversation.
ALTER TABLE conversations DROP CONSTRAINT conversations_bot_id_fkey,
    ADD CONSTRAINT conversations_bot_id_fkey FOREIGN KEY (bot_id) REFERENCES bots(id) ON DELETE CASCADE;

-- workspace_files had no foreign key. Rows of a conversation that is gone are unreachable:
-- every reader goes through a conversation the caller owns.
DELETE FROM workspace_files w WHERE NOT EXISTS (SELECT 1 FROM conversations c WHERE c.id = w.conversation_id);
ALTER TABLE workspace_files ADD CONSTRAINT workspace_files_conversation_id_fkey
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE;

-- A work-done notification points at its conversation through JSON, which no delete can follow.
ALTER TABLE notifications ADD COLUMN conversation_id uuid REFERENCES conversations(id) ON DELETE CASCADE;
CREATE INDEX notifications_conversation_idx ON notifications (conversation_id) WHERE conversation_id IS NOT NULL;
UPDATE notifications n SET conversation_id = c.id
FROM conversations c
WHERE n.type = 'AI_DONE' AND n.target->>'kind' = 'conversation' AND c.id::text = n.target->>'id';

-- operations gets no key to the thread: the month's usage rows cascade from it (ai_usage.operation_id),
-- so deleting it with a chat would hand credits back. It must hold no chat text instead. A finished
-- turn's operation used to embed both messages; from this release it holds their ids. This removes the
-- copies already stored, for every chat. Messages keep their text.
UPDATE operations
SET result = jsonb_build_object(
        'kind', result->'kind',
        'value', jsonb_strip_nulls(jsonb_build_object(
            'assistantMessageId', result->'value'->'assistantMessage'->'id',
            'userMessageId', result->'value'->'userMessage'->'id',
            'approvalIds', COALESCE(result->'value'->'approvalIds', '[]'::jsonb))))
WHERE type = 'CHAT_MESSAGE' AND result->'value' ? 'assistantMessage';
