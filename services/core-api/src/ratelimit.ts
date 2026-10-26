import { query, type Query } from "./db.ts";

const CONSUME_SQL = (
  "INSERT INTO rate_limits (bucket, hits, expires_at) "
  + "VALUES ($1, 1, to_timestamp($2::double precision)) "
  + "ON CONFLICT (bucket) DO UPDATE SET hits = rate_limits.hits + 1 "
  + "WHERE rate_limits.hits < $3 RETURNING hits"
);

// Fallback counters for the current minute only; a new minute clears them so the map stays bounded.
const memory = new Map<string, number>();
let memoryWindow = -1;

export function resetLimits(): void {
  memory.clear();
  memoryWindow = -1;
}

export const memoryBuckets = (): number => memory.size;

function memoryAllow(bucket: string, limit: number, window: number): boolean {
  if (window !== memoryWindow) {
    memory.clear();
    memoryWindow = window;
  }
  const hits = memory.get(bucket) ?? 0;
  if (hits >= limit) return false;
  memory.set(bucket, hits + 1);
  return true;
}

/** A failed counter must not take the route down; the in-isolate window is the same fallback the Python worker uses. */
export async function allow(q: Query, kind: string, key: string, limit: number, nowMs: number): Promise<boolean> {
  const window = Math.floor(nowMs / 1000 / 60);
  const bucket = `${kind}:${key || "unknown"}:${window}`;
  try {
    const result = await query(q, CONSUME_SQL, [bucket, window * 60 + 120, limit]);
    if (result.rows.length === 0) return false;
    return Number(result.rows[0].hits) <= limit;
  } catch {
    return memoryAllow(bucket, limit, window);
  }
}
