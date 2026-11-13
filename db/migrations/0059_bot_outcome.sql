-- A bot whose last run failed, and a bot whose last card ran out unanswered, read as nothing running.
-- The app draws them as their own rows (AgentHomeRowExpiredFailed), so bot_state_v names them:
-- outcome_kind is 'expired', 'failed' or null, outcome_at is when it happened.
-- Additive: two columns appended to the view; no index, the two new lookups use
-- approvals_conversation_created_idx (0054) and idx_ai_jobs_conversation (0027).
-- Revert: restore the definition of 0054.

CREATE OR REPLACE VIEW bot_state_v AS
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
    (said.at IS NOT NULL AND (rm.read_at IS NULL OR said.at > rm.read_at)) AS unread,
    oc.kind AS outcome_kind,
    oc.at AS outcome_at
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
-- The newest card in any status and the newest chat run in any status.
LEFT JOIN LATERAL (
    SELECT a.id, a.status, a.created_at, a.expires_at
    FROM approvals a WHERE a.conversation_id = t.id ORDER BY a.created_at DESC LIMIT 1
) lc ON true
LEFT JOIN LATERAL (
    SELECT j.id, j.status, j.created_at, j.updated_at
    FROM ai_jobs j WHERE j.conversation_id = t.id AND j.type = 'chat' ORDER BY j.created_at DESC LIMIT 1
) lj ON true
-- How the bot's last run ended, only while nothing runs and no card is open. A card is newer than
-- the run that asked it, so a card newer than the newest run is one the user never answered.
LEFT JOIN LATERAL (
    SELECT x.kind, x.at FROM (
        SELECT 'expired' AS kind, COALESCE(lc.expires_at, lc.created_at) AS at
        WHERE lc.id IS NOT NULL AND (lj.id IS NULL OR lc.created_at > lj.created_at)
          AND (lc.status = 'EXPIRED' OR (lc.status = 'PENDING' AND lc.expires_at <= now()))
        UNION ALL
        SELECT 'failed', lj.updated_at
        WHERE lj.status IN ('FAILED', 'DEAD') AND (lc.id IS NULL OR lj.created_at >= lc.created_at)
    ) x
    WHERE card.id IS NULL AND job.id IS NULL
    LIMIT 1
) oc ON true
-- The newest thing the bot said: a message or a card in any status.
LEFT JOIN LATERAL (
    SELECT GREATEST(
        (SELECT m.created_at FROM messages m WHERE m.conversation_id = t.id AND m.role = 'ASSISTANT'
         ORDER BY m.created_at DESC, m.id DESC LIMIT 1),
        (SELECT max(a.created_at) FROM approvals a WHERE a.conversation_id = t.id)
    ) AS at
) said ON true
WHERE b.deleted_at IS NULL;
