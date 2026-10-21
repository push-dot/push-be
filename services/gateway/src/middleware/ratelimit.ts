/**
 * Shared Neon rate-limit lease. One module owns the isolate maps so a
 * grant, a spend, and a waitUntil return see the same numbers.
 */

import { createIsolateCache } from "./cache.ts";
import type { Deps } from "../types.ts";

const missingCompanyTable = (err: unknown): boolean => {
  const e = err as { code?: string; message?: string };
  const text = `${e?.code || ""} ${e?.message || ""} ${String(err)}`;
  return e?.code === "42P01" || e?.code === "42703" || /42P01|42703|relation .* does not exist|column .* does not exist/i.test(text);
};

export const queryToleratingCompany = async (run: Deps["query"], sql: string, params: unknown[]): Promise<Record<string, unknown>[]> => {
  try {
    return await run(sql, params);
  } catch (err) {
    if (!sql.includes("company_members") || !missingCompanyTable(err)) throw err;
    const fallback = sql
      .replaceAll("m.company_id, m.role AS company_role", "NULL::uuid AS company_id, NULL::text AS company_role")
      .replaceAll(" LEFT JOIN company_members m ON m.user_id = u.id", "")
      .replaceAll("LEFT JOIN company_members m ON m.user_id = u.id", "");
    if (fallback === sql || fallback.includes("company_members")) throw err;
    return run(fallback, params);
  }
};

const hits = new Map<string, number[]>();
// Buckets this isolate has seen filled. Further requests are rejected
// here and do not write Neon.
export const remoteHits = new Map<string, number>();
// Hits already added to the shared counter and not yet handed to a request.
// One number per token and minute. Concurrent grants add to it; they do not
// replace it. A request takes its unit out before it awaits, so a timer
// cannot give that unit back.
interface Lease {
  remaining: number;
  size: number;
  expiresAt: number;
  spent: boolean;
  bucket: string;
  // Debounce token. An older timer sees a newer value and leaves the pool
  // untouched. The newest timer releases whatever `remaining` is then.
  timer: number;
  // Counter and read cap after the latest grant.
  hits: number;
  cap: number;
}
export const leases = new Map<string, Lease>();
export const isolate = createIsolateCache();

// A cold isolate claims 1. The batch doubles only after that grant is used
// up before it expires, and never past this cap. A wide lease stranded hits
// on isolates that never saw another request.
const MAX_LEASE = 8;
const LEASE_TTL_MS = 5_000;
// Short enough that Workers still runs it after the response. A 5s timer
// never landed, so the row kept the unused hits.
const RELEASE_DELAY_MS = 250;

// Reads stop this far under the shared cap so a burst of GETs leaves room
// for Python writes on the same `user:{id}:{minute}` row.
export function readCap(limit: number): number {
  if (limit < 10) return limit;
  return limit - Math.floor(limit / 10);
}
// The update runs only while the row is still under the limit, so a 429
// does not keep incrementing the counter. An empty RETURNING means full.
const RATE_SQL = "INSERT INTO rate_limits (bucket, hits, expires_at) "
  + "VALUES ($1, 1, to_timestamp($2::double precision)) "
  + "ON CONFLICT (bucket) DO UPDATE SET hits = rate_limits.hits + 1 "
  + "WHERE rate_limits.hits < $3 "
  + "RETURNING hits";

// Timestamps stay text. A JS Date only has milliseconds, so the Neon driver
// turned `...644999` into `...644000` and made ETags and cursors unstable.
const TS_FMT = "YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"";
export function tsText(expr: string): string {
  return "to_char(" + expr + " AT TIME ZONE 'UTC', '" + TS_FMT + "')";
}

// Auth and the user bucket are one Neon HTTP call. A separate upsert was
// a serial round trip on every authenticated GET (~270ms). The bucket is
// still `user:{id}:{minute}`, shared with the Python worker. An expired
// token is selected but not counted. A full bucket returns hits NULL.
export const AUTH_SQL = "SELECT u.id, u.display_name, u.locale, "
  + tsText("u.created_at") + " AS created_at, "
  + tsText("t.expires_at") + " AS expires_at, "
  + "u.is_employer, m.company_id, m.role AS company_role "
  + "FROM access_tokens t JOIN users u ON u.id = t.user_id "
  + "LEFT JOIN company_members m ON m.user_id = u.id WHERE t.token_hash = $1";

// Auth and a quota lease are one Neon HTTP call. $4 is the read cap (the
// shared limit minus write headroom). $6 is the batch, $7 is unused hits
// from an expired lease. The upsert adds at most that batch, after giving
// the unused hits back, and never moves hits past the cap. As the row nears
// the cap the grant shrinks to max(1, room / 16) so one isolate cannot
// take a tail it will not serve. `granted` is the increment this statement
// applied. It is written into the sweep-only expiry (whole seconds past $3)
// by the same UPDATE that changes hits. A prior read of hits cannot be
// subtracted: the statement snapshot stays stale while the row lock waits.
const LEASE_AFTER = "GREATEST(0, rate_limits.hits - GREATEST($7::int, 0))";
const LEASE_ROOM = `GREATEST(0, $4::int - ${LEASE_AFTER})`;
const LEASE_SHRINK = `CASE WHEN ${LEASE_ROOM} = 0 THEN 0 ELSE GREATEST(1, ${LEASE_ROOM} / 16) END`;
const LEASE_UPDATE = `LEAST($6::int, ${LEASE_ROOM}, ${LEASE_SHRINK})`;
const LEASE_INSERT = "LEAST($6::int, $4::int, CASE WHEN $4::int = 0 THEN 0 ELSE GREATEST(1, $4::int / 16) END)";
const AUTH_RATE_PREFIX = "WITH auth AS ("
  + "SELECT u.id, u.display_name, u.locale, "
  + tsText("u.created_at") + " AS created_at, "
  + tsText("t.expires_at") + " AS expires_at, t.expires_at AS token_expires, "
  + "u.is_employer, m.company_id, m.role AS company_role "
  + "FROM access_tokens t JOIN users u ON u.id = t.user_id "
  + "LEFT JOIN company_members m ON m.user_id = u.id WHERE t.token_hash = $1"
  + "), live AS ("
  + "SELECT id FROM auth WHERE token_expires >= to_timestamp($5::double precision)"
  + "), bumped AS ("
  + "INSERT INTO rate_limits (bucket, hits, expires_at) "
  + "SELECT 'user:' || auth.id::text || ':' || $2::text, "
  + `${LEASE_INSERT}, to_timestamp($3::double precision) + ${LEASE_INSERT} * interval '1 second' `
  + "FROM auth JOIN live ON live.id = auth.id "
  + "ON CONFLICT (bucket) DO UPDATE SET "
  + `hits = ${LEASE_AFTER} + ${LEASE_UPDATE}, `
  + `expires_at = to_timestamp($3::double precision) + ${LEASE_UPDATE} * interval '1 second' `
  + "WHERE $7::int > 0 OR rate_limits.hits < $4::int "
  + "RETURNING hits, "
  + "(EXTRACT(EPOCH FROM expires_at) - $3::double precision)::bigint AS granted"
  + ") ";

const AUTH_COLUMNS = "auth.id, auth.display_name, auth.locale, auth.created_at, auth.expires_at, "
  + "auth.is_employer, auth.company_id, auth.company_role, "
  + "(SELECT hits FROM bumped) AS hits, "
  + "(SELECT granted FROM bumped) AS granted";

export const AUTH_RATE_SQL = AUTH_RATE_PREFIX
  + "SELECT " + AUTH_COLUMNS + " FROM auth";

export const LIST_SQL = AUTH_RATE_PREFIX
  + ", page AS ("
  + "SELECT c.id, c.revision, c.application_id, c.title, c.pinned, c.created_at, c.updated_at "
  + "FROM conversations c JOIN live ON live.id = c.user_id "
  + "WHERE EXISTS (SELECT 1 FROM bumped) AND c.archived = false "
  + "AND c.company_id IS NULL "
  + "AND ($8::uuid IS NULL OR c.application_id = $8::uuid) "
  + "AND ($9::timestamptz IS NULL OR (c.created_at, c.id) < ($9::timestamptz, $10::uuid)) "
  + "ORDER BY c.created_at DESC, c.id DESC LIMIT $11"
  + ") SELECT " + AUTH_COLUMNS + ", COALESCE((SELECT json_agg(json_build_object("
  + "'id', page.id, 'revision', page.revision, 'application_id', page.application_id, "
  + "'title', page.title, 'pinned', page.pinned, 'created_at', " + tsText("page.created_at") + ", "
  + "'updated_at', " + tsText("page.updated_at")
  + ") ORDER BY page.created_at DESC, page.id DESC) FROM page), '[]'::json) AS rows FROM auth";

export const MESSAGES_SQL = AUTH_RATE_PREFIX
  + ", found AS ("
  + "SELECT id FROM conversations WHERE id = $8::uuid AND user_id = (SELECT id FROM live)"
  + "), page AS ("
  + "SELECT m.id, m.conversation_id, m.role, m.text, m.attachments, m.operation_id, m.created_at "
  + "FROM messages m JOIN found ON found.id = m.conversation_id "
  + "WHERE EXISTS (SELECT 1 FROM bumped) AND m.user_id = (SELECT id FROM live) "
  + "AND ($9::timestamptz IS NULL OR (m.created_at, m.id) < ($9::timestamptz, $10::uuid)) "
  + "ORDER BY m.created_at DESC, m.id DESC LIMIT $11"
  + ") SELECT " + AUTH_COLUMNS + ", (SELECT id FROM found) AS conversation_id, "
  + "COALESCE((SELECT json_agg(json_build_object("
  + "'id', page.id, 'conversation_id', page.conversation_id, 'role', page.role, "
  + "'text', page.text, 'attachments', page.attachments, 'operation_id', page.operation_id, "
  + "'created_at', " + tsText("page.created_at")
  + ") ORDER BY page.created_at DESC, page.id DESC) FROM page), '[]'::json) AS rows FROM auth";

export const STREAM_SQL = AUTH_RATE_PREFIX
  + ", found AS ("
  + "SELECT id FROM conversations WHERE id = $8::uuid AND user_id = (SELECT id FROM live)"
  + "), job AS ("
  + "SELECT id FROM chat_jobs WHERE user_id = (SELECT id FROM live) "
  + "AND conversation_id = (SELECT id FROM found) "
  + "AND status IN ('PENDING', 'RUNNING') AND EXISTS (SELECT 1 FROM bumped) "
  + "ORDER BY created_at DESC LIMIT 1"
  + ") SELECT " + AUTH_COLUMNS + ", (SELECT id FROM found) AS conversation_id, "
  + "(SELECT id FROM job) AS job_id FROM auth";

export const MODELS_SQL = AUTH_RATE_PREFIX
  + "SELECT " + AUTH_COLUMNS + ", EXISTS(SELECT 1 FROM ai_keys k "
  + "WHERE k.user_id = auth.id AND k.provider = 'OPENAI') AS has FROM auth";

export function resetLimits(): void {
  hits.clear();
  remoteHits.clear();
  leases.clear();
  isolate.reset();
}

const RELEASE_SQL = "UPDATE rate_limits SET hits = GREATEST(0, hits - $2::int) "
  + "WHERE bucket = $1 AND $2::int > 0 RETURNING hits";

async function releaseLease(deps: Deps, lease: Lease): Promise<void> {
  if (lease.remaining <= 0) return;
  const amount = lease.remaining;
  lease.remaining = 0;
  lease.spent = false;
  try {
    await deps.query(RELEASE_SQL, [lease.bucket, amount]);
  } catch {
    return;
  }
}

// Give unused hits back when the minute rolls or this isolate handles
// another request after the lease TTL. The waitUntil timer covers isolates
// that never see that next request.
export async function releaseExpired(deps: Deps, nowMs: number, exceptKey = ""): Promise<void> {
  const currentWindow = exceptKey.includes(":") ? exceptKey.slice(exceptKey.lastIndexOf(":") + 1) : "";
  const due: [string, Lease][] = [];
  for (const [key, lease] of leases) {
    if (key === exceptKey) continue;
    const window = key.slice(key.lastIndexOf(":") + 1);
    const minuteRolled = currentWindow !== "" && window !== currentWindow;
    if (lease.remaining > 0 && (minuteRolled || nowMs >= lease.expiresAt)) due.push([key, lease]);
  }
  for (const [key, lease] of due) {
    await releaseLease(deps, lease);
    leases.delete(key);
    remoteHits.delete(key);
  }
}

function nearCap(lease: Lease): boolean {
  const room = lease.cap - lease.hits;
  return lease.hits >= lease.cap - Math.floor(lease.cap / 8)
    || room < Math.max(lease.size, 1) * 16;
}

// A lone unused hit is not worth a Neon update while most of the cap is
// still free. Anything larger, and any leftover once the counter has
// climbed, still goes back.
function worthReturning(lease: Lease): boolean {
  if (lease.remaining <= 0) return false;
  if (lease.remaining <= 1 && lease.hits < Math.floor(lease.cap / 4)) return false;
  return true;
}

function releaseDelayMs(lease: Lease): number {
  const mostlyUnused = lease.remaining >= lease.size - 1 || lease.remaining * 2 >= lease.size;
  if (mostlyUnused && nearCap(lease)) return 0;
  return RELEASE_DELAY_MS;
}

// One timer per key. Whichever waitUntil fires last subtracts the whole
// unused pool, after taking it out of the local number so a second timer
// cannot subtract it again. The bucket is `user:{id}:{minute}`.
function armRelease(deps: Deps, cacheKey: string): void {
  if (!deps.waitUntil) return;
  const lease = leases.get(cacheKey);
  if (!lease || !worthReturning(lease)) return;
  const epoch = ++lease.timer;
  const delay = releaseDelayMs(lease);
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  deps.waitUntil((async () => {
    await sleep(delay);
    const current = leases.get(cacheKey);
    if (!current || current.timer !== epoch || !worthReturning(current)) return;
    await releaseLease(deps, current);
    if (leases.get(cacheKey) === current && current.remaining <= 0) {
      leases.delete(cacheKey);
      remoteHits.delete(cacheKey);
    }
  })());
}
export function allow(key: string, limit: number, windowMs: number, nowMs: number): boolean {
  const list = hits.get(key) ?? [];
  const cutoff = nowMs - windowMs;
  const kept = list.filter((t) => t > cutoff);
  if (kept.length >= limit) {
    hits.set(key, kept);
    return false;
  }
  kept.push(nowMs);
  if (hits.size > 10000) {
    for (const [name, times] of hits) {
      if (!times.some((t) => t > cutoff)) hits.delete(name);
    }
  }
  hits.set(key, kept);
  return true;
}

function rememberHits(bucket: string, row: Record<string, unknown> | undefined, limit: number): void {
  if (!row || row.hits == null || row.hits === "") {
    remoteHits.set(bucket, limit);
    return;
  }
  remoteHits.set(bucket, Number(row.hits));
}

export async function allowShared(
  deps: Deps, kind: string, key: string, limit: number, windowMs: number, now: Date,
): Promise<boolean> {
  const window = Math.floor(now.getTime() / 1000 / 60);
  const bucket = `${kind}:${key || "unknown"}:${window}`;
  const known = remoteHits.get(bucket);
  if (known !== undefined && known >= limit) return false;
  try {
    const rows = await deps.query(RATE_SQL, [bucket, window * 60 + 120, limit]);
    const row = rows[0];
    if (!row || row.hits == null || row.hits === "") {
      remoteHits.set(bucket, limit);
      return false;
    }
    const n = Number(row.hits);
    remoteHits.set(bucket, n);
    return n <= limit;
  } catch {
    // Missing table or a Neon blip: count in this isolate and try the
    // shared counter again on the next request.
  }
  return allow(bucket, limit, windowMs, now.getTime());
}
export async function clearLease(deps: Deps, hash: string): Promise<void> {
  const prefix = `user:${hash}:`;
  const owned: [string, Lease][] = [];
  for (const [key, lease] of leases) {
    if (key.startsWith(prefix)) owned.push([key, lease]);
  }
  for (const [key, lease] of owned) {
    await releaseLease(deps, lease);
    leases.delete(key);
    remoteHits.delete(key);
  }
}
export function windowOf(moment: Date): number {
  return Math.floor(moment.getTime() / 1000 / 60);
}

export function rateParams(hash: string, moment: Date, limit: number, batch: number, release: number): unknown[] {
  const window = windowOf(moment);
  const size = Math.max(1, Math.min(MAX_LEASE, batch));
  return [
    hash, String(window), window * 60 + 120, readCap(limit), moment.getTime() / 1000,
    size, Math.max(0, release),
  ];
}
export function acceptGrant(
  cacheKey: string, row: Record<string, unknown>, limit: number, nowMs: number, bucket: string, deps: Deps,
): boolean {
  rememberHits(cacheKey, row, limit);
  const hitsValue = row.hits;
  if (hitsValue == null || hitsValue === "" || Number(hitsValue) > limit) {
    leases.delete(cacheKey);
    return false;
  }
  const granted = Object.prototype.hasOwnProperty.call(row, "granted")
    ? Number(row.granted)
    : 1;
  if (!Number.isFinite(granted) || granted <= 0) {
    remoteHits.set(cacheKey, limit);
    leases.delete(cacheKey);
    return false;
  }
  const left = Math.max(0, granted - 1);
  const prev = leases.get(cacheKey);
  const remaining = (prev?.remaining ?? 0) + left;
  const lease: Lease = {
    remaining,
    size: granted,
    expiresAt: nowMs + LEASE_TTL_MS,
    spent: remaining === 0,
    bucket,
    timer: prev?.timer ?? 0,
    hits: Number(hitsValue),
    cap: limit,
  };
  leases.set(cacheKey, lease);
  if (remaining > 0) armRelease(deps, cacheKey);
  if (Number(hitsValue) >= limit && remaining <= 0) remoteHits.set(cacheKey, limit);
  return true;
}

export function spendLease(cacheKey: string, nowMs: number, deps: Deps): void {
  const lease = leases.get(cacheKey);
  if (!lease || lease.remaining <= 0) return;
  lease.remaining -= 1;
  lease.expiresAt = nowMs + LEASE_TTL_MS;
  if (lease.remaining === 0) {
    lease.spent = true;
    return;
  }
  armRelease(deps, cacheKey);
}
export function nextBatch(lease: Lease | undefined, nowMs: number, release: number): number {
  if (!lease || release > 0) return 1;
  if (lease.spent && lease.remaining <= 0 && nowMs < lease.expiresAt) {
    return Math.min(MAX_LEASE, Math.max(1, lease.size) * 2);
  }
  return 1;
}
