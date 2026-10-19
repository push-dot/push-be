/**
 * TypeScript front Worker.
 *
 * Handles the requests that were spending a Neon WebSocket handshake and
 * ~300ms of Python CPU: health, auth/me, conversation reads, SSE replay,
 * and the static model / job-site catalogs. Everything else is forwarded
 * to the Python worker through a service binding.
 */

import {
  clampTtl, createIsolateCache, memoryCache, modelCacheUrl, modelCacheUrls,
  weakEtag, workersCache, JOB_SITES_CACHE_URL, type CacheStore, type CachedUser,
} from "./cache.ts";
import { jobSitesBody, listModels, validCredentialMode, validProvider } from "./models.ts";
import { decodeCursor, encodeCursor, formatJsonTimestamp, pyJson } from "./time.ts";

export interface Query {
  (text: string, params: unknown[]): Promise<Record<string, unknown>[]>;
}

export interface FrontEnv {
  DATABASE_URL?: string;
  API: { fetch(input: Request): Promise<Response> };
  APP_ENV?: string;
  DEV_AUTH_TOKEN?: string;
  DEV_USER_ID?: string;
  MANAGED_AI?: string;
  MANAGED_GO?: string;
  SSE_MAX_POLLS?: string;
  MODEL_CACHE_TTL?: string;
  JOB_SITES_CACHE_TTL?: string;
  AUTH_CACHE_TTL?: string;
}

export interface Deps {
  query: Query;
  cache?: CacheStore;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  limits?: { user: number; public: number; windowMs: number };
  waitUntil?: (promise: Promise<unknown>) => void;
}

interface User {
  id: string;
  displayName: string;
  locale: string;
  createdAt: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const ALLOWED_ORIGINS = new Set([
  "tauri://localhost", "http://tauri.localhost", "https://tauri.localhost",
]);
const ALLOWED_HEADERS = new Set([
  "origin", "content-type", "accept", "authorization",
  "idempotency-key", "x-request-id", "x-byok-key",
]);

const hits = new Map<string, number[]>();
// Buckets this isolate has seen filled. Further requests are rejected
// here and do not write Neon.
const remoteHits = new Map<string, number>();
// Hits already added to the shared counter and not yet served.
interface Lease {
  remaining: number;
  size: number;
  expiresAt: number;
  spent: boolean;
  bucket: string;
  generation: number;
  // Counter and read cap after this grant. The return timer uses them to
  // decide whether unused hits should go back immediately.
  hits: number;
  cap: number;
}
const leases = new Map<string, Lease>();
let leaseSeq = 1;
const isolate = createIsolateCache();

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
function readCap(limit: number): number {
  if (limit < 10) return limit;
  return limit - Math.floor(limit / 10);
}

const USER_CACHE_CONTROL = "private, no-cache";

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
function tsText(expr: string): string {
  return "to_char(" + expr + " AT TIME ZONE 'UTC', '" + TS_FMT + "')";
}

// Auth and the user bucket are one Neon HTTP call. A separate upsert was
// a serial round trip on every authenticated GET (~270ms). The bucket is
// still `user:{id}:{minute}`, shared with the Python worker. An expired
// token is selected but not counted. A full bucket returns hits NULL.
const AUTH_SQL = "SELECT u.id, u.display_name, u.locale, "
  + tsText("u.created_at") + " AS created_at, "
  + tsText("t.expires_at") + " AS expires_at "
  + "FROM access_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = $1";

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
  + tsText("t.expires_at") + " AS expires_at, t.expires_at AS token_expires "
  + "FROM access_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = $1"
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
  + "(SELECT hits FROM bumped) AS hits, "
  + "(SELECT granted FROM bumped) AS granted";

const AUTH_RATE_SQL = AUTH_RATE_PREFIX
  + "SELECT " + AUTH_COLUMNS + " FROM auth";

const LIST_SQL = AUTH_RATE_PREFIX
  + ", page AS ("
  + "SELECT c.id, c.revision, c.application_id, c.title, c.pinned, c.created_at, c.updated_at "
  + "FROM conversations c JOIN live ON live.id = c.user_id "
  + "WHERE EXISTS (SELECT 1 FROM bumped) AND c.archived = false "
  + "AND ($8::uuid IS NULL OR c.application_id = $8::uuid) "
  + "AND ($9::timestamptz IS NULL OR (c.created_at, c.id) < ($9::timestamptz, $10::uuid)) "
  + "ORDER BY c.created_at DESC, c.id DESC LIMIT $11"
  + ") SELECT " + AUTH_COLUMNS + ", COALESCE((SELECT json_agg(json_build_object("
  + "'id', page.id, 'revision', page.revision, 'application_id', page.application_id, "
  + "'title', page.title, 'pinned', page.pinned, 'created_at', " + tsText("page.created_at") + ", "
  + "'updated_at', " + tsText("page.updated_at")
  + ") ORDER BY page.created_at DESC, page.id DESC) FROM page), '[]'::json) AS rows FROM auth";

const MESSAGES_SQL = AUTH_RATE_PREFIX
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

const STREAM_SQL = AUTH_RATE_PREFIX
  + ", found AS ("
  + "SELECT id FROM conversations WHERE id = $8::uuid AND user_id = (SELECT id FROM live)"
  + "), job AS ("
  + "SELECT id FROM chat_jobs WHERE user_id = (SELECT id FROM live) "
  + "AND conversation_id = (SELECT id FROM found) "
  + "AND status IN ('PENDING', 'RUNNING') AND EXISTS (SELECT 1 FROM bumped) "
  + "ORDER BY created_at DESC LIMIT 1"
  + ") SELECT " + AUTH_COLUMNS + ", (SELECT id FROM found) AS conversation_id, "
  + "(SELECT id FROM job) AS job_id FROM auth";

const MODELS_SQL = AUTH_RATE_PREFIX
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

function releaseDelayMs(lease: Lease): number {
  const mostlyUnused = lease.remaining >= lease.size - 1 || lease.remaining * 2 >= lease.size;
  const room = lease.cap - lease.hits;
  const nearCap = lease.hits >= lease.cap - Math.floor(lease.cap / 8)
    || room < Math.max(lease.size, 1) * 16;
  if (mostlyUnused && nearCap) return 0;
  return RELEASE_DELAY_MS;
}

// Return whatever this generation still holds. A later spend bumps the
// generation, so an older timer does not take hits the isolate is using.
// The delay stays inside the post-response window. Near the cap, a lease
// that this response barely touched goes back immediately.
function armRelease(deps: Deps, cacheKey: string, generation: number): void {
  if (!deps.waitUntil) return;
  const lease = leases.get(cacheKey);
  if (!lease || lease.generation !== generation || lease.remaining <= 0) return;
  const delay = releaseDelayMs(lease);
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  deps.waitUntil((async () => {
    await sleep(delay);
    const current = leases.get(cacheKey);
    if (!current || current.generation !== generation || current.remaining <= 0) return;
    current.spent = false;
    await releaseLease(deps, current);
    if (leases.get(cacheKey) === current) {
      leases.delete(cacheKey);
      remoteHits.delete(cacheKey);
    }
  })());
}

function authTtlMs(env: FrontEnv): number {
  // Cross-isolate revocation is bounded by this TTL. Logout on the isolate
  // that handled it drops the entry immediately.
  return clampTtl(env.AUTH_CACHE_TTL, 5, 5) * 1000;
}

function allow(key: string, limit: number, windowMs: number, nowMs: number): boolean {
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

async function allowShared(
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

function asBool(value: unknown): boolean {
  return value === true || value === "t" || value === "true" || value === 1;
}

function flag(value: string | undefined): boolean {
  const v = (value || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip")
    || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || "";
}

function corsHeaders(request: Request): Headers {
  const headers = new Headers();
  const origin = request.headers.get("origin") || "";
  if (origin && (ALLOWED_ORIGINS.has(origin) || ORIGIN_RE.test(origin))) {
    headers.set("access-control-allow-origin", origin);
    headers.set("access-control-allow-credentials", "true");
    headers.set("vary", "Origin");
  }
  return headers;
}

function withCors(request: Request, response: Response): Response {
  try {
    const headers = new Headers(response.headers);
    for (const [k, v] of corsHeaders(request)) {
      if (k.toLowerCase() === "vary") {
        const existing = headers.get("vary");
        headers.set("vary", existing ? `${existing}, ${v}` : v);
      } else if (!headers.has(k)) {
        headers.set(k, v);
      }
    }
    // 204/205/304 reject a body. Copying response.body threw and the
    // Worker recorded an exception instead of returning the response.
    if (response.status === 204 || response.status === 205 || response.status === 304) {
      headers.delete("content-length");
      return new Response(null, { status: response.status, headers });
    }
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch {
    return response;
  }
}

function requestIdOf(request: Request): string {
  const rid = request.headers.get("x-request-id") || "";
  if (!rid || rid.length > 128) return "req_" + crypto.randomUUID();
  return rid;
}

function jsonResponse(status: number, body: unknown, rid: string, contentType = "application/json"): Response {
  const text = pyJson(body);
  return new Response(text, {
    status,
    headers: {
      "content-type": contentType,
      "content-length": String(new TextEncoder().encode(text).byteLength),
      "x-request-id": rid,
    },
  });
}

function errorResponse(status: number, code: string, message: string, rid: string, details: unknown = null): Response {
  return jsonResponse(status, {
    error: { code, message, requestId: rid, details },
  }, rid, "application/json; charset=utf-8");
}

function fieldError(field: string, message: string, rid: string): Response {
  return errorResponse(400, "VALIDATION_ERROR", message, rid, { field });
}

function conditional(body: string, request: Request, rid: string, cacheControl: string): Response {
  const etag = weakEtag(body);
  const headers = new Headers({
    etag,
    "cache-control": cacheControl,
    vary: "Authorization",
    "x-request-id": rid,
  });
  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers });
  }
  headers.set("content-type", "application/json");
  headers.set("content-length", String(new TextEncoder().encode(body).byteLength));
  return new Response(body, { status: 200, headers });
}

async function freshRead(loaded: Response, request: Request, rid: string): Promise<Response> {
  if (loaded.status !== 200) return loaded;
  return conditional(await loaded.text(), request, rid, USER_CACHE_CONTROL);
}

async function clearLease(deps: Deps, hash: string): Promise<void> {
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

async function invalidateAfterWrite(request: Request, path: string, deps: Deps): Promise<void> {
  if (path !== "/api/v1/auth/logout" && path !== "/api/v1/auth/refresh") return;
  const authz = request.headers.get("authorization") || "";
  if (!authz.startsWith("Bearer ")) return;
  const token = authz.slice(7);
  if (!token) return;
  try {
    const hash = await sha256Hex(token);
    isolate.dropAuth(hash);
    await clearLease(deps, hash);
  } catch {
    return;
  }
}

async function sha256Hex(value: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function parseUuid(value: string): string | null {
  if (UUID_RE.test(value)) return value.toLowerCase();
  if (/^[0-9a-f]{32}$/i.test(value)) {
    const h = value.toLowerCase();
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }
  return null;
}

function pageLimit(url: URL, rid: string): { limit: number } | Response {
  const raw = url.searchParams.get("limit");
  if (!raw) return { limit: 50 };
  if (!/^[1-9]\d*$/.test(raw)) return fieldError("limit", "must be a positive integer", rid);
  return { limit: Math.min(Number(raw), 100) };
}

export async function handle(request: Request, env: FrontEnv, deps: Deps): Promise<Response> {
  const rid = requestIdOf(request);
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return errorResponse(400, "VALIDATION_ERROR", "invalid url", rid);
  }
  const path = url.pathname;
  if (request.method === "OPTIONS") {
    try {
      return withCors(request, preflight(request));
    } catch {
      return errorResponse(500, "INTERNAL", "internal error", rid);
    }
  }
  try {
    const response = await route(request, env, deps, url, path, rid);
    return withCors(request, response);
  } catch {
    try {
      return withCors(request, errorResponse(500, "INTERNAL", "internal error", rid));
    } catch {
      return errorResponse(500, "INTERNAL", "internal error", rid);
    }
  }
}

function preflight(request: Request): Response {
  const headers = corsHeaders(request);
  const requested = (request.headers.get("access-control-request-headers") || "")
    .split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  const allowHeaders = requested.filter((h) => ALLOWED_HEADERS.has(h));
  headers.set("access-control-allow-methods", "GET, POST, PATCH, PUT, DELETE, OPTIONS");
  headers.set("access-control-allow-headers", allowHeaders.join(", ") || "Authorization, Content-Type");
  headers.set("access-control-max-age", "600");
  const body = "OK";
  headers.set("content-type", "text/plain; charset=utf-8");
  headers.set("content-length", String(body.length));
  return new Response(body, { status: 200, headers });
}

async function route(request: Request, env: FrontEnv, deps: Deps, url: URL, path: string, rid: string): Promise<Response> {
  const now = deps.now ?? (() => new Date());
  const limits = deps.limits ?? { user: 600, public: 60, windowMs: 60_000 };
  if (request.method === "GET" && (path === "/healthz" || path === "/api/v1/healthz")) {
    if (path === "/api/v1/healthz" && !await allowShared(
      deps, "ip", clientIp(request), limits.public, limits.windowMs, now(),
    )) {
      return errorResponse(429, "RATE_LIMITED", "too many requests", rid);
    }
    return jsonResponse(200, { data: { status: "ok" } }, rid);
  }
  if (request.method === "GET" && path === "/api/v1/auth/me") {
    return authMe(request, env, deps, rid, limits, now);
  }
  if (request.method === "GET" && path === "/api/v1/conversations") {
    return listConversations(request, env, deps, url, rid, limits, now);
  }
  const messages = path.match(/^\/api\/v1\/conversations\/([^/]+)\/messages$/);
  if (request.method === "GET" && messages) {
    return listMessages(request, env, deps, url, messages[1], rid, limits, now);
  }
  const active = path.match(/^\/api\/v1\/conversations\/([^/]+)\/messages\/stream\/active$/);
  if (request.method === "GET" && active) {
    return streamActive(request, env, deps, url, active[1], rid, limits, now);
  }
  if (request.method === "GET" && path === "/api/v1/ai/models") {
    return aiModels(request, env, deps, url, rid, limits, now);
  }
  if (request.method === "GET" && path === "/api/v1/integrations/job-sites") {
    return jobSites(request, env, deps, rid, limits, now);
  }
  const proxied = await proxy(request, env, rid);
  if (proxied.status >= 200 && proxied.status < 300) {
    const method = request.method;
    if (method === "POST" || method === "PATCH" || method === "PUT" || method === "DELETE") {
      await invalidateAfterWrite(request, path, deps);
    }
  }
  if (request.method === "PUT" || request.method === "DELETE") {
    if (/^\/api\/v1\/ai\/keys\/[^/]+$/.test(path) && proxied.status >= 200 && proxied.status < 300) {
      await purgeModelCache(request, deps);
    }
  }
  return proxied;
}

async function proxy(request: Request, env: FrontEnv, rid: string): Promise<Response> {
  if (!env.API) return errorResponse(500, "INTERNAL", "internal error", rid);
  const headers = new Headers(request.headers);
  headers.set("x-request-id", rid);
  const init: RequestInit = { method: request.method, headers, redirect: "manual" };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = await request.arrayBuffer();
  }
  const forwarded = new Request(request.url, init);
  let res: Response;
  try {
    res = await env.API.fetch(forwarded);
  } catch {
    return errorResponse(500, "INTERNAL", "internal error", rid);
  }
  const out = new Headers(res.headers);
  if (!out.has("x-request-id")) out.set("x-request-id", rid);
  if (res.status === 204 || res.status === 205 || res.status === 304) {
    return new Response(null, { status: res.status, headers: out });
  }
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out });
}

function windowOf(moment: Date): number {
  return Math.floor(moment.getTime() / 1000 / 60);
}

function rateParams(hash: string, moment: Date, limit: number, batch: number, release: number): unknown[] {
  const window = windowOf(moment);
  const size = Math.max(1, Math.min(MAX_LEASE, batch));
  return [
    hash, String(window), window * 60 + 120, readCap(limit), moment.getTime() / 1000,
    size, Math.max(0, release),
  ];
}

function rememberAuth(hash: string, user: User, expiresAtMs: number, nowMs: number, ttlMs: number): void {
  if (!hash || ttlMs <= 0) return;
  const cached: CachedUser = {
    id: user.id,
    displayName: user.displayName,
    locale: user.locale,
    createdAt: user.createdAt,
    expiresAtMs,
  };
  isolate.putAuth(hash, cached, nowMs, ttlMs);
}

function interpretAuth(
  rows: Record<string, unknown>[],
  moment: Date,
  limit: number,
  windowMs: number,
  cacheKey: string,
  shared: boolean,
  rid: string,
  deps: Deps,
  remember?: { hash: string; ttlMs: number },
): User | Response {
  if (!rows.length) return errorResponse(401, "UNAUTHENTICATED", "invalid access token", rid);
  const row = rows[0];
  const expires = new Date(formatJsonTimestamp(row.expires_at)).getTime();
  if (moment.getTime() > expires) {
    return errorResponse(401, "TOKEN_EXPIRED", "access token expired", rid);
  }
  const user = userFrom(row);
  if (!shared) {
    if (!allow(`user:${user.id}:${windowOf(moment)}`, limit, windowMs, moment.getTime())) {
      return errorResponse(429, "RATE_LIMITED", "too many requests", rid);
    }
    return user;
  }
  if (!Object.prototype.hasOwnProperty.call(row, "hits")) return user;
  const cap = readCap(limit);
  if (!acceptGrant(cacheKey, row, cap, moment.getTime(), `user:${user.id}:${windowOf(moment)}`, deps)) {
    return errorResponse(429, "RATE_LIMITED", "too many requests", rid);
  }
  if (remember) rememberAuth(remember.hash, user, expires, moment.getTime(), remember.ttlMs);
  return user;
}

// The current request spends one granted hit. The rest stay in this isolate
// until they are used or the lease expires. A grant of 0 closes the bucket.
function acceptGrant(
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
  const left = granted - 1;
  const lease: Lease = {
    remaining: Math.max(0, left),
    size: granted,
    expiresAt: nowMs + LEASE_TTL_MS,
    spent: left <= 0,
    bucket,
    generation: ++leaseSeq,
    hits: Number(hitsValue),
    cap: limit,
  };
  leases.set(cacheKey, lease);
  if (left > 0) armRelease(deps, cacheKey, lease.generation);
  if (Number(hitsValue) >= limit && left <= 0) remoteHits.set(cacheKey, limit);
  return true;
}

function spendLease(cacheKey: string, nowMs: number, deps: Deps): void {
  const lease = leases.get(cacheKey);
  if (!lease || lease.remaining <= 0) return;
  lease.remaining -= 1;
  lease.expiresAt = nowMs + LEASE_TTL_MS;
  lease.generation = ++leaseSeq;
  if (lease.remaining === 0) {
    lease.spent = true;
    return;
  }
  armRelease(deps, cacheKey, lease.generation);
}

function userFromCached(cached: CachedUser): User {
  return {
    id: cached.id,
    displayName: cached.displayName,
    locale: cached.locale,
    createdAt: cached.createdAt,
  };
}

function jsonRows(value: unknown): Record<string, unknown>[] {
  let raw = value;
  if (typeof raw === "string") {
    try { raw = JSON.parse(raw); } catch { return []; }
  }
  if (!Array.isArray(raw)) return [];
  return raw.filter((item) => item && typeof item === "object") as Record<string, unknown>[];
}

type TokenCtx = {
  dev: boolean;
  hash: string;
  moment: Date;
  cacheKey: string;
  user?: User;
  // A lease is left, but the auth entry is missing or expired. Re-read the
  // token without claiming another batch.
  revalidate?: boolean;
  batch: number;
  release: number;
};

function nextBatch(lease: Lease | undefined, nowMs: number, release: number): number {
  if (!lease || release > 0) return 1;
  if (lease.spent && lease.remaining <= 0 && nowMs < lease.expiresAt) {
    return Math.min(MAX_LEASE, Math.max(1, lease.size) * 2);
  }
  return 1;
}

async function tokenContext(request: Request, env: FrontEnv, deps: Deps, rid: string, limits: { user: number }, now: () => Date): Promise<TokenCtx | Response> {
  const authz = request.headers.get("authorization") || "";
  if (!authz.startsWith("Bearer ")) {
    return errorResponse(401, "UNAUTHENTICATED", "missing bearer token", rid);
  }
  const token = authz.slice(7);
  const moment = now();
  if (env.APP_ENV === "development" && env.DEV_AUTH_TOKEN && token === env.DEV_AUTH_TOKEN) {
    return { dev: true, hash: "", moment, cacheKey: "", batch: 1, release: 0 };
  }
  let hash: string;
  try {
    hash = await sha256Hex(token);
  } catch {
    return errorResponse(500, "INTERNAL", "internal error", rid);
  }
  const cacheKey = `user:${hash}:${windowOf(moment)}`;
  await releaseExpired(deps, moment.getTime(), cacheKey);
  const lease = leases.get(cacheKey);
  const expired = !!lease && moment.getTime() >= lease.expiresAt;
  let release = 0;
  if (expired && lease) {
    release = lease.remaining;
    lease.remaining = 0;
    lease.spent = false;
  }
  const leaseLeft = !expired && lease ? lease.remaining : 0;
  const known = remoteHits.get(cacheKey);
  const cap = readCap(limits.user);
  if (known !== undefined && known >= cap && leaseLeft <= 0 && release <= 0) {
    return errorResponse(429, "RATE_LIMITED", "too many requests", rid);
  }
  const cached = isolate.getAuth(hash, moment.getTime());
  if (cached && leaseLeft > 0) {
    if (moment.getTime() > cached.expiresAtMs) {
      isolate.dropAuth(hash);
      return errorResponse(401, "TOKEN_EXPIRED", "access token expired", rid);
    }
    spendLease(cacheKey, moment.getTime(), deps);
    return { dev: false, hash, moment, cacheKey, user: userFromCached(cached), batch: 1, release: 0 };
  }
  if (leaseLeft > 0) {
    return { dev: false, hash, moment, cacheKey, revalidate: true, batch: 1, release: 0 };
  }
  return {
    dev: false, hash, moment, cacheKey,
    batch: nextBatch(lease, moment.getTime(), release),
    release,
  };
}

async function revalidateAuth(ctx: TokenCtx, env: FrontEnv, deps: Deps, rid: string): Promise<User | Response> {
  let rows: Record<string, unknown>[];
  try {
    rows = await deps.query(AUTH_SQL, [ctx.hash]);
  } catch {
    return errorResponse(500, "INTERNAL", "internal error", rid);
  }
  if (!rows.length) {
    leases.delete(ctx.cacheKey);
    isolate.dropAuth(ctx.hash);
    return errorResponse(401, "UNAUTHENTICATED", "invalid access token", rid);
  }
  const row = rows[0];
  const expires = new Date(formatJsonTimestamp(row.expires_at)).getTime();
  if (ctx.moment.getTime() > expires) {
    leases.delete(ctx.cacheKey);
    isolate.dropAuth(ctx.hash);
    return errorResponse(401, "TOKEN_EXPIRED", "access token expired", rid);
  }
  const user = userFrom(row);
  spendLease(ctx.cacheKey, ctx.moment.getTime(), deps);
  rememberAuth(ctx.hash, user, expires, ctx.moment.getTime(), authTtlMs(env));
  return user;
}

function rememberBag(ctx: TokenCtx, env: FrontEnv): { hash: string; ttlMs: number } {
  return { hash: ctx.hash, ttlMs: authTtlMs(env) };
}

async function requireUser(request: Request, env: FrontEnv, deps: Deps, rid: string, limits: { user: number; windowMs: number }, now: () => Date): Promise<User | Response> {
  const ctx = await tokenContext(request, env, deps, rid, limits, now);
  if (ctx instanceof Response) return ctx;
  if (ctx.user) return ctx.user;
  if (ctx.revalidate) return revalidateAuth(ctx, env, deps, rid);
  if (ctx.dev) {
    try {
      const resolved = await resolveDevUser(env, deps);
      if (!resolved) return errorResponse(401, "UNAUTHENTICATED", "invalid access token", rid);
      if (!await allowShared(deps, "user", resolved.id, limits.user, limits.windowMs, ctx.moment)) {
        return errorResponse(429, "RATE_LIMITED", "too many requests", rid);
      }
      return resolved;
    } catch (err) {
      return codedError(err, rid);
    }
  }
  // The local key is the token hash; the Neon bucket is the user id.
  // After this isolate has seen a full bucket, the rest of the minute
  // is rejected without another upsert (and without re-reading the token).
  let rows: Record<string, unknown>[];
  let shared = true;
  try {
    rows = await deps.query(AUTH_RATE_SQL, rateParams(ctx.hash, ctx.moment, limits.user, ctx.batch, ctx.release));
  } catch {
    shared = false;
    try {
      rows = await deps.query(AUTH_SQL, [ctx.hash]);
    } catch {
      return errorResponse(500, "INTERNAL", "internal error", rid);
    }
  }
  return interpretAuth(rows, ctx.moment, limits.user, limits.windowMs, ctx.cacheKey, shared, rid, deps, rememberBag(ctx, env));
}

function codedError(err: unknown, rid: string): Response {
  const coded = err as { status?: number; code?: string; message?: string };
  if (coded.status && coded.code) {
    return errorResponse(coded.status, coded.code, coded.message || "internal error", rid);
  }
  return errorResponse(500, "INTERNAL", "internal error", rid);
}

async function resolveDevUser(env: FrontEnv, deps: Deps): Promise<User | null> {
  const rows = await deps.query(
    "SELECT id, display_name, locale, " + tsText("created_at") + " AS created_at FROM users WHERE id = $1::uuid",
    [env.DEV_USER_ID || ""],
  );
  if (!rows.length) {
    throw Object.assign(new Error("dev user not seeded"), { status: 401, code: "UNAUTHENTICATED" });
  }
  return userFrom(rows[0]);
}

function userFrom(row: Record<string, unknown>): User {
  return {
    id: String(row.id),
    displayName: String(row.display_name ?? ""),
    locale: String(row.locale ?? "ko"),
    createdAt: formatJsonTimestamp(row.created_at),
  };
}

async function authMe(request: Request, env: FrontEnv, deps: Deps, rid: string, limits: { user: number; public: number; windowMs: number }, now: () => Date): Promise<Response> {
  const user = await requireUser(request, env, deps, rid, limits, now);
  if (user instanceof Response) return user;
  const text = pyJson({
    data: {
      id: user.id, displayName: user.displayName,
      locale: user.locale, createdAt: user.createdAt,
    },
  });
  return conditional(text, request, rid, USER_CACHE_CONTROL);
}

function cursorPair(url: URL, rid: string): { at: string | null; id: string | null } | Response {
  const cur = url.searchParams.get("cursor");
  if (!cur) return { at: null, id: null };
  try {
    const decoded = decodeCursor(cur);
    const id = parseUuid(decoded.id);
    if (!id) throw new Error("bad cursor");
    return { at: decoded.createdAt, id };
  } catch {
    return fieldError("cursor", "invalid cursor", rid);
  }
}

async function listConversationsFor(deps: Deps, userId: string, appId: string | null, cursor: { at: string | null; id: string | null }, limit: number, rid: string): Promise<Response> {
  let cursorSql = "";
  const params: unknown[] = [userId];
  if (appId) {
    params.push(appId);
    cursorSql += ` AND application_id = $${params.length}::uuid`;
  }
  if (cursor.at && cursor.id) {
    params.push(cursor.at, cursor.id);
    cursorSql += ` AND (created_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
  }
  params.push(limit + 1);
  const rows = await deps.query(
    "SELECT id, revision, application_id, title, pinned, "
    + tsText("created_at") + " AS created_at, " + tsText("updated_at") + " AS updated_at "
    + "FROM conversations WHERE user_id = $1::uuid AND archived = false" +
    cursorSql +
    ` ORDER BY created_at DESC, id DESC LIMIT $${params.length}`,
    params,
  );
  return jsonResponse(200, pageBody(rows, limit, conversationJson), rid);
}

async function listConversations(request: Request, env: FrontEnv, deps: Deps, url: URL, rid: string, limits: { user: number; public: number; windowMs: number }, now: () => Date): Promise<Response> {
  const page = pageLimit(url, rid);
  if (page instanceof Response) return page;
  const appRaw = url.searchParams.get("applicationId") || "";
  let appId: string | null = null;
  if (appRaw) {
    appId = parseUuid(appRaw);
    if (!appId) return fieldError("applicationId", "must be a UUID", rid);
  }
  const cursor = cursorPair(url, rid);
  if (cursor instanceof Response) return cursor;
  const ctx = await tokenContext(request, env, deps, rid, limits, now);
  if (ctx instanceof Response) return ctx;
  if (ctx.user || ctx.revalidate) {
    const user = ctx.user ?? await revalidateAuth(ctx, env, deps, rid);
    if (user instanceof Response) return user;
    try {
      return await freshRead(
        await listConversationsFor(deps, user.id, appId, cursor, page.limit, rid),
        request, rid);
    } catch {
      return errorResponse(500, "INTERNAL", "internal error", rid);
    }
  }
  if (ctx.dev) {
    const user = await requireUser(request, env, deps, rid, limits, now);
    if (user instanceof Response) return user;
    try {
      return await listConversationsFor(deps, user.id, appId, cursor, page.limit, rid);
    } catch {
      return errorResponse(500, "INTERNAL", "internal error", rid);
    }
  }
  try {
    const rows = await deps.query(LIST_SQL, [
      ...rateParams(ctx.hash, ctx.moment, limits.user, ctx.batch, ctx.release),
      appId, cursor.at, cursor.id, page.limit + 1,
    ]);
    const user = interpretAuth(rows, ctx.moment, limits.user, limits.windowMs, ctx.cacheKey, true, rid, deps, rememberBag(ctx, env));
    if (user instanceof Response) return user;
    const text = pyJson(pageBody(jsonRows(rows[0]?.rows), page.limit, conversationJson));
    return conditional(text, request, rid, USER_CACHE_CONTROL);
  } catch {
    const user = await requireUser(request, env, deps, rid, limits, now);
    if (user instanceof Response) return user;
    try {
      return await listConversationsFor(deps, user.id, appId, cursor, page.limit, rid);
    } catch {
      return errorResponse(500, "INTERNAL", "internal error", rid);
    }
  }
}

function conversationJson(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: String(row.id),
    revision: Number(row.revision),
    applicationId: row.application_id == null ? null : String(row.application_id),
    title: String(row.title ?? ""),
    pinned: asBool(row.pinned),
    createdAt: formatJsonTimestamp(row.created_at),
    updatedAt: formatJsonTimestamp(row.updated_at),
  };
}

async function listMessagesFor(deps: Deps, userId: string, id: string, cursor: { at: string | null; id: string | null }, limit: number, rid: string): Promise<Response> {
  const found = await deps.query(
    "SELECT id FROM conversations WHERE id = $1::uuid AND user_id = $2::uuid",
    [id, userId],
  );
  if (!found.length) return errorResponse(404, "NOT_FOUND", "resource not found", rid);
  const params: unknown[] = [userId, id];
  let cursorSql = "";
  if (cursor.at && cursor.id) {
    params.push(cursor.at, cursor.id);
    cursorSql = ` AND (created_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
  }
  params.push(limit + 1);
  const rows = await deps.query(
    "SELECT id, conversation_id, role, text, attachments, operation_id, "
    + tsText("created_at") + " AS created_at "
    + "FROM messages WHERE user_id = $1::uuid AND conversation_id = $2::uuid" +
    cursorSql +
    ` ORDER BY created_at DESC, id DESC LIMIT $${params.length}`,
    params,
  );
  return jsonResponse(200, pageBody(rows, limit, messageJson), rid);
}

async function listMessages(request: Request, env: FrontEnv, deps: Deps, url: URL, rawId: string, rid: string, limits: { user: number; public: number; windowMs: number }, now: () => Date): Promise<Response> {
  const id = parseUuid(rawId);
  if (!id) return fieldError("id", "must be a UUID", rid);
  const page = pageLimit(url, rid);
  if (page instanceof Response) return page;
  const cursor = cursorPair(url, rid);
  if (cursor instanceof Response) return cursor;
  const ctx = await tokenContext(request, env, deps, rid, limits, now);
  if (ctx instanceof Response) return ctx;
  if (ctx.user || ctx.revalidate) {
    const user = ctx.user ?? await revalidateAuth(ctx, env, deps, rid);
    if (user instanceof Response) return user;
    try {
      return await freshRead(
        await listMessagesFor(deps, user.id, id, cursor, page.limit, rid),
        request, rid);
    } catch {
      return errorResponse(500, "INTERNAL", "internal error", rid);
    }
  }
  if (ctx.dev) {
    const user = await requireUser(request, env, deps, rid, limits, now);
    if (user instanceof Response) return user;
    try {
      return await listMessagesFor(deps, user.id, id, cursor, page.limit, rid);
    } catch {
      return errorResponse(500, "INTERNAL", "internal error", rid);
    }
  }
  try {
    const rows = await deps.query(MESSAGES_SQL, [
      ...rateParams(ctx.hash, ctx.moment, limits.user, ctx.batch, ctx.release),
      id, cursor.at, cursor.id, page.limit + 1,
    ]);
    const user = interpretAuth(rows, ctx.moment, limits.user, limits.windowMs, ctx.cacheKey, true, rid, deps, rememberBag(ctx, env));
    if (user instanceof Response) return user;
    const conversationId = rows[0]?.conversation_id;
    if (conversationId == null || conversationId === "") {
      return errorResponse(404, "NOT_FOUND", "resource not found", rid);
    }
    const text = pyJson(pageBody(jsonRows(rows[0]?.rows), page.limit, messageJson));
    return conditional(text, request, rid, USER_CACHE_CONTROL);
  } catch {
    const user = await requireUser(request, env, deps, rid, limits, now);
    if (user instanceof Response) return user;
    try {
      return await listMessagesFor(deps, user.id, id, cursor, page.limit, rid);
    } catch {
      return errorResponse(500, "INTERNAL", "internal error", rid);
    }
  }
}

function messageJson(row: Record<string, unknown>): Record<string, unknown> {
  let attachments = row.attachments ?? [];
  if (typeof attachments === "string") {
    try { attachments = JSON.parse(attachments); } catch { attachments = []; }
  }
  const cleaned = Array.isArray(attachments) ? attachments.map(attachmentJson) : [];
  return {
    id: String(row.id),
    conversationId: String(row.conversation_id),
    role: String(row.role),
    text: String(row.text ?? ""),
    attachments: cleaned,
    operationId: row.operation_id == null ? null : String(row.operation_id),
    createdAt: formatJsonTimestamp(row.created_at),
  };
}

function attachmentJson(raw: unknown): Record<string, unknown> {
  const a = (raw && typeof raw === "object") ? raw as Record<string, unknown> : {};
  const out: Record<string, unknown> = { type: String(a.type ?? ""), id: String(a.id ?? "") };
  if (a.documentId != null) out.documentId = String(a.documentId);
  if (a.title != null) out.title = String(a.title);
  return out;
}

function pageBody(rows: Record<string, unknown>[], limit: number, map: (row: Record<string, unknown>) => Record<string, unknown>): Record<string, unknown> {
  const more = rows.length > limit;
  const items = (more ? rows.slice(0, limit) : rows).map(map);
  let nextCursor: string | null = null;
  if (more && items.length) {
    const last = items[items.length - 1];
    const created = String(last.createdAt);
    const id = String(last.id);
    nextCursor = encodeCursor(created, id);
  }
  return { data: items, page: { nextCursor, hasMore: more } };
}

async function activeJobFor(deps: Deps, userId: string, id: string): Promise<string | null | Response> {
  const found = await deps.query(
    "SELECT id FROM conversations WHERE id = $1::uuid AND user_id = $2::uuid",
    [id, userId],
  );
  if (!found.length) return errorResponse(404, "NOT_FOUND", "resource not found", "");
  const jobs = await deps.query(
    "SELECT id FROM chat_jobs WHERE user_id = $1::uuid AND conversation_id = $2::uuid " +
    "AND status IN ('PENDING', 'RUNNING') ORDER BY created_at DESC LIMIT 1",
    [userId, id],
  );
  return jobs.length ? String(jobs[0].id) : null;
}

async function streamActive(request: Request, env: FrontEnv, deps: Deps, url: URL, rawId: string, rid: string, limits: { user: number; public: number; windowMs: number }, now: () => Date): Promise<Response> {
  const id = parseUuid(rawId);
  if (!id) return fieldError("id", "must be a UUID", rid);
  const ctx = await tokenContext(request, env, deps, rid, limits, now);
  if (ctx instanceof Response) return ctx;
  let jobId: string | null;
  try {
    if (ctx.user || ctx.revalidate) {
      const user = ctx.user ?? await revalidateAuth(ctx, env, deps, rid);
      if (user instanceof Response) return user;
      const found = await activeJobFor(deps, user.id, id);
      if (found instanceof Response) {
        return errorResponse(found.status, "NOT_FOUND", "resource not found", rid);
      }
      jobId = found;
    } else if (ctx.dev) {
      const user = await requireUser(request, env, deps, rid, limits, now);
      if (user instanceof Response) return user;
      const found = await activeJobFor(deps, user.id, id);
      if (found instanceof Response) {
        return errorResponse(found.status, "NOT_FOUND", "resource not found", rid);
      }
      jobId = found;
    } else {
      const rows = await deps.query(STREAM_SQL, [
        ...rateParams(ctx.hash, ctx.moment, limits.user, ctx.batch, ctx.release), id,
      ]);
      const user = interpretAuth(rows, ctx.moment, limits.user, limits.windowMs, ctx.cacheKey, true, rid, deps, rememberBag(ctx, env));
      if (user instanceof Response) return user;
      const conversationId = rows[0]?.conversation_id;
      if (conversationId == null || conversationId === "") {
        return errorResponse(404, "NOT_FOUND", "resource not found", rid);
      }
      const rawJob = rows[0]?.job_id;
      jobId = rawJob == null || rawJob === "" ? null : String(rawJob);
    }
  } catch {
    if (ctx.user || ctx.revalidate) return errorResponse(500, "INTERNAL", "internal error", rid);
    try {
      const user = await requireUser(request, env, deps, rid, limits, now);
      if (user instanceof Response) return user;
      const found = await activeJobFor(deps, user.id, id);
      if (found instanceof Response) {
        return errorResponse(found.status, "NOT_FOUND", "resource not found", rid);
      }
      jobId = found;
    } catch {
      return errorResponse(500, "INTERNAL", "internal error", rid);
    }
  }
  if (!jobId) return new Response(null, { status: 204, headers: { "x-request-id": rid } });
  const afterRaw = url.searchParams.get("after") || request.headers.get("last-event-id") || "";
  let after = /^[0-9]+$/.test(afterRaw) ? Number(afterRaw) : 0;
  const polls = Math.max(1, Number(env.SSE_MAX_POLLS || "20") || 20);
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const encoder = new TextEncoder();
  let open = true;
  const stream = new ReadableStream({
    async start(controller) {
      const send = (frame: string) => {
        if (!open) return;
        try { controller.enqueue(encoder.encode(frame)); }
        catch { open = false; }
      };
      send("retry: 400\n\n");
      try {
        for (let i = 0; i < polls; i++) {
          if (!open) break;
          const rows = await deps.query(
            "SELECT id, type, payload FROM chat_events WHERE job_id = $1::uuid AND id > $2 ORDER BY id",
            [jobId, after],
          );
          let terminal = false;
          for (const row of rows) {
            after = Number(row.id);
            send(sseFrame(row));
            if (row.type === "done" || row.type === "error") {
              terminal = true;
              break;
            }
          }
          if (terminal) break;
          if (i + 1 < polls) await sleep(250);
        }
      } catch {
        send("data: " + pyJson({
          type: "error",
          error: { code: "INTERNAL", message: "internal error", details: null },
        }) + "\n\n");
      }
      try { controller.close(); }
      catch { /* the client already hung up */ }
    },
    cancel() { open = false; },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "x-accel-buffering": "no",
      "x-request-id": rid,
    },
  });
}

function sseFrame(row: Record<string, unknown>): string {
  const seq = Number(row.id);
  let payload = row.payload ?? {};
  if (typeof payload === "string") {
    try { payload = JSON.parse(payload); } catch { payload = {}; }
  }
  const p = (payload && typeof payload === "object") ? payload as Record<string, unknown> : {};
  let body: Record<string, unknown>;
  if (row.type === "token") body = { type: "token", text: String(p.text ?? "") };
  else if (row.type === "status") body = { type: "status", text: String(p.text ?? "") };
  else if (row.type === "error") body = { type: "error", error: p.error ?? {} };
  else body = { type: "done", operation: p.operation ?? null };
  body.seq = seq;
  return `id: ${seq}\ndata: ${pyJson(body)}\n\n`;
}

async function aiModels(request: Request, env: FrontEnv, deps: Deps, url: URL, rid: string, limits: { user: number; public: number; windowMs: number }, now: () => Date): Promise<Response> {
  const provider = url.searchParams.get("provider") || "";
  const credMode = url.searchParams.get("credentialMode") || "";
  const ctx = await tokenContext(request, env, deps, rid, limits, now);
  if (ctx instanceof Response) return ctx;
  if (provider && !validProvider(provider)) return fieldError("provider", "unsupported provider", rid);
  if (credMode && !validCredentialMode(credMode)) return fieldError("credentialMode", "unsupported credentialMode", rid);
  if (credMode === "BYOK" && provider) {
    const user = ctx.user ?? await requireUser(request, env, deps, rid, limits, now);
    if (user instanceof Response) return user;
    const key = request.headers.get("x-byok-key") || "";
    if (!key) return jsonResponse(200, { data: [] }, rid);
    return proxy(request, env, rid);
  }
  const authHash = await sha256Hex((request.headers.get("authorization") || "").slice(7));
  const cache = cacheOf(deps);
  const ttl = Math.max(1, Number(env.MODEL_CACHE_TTL || "600") || 600);
  const cacheControl = `private, max-age=${ttl}`;
  const cacheReq = new Request(modelCacheUrl(authHash, provider, credMode));
  const hit = await cache.match(cacheReq);
  if (hit) {
    const user = ctx.user ?? await requireUser(request, env, deps, rid, limits, now);
    if (user instanceof Response) return user;
    return conditional(await hit.text(), request, rid, cacheControl);
  }
  let byokOpenai = false;
  if (credMode === "MANAGED" || ctx.dev) {
    const user = ctx.user ?? await requireUser(request, env, deps, rid, limits, now);
    if (user instanceof Response) return user;
    if (ctx.dev && credMode !== "MANAGED") {
      try {
        byokOpenai = await openaiKey(deps, user.id);
      } catch {
        return errorResponse(500, "INTERNAL", "internal error", rid);
      }
    }
  } else if (ctx.user || ctx.revalidate) {
    const user = ctx.user ?? await revalidateAuth(ctx, env, deps, rid);
    if (user instanceof Response) return user;
    try {
      byokOpenai = await openaiKey(deps, user.id);
    } catch {
      return errorResponse(500, "INTERNAL", "internal error", rid);
    }
  } else {
    try {
      const rows = await deps.query(MODELS_SQL, rateParams(ctx.hash, ctx.moment, limits.user, ctx.batch, ctx.release));
      const authed = interpretAuth(rows, ctx.moment, limits.user, limits.windowMs, ctx.cacheKey, true, rid, deps, rememberBag(ctx, env));
      if (authed instanceof Response) return authed;
      byokOpenai = asBool(rows[0]?.has);
    } catch {
      const user = await requireUser(request, env, deps, rid, limits, now);
      if (user instanceof Response) return user;
      try {
        byokOpenai = await openaiKey(deps, user.id);
      } catch {
        return errorResponse(500, "INTERNAL", "internal error", rid);
      }
    }
  }
  const body = {
    data: listModels({
      provider, credMode,
      managedAi: flag(env.MANAGED_AI),
      managedGo: flag(env.MANAGED_GO),
      byokOpenai,
    }),
  };
  const text = pyJson(body);
  await putCache(cache, cacheReq, new Response(text, {
    headers: { "content-type": "application/json", "cache-control": cacheControl },
  }));
  return conditional(text, request, rid, cacheControl);
}

async function openaiKey(deps: Deps, userId: string): Promise<boolean> {
  const rows = await deps.query(
    "SELECT EXISTS(SELECT 1 FROM ai_keys WHERE user_id = $1::uuid AND provider = 'OPENAI') AS has",
    [userId],
  );
  return asBool(rows[0]?.has);
}

async function jobSites(request: Request, env: FrontEnv, deps: Deps, rid: string, limits: { user: number; public: number; windowMs: number }, now: () => Date): Promise<Response> {
  const user = await requireUser(request, env, deps, rid, limits, now);
  if (user instanceof Response) return user;
  const cache = cacheOf(deps);
  const ttl = Math.max(1, Number(env.JOB_SITES_CACHE_TTL || "3600") || 3600);
  const cacheReq = new Request(JOB_SITES_CACHE_URL);
  const hit = await cache.match(cacheReq);
  let text: string;
  if (hit) text = await hit.text();
  else {
    text = pyJson(jobSitesBody());
    await putCache(cache, cacheReq, new Response(text, {
      headers: { "content-type": "application/json", "cache-control": `public, max-age=${ttl}` },
    }));
  }
  return conditional(text, request, rid, `public, max-age=${ttl}`);
}

function cacheOf(deps: Deps): CacheStore {
  return deps.cache ?? workersCache() ?? memoryCache();
}

async function putCache(cache: CacheStore, req: Request, res: Response): Promise<void> {
  try {
    await cache.put(req, res);
  } catch {
    // A cache failure must not become an uncaught Worker exception or a 500.
  }
}

async function purgeModelCache(request: Request, deps: Deps): Promise<void> {
  try {
    const token = (request.headers.get("authorization") || "").replace(/^Bearer /, "");
    if (!token) return;
    const cache = cacheOf(deps);
    const hash = await sha256Hex(token);
    await Promise.all(modelCacheUrls(hash).map((url) => cache.delete(new Request(url))));
  } catch {
    // Invalidation is best-effort. The TTL still expires the entry.
  }
}
