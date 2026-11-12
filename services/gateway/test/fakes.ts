import type { Query } from "../src/handler.ts";

export const STORED = "2026-10-18T00:00:01.250000Z";

export const isBotThreadProbe = (sql: string): boolean => sql.includes("bot_id IS NOT NULL");

/**
 * What a fake of one route leaves out. The gateway asks whether a named conversation is a bot's thread
 * before it routes, and a fake answers any statement it does not know, so that probe is answered here:
 * no conversation is a thread. And every chat_events row has a created_at, which a frame sends as `at`.
 */
export const complete = (query: Query): Query => async (sql, params) => {
  if (isBotThreadProbe(sql)) return [];
  const rows = await query(sql, params);
  return sql.includes("FROM chat_events") ? rows.map((row) => ({ created_at: STORED, ...row })) : rows;
};
