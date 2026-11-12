-- What 항상 허용 on a page-read card remembers: this bot may read this host without asking.
-- The AI service writes and reads a grant (services/ai/src/app/harness/approval.py). Core lists and
-- revokes them for the bot profile (services/core-api/src/routes/bot-approvals.ts). Deleting the bot
-- deletes its grants. Clearing its chat keeps them.
-- Additive: code from before this file keeps working.
-- Revert: DROP FUNCTION approval_retryable(approvals); DROP FUNCTION approval_superseded(uuid, timestamptz);
--         DROP TABLE bot_site_grants; and put the retryable rule back into store_turns._CARDS first.

-- kind is what the granted page was, as the server knew it when 항상 허용 was answered: a posting page
-- (the bot's posting or one Push has), the bot's company site, or anything else. The bot profile
-- prints it under the host (BotProfileAllowed: 채용 공고, 회사 소개).
CREATE TABLE bot_site_grants (
    bot_id uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    host text NOT NULL CONSTRAINT bot_site_grants_host_chk CHECK (char_length(host) BETWEEN 1 AND 255),
    kind text NOT NULL CONSTRAINT bot_site_grants_kind_chk CHECK (kind IN ('posting', 'company', 'other')),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (bot_id, host)
);

-- A card is passed by once a newer chat job of its thread exists: that job answered the card or
-- replaced the run it waits in. Then asking it again would resume nothing.
CREATE FUNCTION approval_superseded(thread uuid, asked_at timestamptz) RETURNS boolean
LANGUAGE sql STABLE AS $$
    SELECT EXISTS (
        SELECT 1 FROM ai_jobs
        WHERE conversation_id = thread AND type = 'chat' AND created_at > asked_at
    )
$$;

-- Whether 다시 요청 can ask a card again: a tool card with a lifetime that nobody answered or closed
-- and that no newer chat job passed by. The transcript's retryable and the retry route read this one rule.
CREATE FUNCTION approval_retryable(a approvals) RETURNS boolean
LANGUAGE sql STABLE AS $$
    SELECT a.kind = 'TOOL_ACTION' AND a.expires_at IS NOT NULL AND a.status IN ('PENDING', 'EXPIRED')
        AND NOT approval_superseded(a.conversation_id, a.created_at)
$$;
