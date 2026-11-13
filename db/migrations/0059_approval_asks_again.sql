-- The rule "a tool card with a lifetime" lived in approval_retryable (0058) and again in the retry
-- route's own SQL (services/core-api/src/routes/bot-approvals.ts). It now lives only here.
-- Additive: approval_retryable answers what it answered before.
-- Revert: restore approval_retryable's body from 0058, then DROP FUNCTION approval_expires(approvals).

-- A tool card that carries a lifetime: the only card 다시 요청 can ask again.
CREATE FUNCTION approval_expires(a approvals) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
    SELECT a.kind = 'TOOL_ACTION' AND a.expires_at IS NOT NULL
$$;

CREATE OR REPLACE FUNCTION approval_retryable(a approvals) RETURNS boolean
LANGUAGE sql STABLE AS $$
    SELECT approval_expires(a) AND a.status IN ('PENDING', 'EXPIRED')
        AND NOT approval_superseded(a.conversation_id, a.created_at)
$$;
