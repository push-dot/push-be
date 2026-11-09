import type { Query } from "../db.ts";
import { one } from "../db.ts";
import { queueDepthLimit, RETRY_AFTER_SEC, type Plan, type QueueName } from "./config.ts";

export type QueueOwner = { userId: string; companyId?: string };

// The depth gate is global, but `ahead` counts only the caller's own tenant so no other tenant's load is revealed.
export const checkBackpressure = async (
  db: Query,
  queue: QueueName,
  plan: Plan,
  owner: QueueOwner,
): Promise<{ ok: true } | { ok: false; retryAfterSec: number; ahead: number }> => {
  const row = await one(
    db,
    "SELECT count(*)::int AS n FROM ai_jobs WHERE queue = $1 AND status IN ('QUEUED', 'RETRY')",
    [queue],
  );
  if (Number(row?.n || 0) <= queueDepthLimit(plan)) return { ok: true };
  const own = await one(
    db,
    "SELECT count(*)::int AS n FROM ai_jobs WHERE queue = $1 AND status IN ('QUEUED', 'RETRY') "
      + "AND (CASE WHEN $3::uuid IS NOT NULL THEN company_id = $3::uuid ELSE user_id = $2::uuid AND company_id IS NULL END)",
    [queue, owner.userId, owner.companyId ?? null],
  );
  return { ok: false, retryAfterSec: RETRY_AFTER_SEC, ahead: Number(own?.n || 0) };
};
