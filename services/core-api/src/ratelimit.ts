import { query, type Query } from "./db.ts";

// Runs on Cloudflare Workers (no Redis). Neon ``rate_limits`` is the source of
// truth: one CONSUME upsert per request while the bucket is not known full;
// callers that pass a chunk lease that many tokens per upsert instead.
// ``remoteHits`` only short-circuits repeat denials in this isolate for the
// current UTC minute; it never grants quota without a successful consume.
// On Neon failure, ``memory`` is a last-resort per-isolate counter (same as the
// Python worker). wrangler.jsonc has no KV, Durable Objects, or rate-limiting
// bindings today.

const CONSUME_SQL = (
  "INSERT INTO rate_limits (bucket, hits, expires_at) "
  + "VALUES ($1, 1, to_timestamp($2::double precision)) "
  + "ON CONFLICT (bucket) DO UPDATE SET hits = rate_limits.hits + 1 "
  + "WHERE rate_limits.hits < $3 RETURNING hits"
);

// A lease takes $4 tokens at once; the row may pass $3 by up to $4 - 1, but the tokens granted never do.
const LEASE_SQL = (
  "INSERT INTO rate_limits (bucket, hits, expires_at) "
  + "VALUES ($1, $4, to_timestamp($2::double precision)) "
  + "ON CONFLICT (bucket) DO UPDATE SET hits = rate_limits.hits + $4 "
  + "WHERE rate_limits.hits < $3 RETURNING hits"
);

// Tokens per lease for the per-user bucket (600/min): 1/60 of the limit. Each isolate that served the
// user can strand up to USER_LEASE - 1 leased tokens when the minute rolls over, so a user spread over
// k isolates sees 429 after at least 600 - 9k requests, not a fixed 590.
export const USER_LEASE = 10;

// Fallback counters for the current minute only; a new minute clears them so the map stays bounded.
const memory = new Map<string, number>();
let memoryWindow = -1;
// Buckets this isolate has seen filled. Further requests are rejected
// here and do not write Neon.
const remoteHits = new Map<string, number>();
let remoteWindow = -1;

const leases = new Map<string, number>();

export function resetLimits(): void {
  leases.clear();
  memory.clear();
  memoryWindow = -1;
  remoteHits.clear();
  remoteWindow = -1;
}

export const memoryBuckets = (): number => memory.size;

function syncRemoteWindow(window: number): void {
  if (window !== remoteWindow) {
    remoteHits.clear();
    leases.clear();
    remoteWindow = window;
  }
}

function rememberHits(bucket: string, hits: number | null, limit: number): void {
  remoteHits.set(bucket, hits == null ? limit : hits);
}

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

async function lease(q: Query, bucket: string, limit: number, window: number, chunk: number): Promise<boolean> {
  const size = Math.min(chunk, limit);
  for (;;) {
    const left = leases.get(bucket) ?? 0;
    if (left > 0) {
      leases.set(bucket, left - 1);
      return true;
    }
    if ((remoteHits.get(bucket) ?? 0) >= limit) return false;
    // Only resolved counts are stored: a promise shared between requests would break Workers' per-request I/O.
    try {
      const result = await query(q, LEASE_SQL, [bucket, window * 60 + 120, limit, size]);
      if (result.rows.length === 0) {
        rememberHits(bucket, null, limit);
        continue;
      }
      const granted = Math.min(size, limit - (Number(result.rows[0].hits) - size));
      if (granted < size) rememberHits(bucket, null, limit);
      if (granted > 0) leases.set(bucket, (leases.get(bucket) ?? 0) + granted);
    } catch {
      return memoryAllow(bucket, limit, window);
    }
  }
}

/** A failed counter must not take the route down; the in-isolate window is the same fallback the Python worker uses. */
export async function allow(
  q: Query,
  kind: string,
  key: string,
  limit: number,
  nowMs: number,
  chunk = 1,
): Promise<boolean> {
  const window = Math.floor(nowMs / 1000 / 60);
  const bucket = `${kind}:${key || "unknown"}:${window}`;
  syncRemoteWindow(window);
  if (chunk > 1) return lease(q, bucket, limit, window, chunk);
  const known = remoteHits.get(bucket);
  if (known !== undefined && known >= limit) return false;
  try {
    const result = await query(q, CONSUME_SQL, [bucket, window * 60 + 120, limit]);
    if (result.rows.length === 0) {
      rememberHits(bucket, null, limit);
      return false;
    }
    const hits = Number(result.rows[0].hits);
    rememberHits(bucket, hits, limit);
    return hits <= limit;
  } catch {
    return memoryAllow(bucket, limit, window);
  }
}
