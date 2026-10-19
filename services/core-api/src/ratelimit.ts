import { query, type Query } from "./db.ts";

const CONSUME_SQL = (
  "INSERT INTO rate_limits (bucket, hits, expires_at) "
  + "VALUES ($1, 1, to_timestamp($2::double precision)) "
  + "ON CONFLICT (bucket) DO UPDATE SET hits = rate_limits.hits + 1 "
  + "WHERE rate_limits.hits < $3 RETURNING hits"
);

const memory = new Map<string, number[]>();

export function resetLimits(): void {
  memory.clear();
}

function memoryAllow(bucket: string, limit: number, now: number): boolean {
  const hits = memory.get(bucket) || [];
  const cutoff = now - 60_000;
  const kept = hits.filter((t) => t > cutoff);
  if (kept.length >= limit) {
    memory.set(bucket, kept);
    return false;
  }
  kept.push(now);
  memory.set(bucket, kept);
  return true;
}

function missingTable(err: unknown): boolean {
  const text = String((err as { message?: string })?.message || err).toLowerCase();
  const code = (err as { code?: string })?.code || "";
  return code === "42P01" || (text.includes("rate_limits") && text.includes("does not exist"));
}

export async function allow(q: Query, kind: string, key: string, limit: number, nowMs: number): Promise<boolean> {
  const window = Math.floor(nowMs / 1000 / 60);
  const bucket = `${kind}:${key || "unknown"}:${window}`;
  try {
    const result = await query(q, CONSUME_SQL, [bucket, window * 60 + 120, limit]);
    if (result.rows.length === 0) return false;
    return Number(result.rows[0].hits) <= limit;
  } catch (err) {
    if (!missingTable(err)) {
      // A failed counter must not take the route down. The in-isolate
      // window is the same fallback the Python worker uses.
    }
    return memoryAllow(bucket, limit, nowMs);
  }
}
