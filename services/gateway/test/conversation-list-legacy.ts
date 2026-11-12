/** Pre-272 list enrichment (correlated subqueries). Used only to parity-check Postgres results. */
import { LAST_MSG_LATERAL } from "../src/middleware/ratelimit.ts";

export const LEGACY_LAST_LINE = "COALESCE("
  + "(SELECT NULLIF(a.title, '') FROM approvals a WHERE a.conversation_id = c.id AND a.status = 'PENDING' "
  + "AND (a.expires_at IS NULL OR a.expires_at > now()) ORDER BY a.created_at DESC LIMIT 1), "
  + "(SELECT NULLIF(COALESCE(NULLIF(concat_ws(' · ', NULLIF(e.payload->>'summary', ''), NULLIF(e.payload->>'target', '')), ''), "
  + "e.payload->>'text'), '') FROM chat_events e WHERE e.job_id = (SELECT j.id FROM chat_jobs j "
  + "WHERE j.conversation_id = c.id AND j.status IN ('PENDING', 'RUNNING') ORDER BY j.created_at DESC LIMIT 1) "
  + "AND e.type IN ('status', 'tool') ORDER BY e.id DESC LIMIT 1)) AS last_line";

export const LEGACY_QUEUE_POSITION = "(SELECT CASE WHEN me.at IS NULL THEN NULL ELSE (SELECT count(*)::int FROM chat_jobs p "
  + "JOIN conversations pc ON pc.id = p.conversation_id "
  + "WHERE p.status = 'PENDING' AND p.created_at < me.at "
  + "AND (CASE WHEN c.company_id IS NOT NULL THEN pc.company_id = c.company_id ELSE pc.user_id = c.user_id AND pc.company_id IS NULL END)) "
  + "END FROM (SELECT min(j.created_at) AS at FROM chat_jobs j "
  + "WHERE j.conversation_id = c.id AND j.status = 'PENDING') me) AS queue_position";

export const LEGACY_STATUS = "CASE WHEN EXISTS (SELECT 1 FROM approvals a WHERE a.conversation_id = c.id AND a.status = 'PENDING' "
  + "AND (a.expires_at IS NULL OR a.expires_at > now())) THEN 'NEEDS_APPROVAL' "
  + "WHEN EXISTS (SELECT 1 FROM chat_jobs j WHERE j.conversation_id = c.id AND j.status IN ('PENDING', 'RUNNING')) THEN 'RUNNING' "
  + "ELSE 'DONE' END AS status";

export function legacyConversationListSelect(whereSql: string, liveJoin = ""): string {
  return "SELECT c.id, "
    + LEGACY_STATUS + ", " + LEGACY_LAST_LINE + ", " + LEGACY_QUEUE_POSITION + ", "
    + "COALESCE(left(last_msg.text, 140), '') AS last_message_preview "
    + "FROM conversations c " + liveJoin
    + "LEFT JOIN LATERAL (SELECT m.text FROM messages m WHERE m.conversation_id = c.id "
    + "ORDER BY m.created_at DESC, m.id DESC LIMIT 1) last_msg ON true "
    + "WHERE " + whereSql + " "
    + "ORDER BY c.updated_at DESC, c.id DESC";
}
