-- What 항상 허용 on a page-read card remembers: this bot may read this host without asking.
-- The AI service writes and reads a grant (services/ai/src/app/harness/approval.py). Core lists and
-- revokes them for the bot profile (services/core-api/src/routes/bot-approvals.ts). Deleting the bot
-- deletes its grants. Clearing its chat keeps them.
-- Additive: code from before this file keeps working.
-- Revert: DROP FUNCTION approval_superseded(uuid, timestamptz); DROP TABLE bot_site_grants;
--         and put the NOT EXISTS of approval_superseded back into store_turns._CARDS first.

CREATE TABLE bot_site_grants (
    bot_id uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    host text NOT NULL CONSTRAINT bot_site_grants_host_chk CHECK (char_length(host) BETWEEN 1 AND 255),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (bot_id, host)
);

-- A card is passed by once a newer chat job of its thread exists: that job answered the card or
-- replaced the run it waits in. Then asking it again would resume nothing. The transcript's
-- retryable and the retry route read this one rule.
CREATE FUNCTION approval_superseded(thread uuid, asked_at timestamptz) RETURNS boolean
LANGUAGE sql STABLE AS $$
    SELECT EXISTS (
        SELECT 1 FROM ai_jobs
        WHERE conversation_id = thread AND type = 'chat' AND created_at > asked_at
    )
$$;
