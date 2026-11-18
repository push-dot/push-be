-- One definition of a bot and its state, for the bot list, one bot, and bot search.
-- Core computed a bot's last message, status and unread flag in a statement of its own, ordered the
-- list by the row's edit time, and had no fact about what a run is doing.
-- Additive: three indexes and one view. The last statement rewrites operations.result for chat turns
-- stored by code from before 0053; it changes no message.
-- Apply off-peak: run_migrations wraps each file in one transaction (no CONCURRENTLY), so the index
-- builds block writes to chat_events, approvals and ai_jobs while they run.
-- Revert: DROP VIEW bot_state_v;
--         DROP INDEX chat_events_status_idx, approvals_conversation_created_idx, ai_jobs_user_active_chat_idx;
--         The message copies removed from operations.result are not restored.

-- The newest status of a job without walking its token rows.
CREATE INDEX chat_events_status_idx ON chat_events (job_id, id DESC) WHERE type = 'status';

-- The newest card of a thread in any status. The only index that starts with conversation_id is
-- partial on PENDING (0028), and unread must also see answered and expired cards.
CREATE INDEX approvals_conversation_created_idx ON approvals (conversation_id, created_at DESC);

-- The caller's queued and running chat jobs, for the queue position.
CREATE INDEX ai_jobs_user_active_chat_idx ON ai_jobs (user_id, created_at)
    WHERE type = 'chat' AND status IN ('QUEUED', 'RETRY', 'RUNNING');

-- One row per live bot. A bot with no thread still has its row.
-- The view carries the bot's own columns and its owner, and every reader filters on the view's
-- user_id. A reader that joins bots again and filters the owner there makes the planner build the
-- state of every bot in the database before it keeps the caller's.
CREATE VIEW bot_state_v AS
SELECT
    b.id AS bot_id,
    b.user_id,
    b.kind, b.display_name, b.company_name, b.color, b.posting_id, b.notifications_muted, b.revision, b.created_at,
    -- Sent only until 0058 drops the columns.
    b.updated_at, b.posting_url, b.avatar_key, b.mascot_key,
    t.id AS thread_id,
    lm.created_at AS last_message_at,
    lm.preview AS last_message_preview,
    lm.from_bot AS last_message_from_bot,
    card.id AS card_id,
    card.title AS card_title,
    CASE
        WHEN card.id IS NULL THEN NULL
        WHEN card.kind IN ('RESUME_GATE', 'EMPLOYER_GATE') THEN 'answer'
        ELSE 'confirm'
    END AS card_for,
    -- Moves when the card is asked again.
    card.created_at AS card_at,
    card.expires_at AS card_expires_at,
    job.id AS job_id,
    job.created_at AS job_at,
    CASE
        WHEN job.id IS NULL THEN NULL
        WHEN job.status IN ('QUEUED', 'RETRY') THEN 'queued'
        WHEN st.phase = 'working' THEN 'working'
        -- A claimed job whose newest status names no working step, or no phase at all.
        ELSE 'thinking'
    END AS job_phase,
    st.text AS job_text,
    lbl.text AS job_recent_text,
    CASE WHEN job.status IN ('QUEUED', 'RETRY') THEN (
        SELECT count(*)::int FROM ai_jobs o
        WHERE o.user_id = b.user_id AND o.type = 'chat' AND o.status IN ('QUEUED', 'RETRY', 'RUNNING')
          AND o.created_at < job.created_at
    ) END AS job_ahead,
    GREATEST(b.created_at, lm.created_at, card.created_at) AS last_activity_at,
    (said.at IS NOT NULL AND (rm.read_at IS NULL OR said.at > rm.read_at)) AS unread
FROM bots b
LEFT JOIN conversations t ON t.bot_id = b.id
LEFT JOIN bot_read_markers rm ON rm.user_id = b.user_id AND rm.bot_id = b.id
LEFT JOIN LATERAL (
    SELECT m.created_at, left(m.text, 140) AS preview, (m.role = 'ASSISTANT') AS from_bot
    FROM messages m WHERE m.conversation_id = t.id
    ORDER BY m.created_at DESC, m.id DESC LIMIT 1
) lm ON true
-- The open card: PENDING and not past its time.
LEFT JOIN LATERAL (
    SELECT a.id, a.title, a.kind, a.created_at, a.expires_at
    FROM approvals a
    WHERE a.conversation_id = t.id AND a.status = 'PENDING' AND (a.expires_at IS NULL OR a.expires_at > now())
    ORDER BY a.created_at DESC LIMIT 1
) card ON true
LEFT JOIN LATERAL (
    SELECT j.id, j.status, j.created_at
    FROM ai_jobs j
    WHERE j.conversation_id = t.id AND j.type = 'chat' AND j.status IN ('QUEUED', 'RETRY', 'RUNNING')
    ORDER BY j.created_at DESC LIMIT 1
) job ON true
LEFT JOIN LATERAL (
    SELECT e.payload->>'phase' AS phase, e.payload->>'text' AS text
    FROM chat_events e WHERE e.job_id = job.id AND e.type = 'status' AND e.payload ? 'phase'
    ORDER BY e.id DESC LIMIT 1
) st ON true
LEFT JOIN LATERAL (
    SELECT e.payload->>'text' AS text
    FROM chat_events e WHERE e.job_id = job.id AND e.type = 'status' AND e.payload->>'phase' = 'working'
    ORDER BY e.id DESC LIMIT 1
) lbl ON true
-- The newest thing the bot said: a message or a card in any status.
LEFT JOIN LATERAL (
    SELECT GREATEST(
        (SELECT m.created_at FROM messages m WHERE m.conversation_id = t.id AND m.role = 'ASSISTANT'
         ORDER BY m.created_at DESC, m.id DESC LIMIT 1),
        (SELECT max(a.created_at) FROM approvals a WHERE a.conversation_id = t.id)
    ) AS at
) said ON true
WHERE b.deleted_at IS NULL;

-- 0053 replaced the message copies inside chat operations by the message ids. Code from before it
-- could still store a copy until the new code was live, so the same statement runs once more.
UPDATE operations
SET result = jsonb_build_object(
        'kind', result->'kind',
        'value', jsonb_strip_nulls(jsonb_build_object(
            'assistantMessageId', result->'value'->'assistantMessage'->'id',
            'userMessageId', result->'value'->'userMessage'->'id',
            'approvalIds', COALESCE(result->'value'->'approvalIds', '[]'::jsonb))))
WHERE type = 'CHAT_MESSAGE' AND result->'value' ? 'assistantMessage';
