/**
 * TypeScript front Worker.
 *
 * Handles the requests that were spending a Neon WebSocket handshake and
 * ~300ms of Python CPU: health, auth/me, conversation reads, SSE replay,
 * and the static model / job-site catalogs. Everything else is forwarded
 * to the Python worker through a service binding.
 */

import { memoryCache, modelCacheUrl, modelCacheUrls, workersCache, JOB_SITES_CACHE_URL, type CacheStore } from "./cache.ts";
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
}

export interface Deps {
  query: Query;
  cache?: CacheStore;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  limits?: { user: number; public: number; windowMs: number };
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

export function resetLimits(): void {
  hits.clear();
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
  const headers = new Headers(response.headers);
  for (const [k, v] of corsHeaders(request)) {
    if (!headers.has(k)) headers.set(k, v);
  }
  return new Response(response.body, { status: response.status, headers });
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
  const url = new URL(request.url);
  const path = url.pathname;
  if (request.method === "OPTIONS") {
    return withCors(request, preflight(request));
  }
  try {
    const response = await route(request, env, deps, url, path, rid);
    return withCors(request, response);
  } catch {
    return withCors(request, errorResponse(500, "INTERNAL", "internal error", rid));
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
    if (path === "/api/v1/healthz" && !allow("pub:" + clientIp(request), limits.public, limits.windowMs, now().getTime())) {
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
  const res = await env.API.fetch(forwarded);
  const out = new Headers(res.headers);
  if (!out.has("x-request-id")) out.set("x-request-id", rid);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out });
}

async function requireUser(request: Request, env: FrontEnv, deps: Deps, rid: string, limits: { user: number; windowMs: number }, now: () => Date): Promise<User | Response> {
  const authz = request.headers.get("authorization") || "";
  if (!authz.startsWith("Bearer ")) {
    return errorResponse(401, "UNAUTHENTICATED", "missing bearer token", rid);
  }
  const token = authz.slice(7);
  let user: User;
  try {
    const resolved = await resolveUser(token, env, deps, now());
    if (!resolved) return errorResponse(401, "UNAUTHENTICATED", "invalid access token", rid);
    if (resolved.expired) return errorResponse(401, "TOKEN_EXPIRED", "access token expired", rid);
    user = resolved.user;
  } catch (err) {
    const coded = err as { status?: number; code?: string; message?: string };
    if (coded.status && coded.code) {
      return errorResponse(coded.status, coded.code, coded.message || "internal error", rid);
    }
    return errorResponse(500, "INTERNAL", "internal error", rid);
  }
  if (!allow("user:" + user.id, limits.user, limits.windowMs, now().getTime())) {
    return errorResponse(429, "RATE_LIMITED", "too many requests", rid);
  }
  return user;
}

async function resolveUser(token: string, env: FrontEnv, deps: Deps, now: Date): Promise<{ user: User; expired: boolean } | null> {
  if (env.APP_ENV === "development" && env.DEV_AUTH_TOKEN && token === env.DEV_AUTH_TOKEN) {
    const rows = await deps.query(
      "SELECT id, display_name, locale, created_at FROM users WHERE id = $1::uuid",
      [env.DEV_USER_ID || ""],
    );
    if (!rows.length) {
      throw Object.assign(new Error("dev user not seeded"), { status: 401, code: "UNAUTHENTICATED" });
    }
    return { user: userFrom(rows[0]), expired: false };
  }
  const hash = await sha256Hex(token);
  const rows = await deps.query(
    "SELECT u.id, u.display_name, u.locale, u.created_at, t.expires_at " +
    "FROM access_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = $1",
    [hash],
  );
  if (!rows.length) return null;
  const expires = new Date(formatJsonTimestamp(rows[0].expires_at)).getTime();
  return { user: userFrom(rows[0]), expired: now.getTime() > expires };
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
  return jsonResponse(200, {
    data: {
      id: user.id, displayName: user.displayName,
      locale: user.locale, createdAt: user.createdAt,
    },
  }, rid);
}

async function listConversations(request: Request, env: FrontEnv, deps: Deps, url: URL, rid: string, limits: { user: number; public: number; windowMs: number }, now: () => Date): Promise<Response> {
  const user = await requireUser(request, env, deps, rid, limits, now);
  if (user instanceof Response) return user;
  const page = pageLimit(url, rid);
  if (page instanceof Response) return page;
  const appRaw = url.searchParams.get("applicationId") || "";
  let appId: string | null = null;
  if (appRaw) {
    appId = parseUuid(appRaw);
    if (!appId) return fieldError("applicationId", "must be a UUID", rid);
  }
  let cursorSql = "";
  const params: unknown[] = [user.id];
  if (appId) {
    params.push(appId);
    cursorSql += ` AND application_id = $${params.length}::uuid`;
  }
  const cur = url.searchParams.get("cursor");
  if (cur) {
    try {
      const decoded = decodeCursor(cur);
      if (!parseUuid(decoded.id)) throw new Error("bad cursor");
      params.push(decoded.createdAt, decoded.id);
      cursorSql += ` AND (created_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
    } catch {
      return fieldError("cursor", "invalid cursor", rid);
    }
  }
  params.push(page.limit + 1);
  let rows: Record<string, unknown>[];
  try {
    rows = await deps.query(
      "SELECT id, revision, application_id, title, pinned, created_at, updated_at " +
      "FROM conversations WHERE user_id = $1::uuid AND archived = false" +
      cursorSql +
      ` ORDER BY created_at DESC, id DESC LIMIT $${params.length}`,
      params,
    );
  } catch {
    return errorResponse(500, "INTERNAL", "internal error", rid);
  }
  return jsonResponse(200, pageBody(rows, page.limit, conversationJson), rid);
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

async function listMessages(request: Request, env: FrontEnv, deps: Deps, url: URL, rawId: string, rid: string, limits: { user: number; public: number; windowMs: number }, now: () => Date): Promise<Response> {
  const user = await requireUser(request, env, deps, rid, limits, now);
  if (user instanceof Response) return user;
  const id = parseUuid(rawId);
  if (!id) return fieldError("id", "must be a UUID", rid);
  const page = pageLimit(url, rid);
  if (page instanceof Response) return page;
  try {
    const found = await deps.query(
      "SELECT id FROM conversations WHERE id = $1::uuid AND user_id = $2::uuid",
      [id, user.id],
    );
    if (!found.length) return errorResponse(404, "NOT_FOUND", "resource not found", rid);
    const params: unknown[] = [user.id, id];
    let cursorSql = "";
    const cur = url.searchParams.get("cursor");
    if (cur) {
      try {
        const decoded = decodeCursor(cur);
        if (!parseUuid(decoded.id)) throw new Error("bad cursor");
        params.push(decoded.createdAt, decoded.id);
        cursorSql = ` AND (created_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
      } catch {
        return fieldError("cursor", "invalid cursor", rid);
      }
    }
    params.push(page.limit + 1);
    const rows = await deps.query(
      "SELECT id, conversation_id, role, text, attachments, operation_id, created_at " +
      "FROM messages WHERE user_id = $1::uuid AND conversation_id = $2::uuid" +
      cursorSql +
      ` ORDER BY created_at DESC, id DESC LIMIT $${params.length}`,
      params,
    );
    return jsonResponse(200, pageBody(rows, page.limit, messageJson), rid);
  } catch {
    return errorResponse(500, "INTERNAL", "internal error", rid);
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

async function streamActive(request: Request, env: FrontEnv, deps: Deps, url: URL, rawId: string, rid: string, limits: { user: number; public: number; windowMs: number }, now: () => Date): Promise<Response> {
  const user = await requireUser(request, env, deps, rid, limits, now);
  if (user instanceof Response) return user;
  const id = parseUuid(rawId);
  if (!id) return fieldError("id", "must be a UUID", rid);
  let jobId: string | null;
  try {
    const found = await deps.query(
      "SELECT id FROM conversations WHERE id = $1::uuid AND user_id = $2::uuid",
      [id, user.id],
    );
    if (!found.length) return errorResponse(404, "NOT_FOUND", "resource not found", rid);
    const jobs = await deps.query(
      "SELECT id FROM chat_jobs WHERE user_id = $1::uuid AND conversation_id = $2::uuid " +
      "AND status IN ('PENDING', 'RUNNING') ORDER BY created_at DESC LIMIT 1",
      [user.id, id],
    );
    jobId = jobs.length ? String(jobs[0].id) : null;
  } catch {
    return errorResponse(500, "INTERNAL", "internal error", rid);
  }
  if (!jobId) return new Response(null, { status: 204, headers: { "x-request-id": rid } });
  const afterRaw = url.searchParams.get("after") || request.headers.get("last-event-id") || "";
  let after = /^[0-9]+$/.test(afterRaw) ? Number(afterRaw) : 0;
  const polls = Math.max(1, Number(env.SSE_MAX_POLLS || "20") || 20);
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (frame: string) => controller.enqueue(encoder.encode(frame));
      send("retry: 400\n\n");
      try {
        for (let i = 0; i < polls; i++) {
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
      controller.close();
    },
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
  const user = await requireUser(request, env, deps, rid, limits, now);
  if (user instanceof Response) return user;
  const provider = url.searchParams.get("provider") || "";
  const credMode = url.searchParams.get("credentialMode") || "";
  if (provider && !validProvider(provider)) return fieldError("provider", "unsupported provider", rid);
  if (credMode && !validCredentialMode(credMode)) return fieldError("credentialMode", "unsupported credentialMode", rid);
  if (credMode === "BYOK" && provider) {
    const key = request.headers.get("x-byok-key") || "";
    if (!key) return jsonResponse(200, { data: [] }, rid);
    return proxy(request, env, rid);
  }
  const authHash = await sha256Hex((request.headers.get("authorization") || "").slice(7));
  const cache = cacheOf(deps);
  const ttl = Math.max(1, Number(env.MODEL_CACHE_TTL || "600") || 600);
  const cacheReq = new Request(modelCacheUrl(authHash, provider, credMode));
  const hit = await cache.match(cacheReq);
  if (hit) {
    const text = await hit.text();
    return new Response(text, {
      status: 200,
      headers: {
        "content-type": "application/json",
        "content-length": String(new TextEncoder().encode(text).byteLength),
        "x-request-id": rid,
      },
    });
  }
  let byokOpenai = false;
  if (credMode !== "MANAGED") {
    try {
      const rows = await deps.query(
        "SELECT EXISTS(SELECT 1 FROM ai_keys WHERE user_id = $1::uuid AND provider = 'OPENAI') AS has",
        [user.id],
      );
      byokOpenai = asBool(rows[0]?.has);
    } catch {
      return errorResponse(500, "INTERNAL", "internal error", rid);
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
  await cache.put(cacheReq, new Response(text, {
    headers: { "content-type": "application/json", "cache-control": `public, max-age=${ttl}` },
  }));
  return new Response(text, {
    status: 200,
    headers: {
      "content-type": "application/json",
      "content-length": String(new TextEncoder().encode(text).byteLength),
      "x-request-id": rid,
    },
  });
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
    await cache.put(cacheReq, new Response(text, {
      headers: { "content-type": "application/json", "cache-control": `public, max-age=${ttl}` },
    }));
  }
  return new Response(text, {
    status: 200,
    headers: {
      "content-type": "application/json",
      "content-length": String(new TextEncoder().encode(text).byteLength),
      "x-request-id": rid,
    },
  });
}

function cacheOf(deps: Deps): CacheStore {
  return deps.cache ?? workersCache() ?? memoryCache();
}

async function purgeModelCache(request: Request, deps: Deps): Promise<void> {
  const token = (request.headers.get("authorization") || "").replace(/^Bearer /, "");
  if (!token) return;
  const cache = cacheOf(deps);
  const hash = await sha256Hex(token);
  await Promise.all(modelCacheUrls(hash).map((url) => cache.delete(new Request(url))));
}
