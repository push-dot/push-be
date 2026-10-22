import type { Query } from "../db.ts";
import { one } from "../db.ts";
import { queueDepthLimit, RETRY_AFTER_SEC, type Plan, type QueueName } from "./config.ts";

export const checkBackpressure = async (
  db: Query,
  queue: QueueName,
  plan: Plan,
): Promise<{ ok: true } | { ok: false; retryAfterSec: number }> => {
  const row = await one(
    db,
    "SELECT count(*)::int AS n FROM ai_jobs WHERE queue = $1 AND status IN ('QUEUED', 'RETRY')",
    [queue],
  );
  if (Number(row?.n || 0) > queueDepthLimit(plan)) {
    return { ok: false, retryAfterSec: RETRY_AFTER_SEC };
  }
  return { ok: true };
};
