import { isUnique, one, query } from "./db.ts";
import { HttpError, clientIp, errorOf, errorResponse, parseUuid, requestIdOf } from "./http.ts";
import { allow } from "./ratelimit.ts";
import { deleteAccount, exchange, logout, me, oauthCallback, oauthStart, refresh, resolveUser } from "./routes/auth.ts";
import { dispatchEmailAuth } from "./routes/email-auth.ts";
import { appleWebhook, billingStatus, checkout, googleWebhook, ledger, portal, topup, verifyIap, webhook } from "./routes/billing.ts";
import { createEvent, deleteEvent, listEvents, patchEvent } from "./routes/calendar.ts";
import { archiveConversation, createConversation, patchConversation, postAttachment, postMessage } from "./routes/conversations.ts";
import { deleteKey, listKeys, listUsage, putKey, testKey } from "./routes/keys.ts";
import { createJob, getJob, listAnalyses, listJobs, patchJob } from "./routes/jobs.ts";
import { dispatchCompanies } from "./routes/companies.ts";
import { dispatchConsents } from "./routes/consents.ts";
import { dispatchRecruiting } from "./routes/recruiting.ts";
import type { CoreEnv, Ctx, Deps, UserRow } from "./types.ts";

const PUBLIC = new Set([
  "/api/v1/auth/exchange",
  "/api/v1/auth/refresh",
  "/api/v1/auth/logout",
  "/api/v1/billing/webhook",
  "/api/v1/billing/webhook/app-store",
  "/api/v1/billing/webhook/google-play",
]);
const EMAIL_PUBLIC = new Set([
  "/api/v1/auth/email/signup",
  "/api/v1/auth/email/verify",
  "/api/v1/auth/email/login",
  "/api/v1/auth/email/password-reset",
  "/api/v1/auth/email/password-reset/confirm",
]);
const PENDING_MS = 5 * 60 * 1000;
const GUEST_ID = "00000000-0000-0000-0000-000000000000";
const POSTING_UUID = /^\/api\/v1\/postings\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isGuestRead = (method: string, path: string): boolean => {
  if (method !== "GET") return false;
  return path === "/api/v1/postings"
    || path === "/api/v1/postings/locations"
    || path === "/api/v1/postings/facets"
    || path === "/api/v1/search"
    || POSTING_UUID.test(path);
};

const guestUser = (): UserRow => ({ ...anonymous(), id: GUEST_ID });

export type { CoreEnv, Deps };

export async function handle(request: Request, env: CoreEnv, deps: Deps): Promise<Response> {
  const rid = requestIdOf(request);
  let url: URL;
  try { url = new URL(request.url); } catch {
    return errorResponse(400, "VALIDATION_ERROR", "invalid url", rid);
  }
  const path = url.pathname;
  const now = (deps.now ?? (() => new Date()))();
  try {
    const authz = request.headers.get("authorization") || "";
    if (isPublic(request.method, path, authz)) {
      if (!(await allow(deps.query, "ip", clientIp(request), 60, now.getTime()))) {
        return errorResponse(429, "RATE_LIMITED", "too many requests", rid);
      }
      const user = isGuestRead(request.method, path) ? guestUser() : anonymous();
      const ctx = base(request, env, deps, rid, url, now, user);
      return await dispatch(ctx, path);
    }
    if (!authz.startsWith("Bearer ")) {
      return errorResponse(401, "UNAUTHENTICATED", "missing bearer token", rid);
    }
    const user = await resolveUser(base(request, env, deps, rid, url, now, anonymous()), authz.slice(7));
    if (!(await allow(deps.query, "user", user.id, 600, now.getTime()))) {
      return errorResponse(429, "RATE_LIMITED", "too many requests", rid);
    }
    const ctx = base(request, env, deps, rid, url, now, user);
    if (request.method !== "POST" || path.endsWith("/stream")) return await dispatch(ctx, path);
    return await idempotent(ctx, path);
  } catch (err) {
    if (err instanceof HttpError) return errorOf(err, rid);
    return errorResponse(500, "INTERNAL", "internal error", rid);
  }
}

function anonymous(): UserRow {
  return {
    id: "", displayName: "", locale: "ko", plan: "FREE", subscriptionStatus: "NONE",
    stripeCustomerId: null, periodEndsAt: null, createdAt: "",
    accountType: "PERSONAL", companyId: null, companyRole: null,
  };
}

function base(request: Request, env: CoreEnv, deps: Deps, rid: string, url: URL, now: Date, user: UserRow): Ctx {
  return { request, env, deps, rid, url, now, user };
}

function isPublic(method: string, path: string, authorization = ""): boolean {
  if (PUBLIC.has(path)) return true;
  if (method === "POST" && EMAIL_PUBLIC.has(path)) return true;
  if (method === "GET" && /^\/api\/v1\/auth\/[^/]+\/(start|callback)$/.test(path)) return true;
  return authorization === "" && isGuestRead(method, path);
}

async function dispatch(ctx: Ctx, path: string): Promise<Response> {
  const method = ctx.request.method;
  const authProvider = path.match(/^\/api\/v1\/auth\/([^/]+)\/(start|callback)$/);
  if (method === "GET" && authProvider?.[2] === "start") return oauthStart(ctx);
  if (method === "GET" && authProvider?.[2] === "callback") return oauthCallback(ctx);
  if (method === "POST" && path === "/api/v1/auth/exchange") return exchange(ctx);
  if (method === "POST" && path === "/api/v1/auth/refresh") return refresh(ctx);
  if (method === "POST" && path === "/api/v1/auth/logout") return logout(ctx);
  if (method === "GET" && path === "/api/v1/auth/me") return me(ctx);
  if (method === "DELETE" && path === "/api/v1/me") return deleteAccount(ctx);
  const emailed = await dispatchEmailAuth(ctx, path);
  if (emailed) return emailed;

  if (method === "POST" && path === "/api/v1/conversations") return createConversation(ctx);
  const conv = path.match(/^\/api\/v1\/conversations\/([^/]+)$/);
  if (method === "PATCH" && conv) return patchConversation(ctx, conv[1]);
  const archive = path.match(/^\/api\/v1\/conversations\/([^/]+)\/archive$/);
  if (method === "POST" && archive) return archiveConversation(ctx, archive[1]);
  const message = path.match(/^\/api\/v1\/conversations\/([^/]+)\/messages$/);
  if (method === "POST" && message) return postMessage(ctx, message[1]);
  const attachment = path.match(/^\/api\/v1\/conversations\/([^/]+)\/attachments$/);
  if (method === "POST" && attachment) return postAttachment(ctx, attachment[1]);

  if (method === "GET" && path === "/api/v1/billing") return billingStatus(ctx);
  if (method === "POST" && path === "/api/v1/billing/checkout") return checkout(ctx);
  if (method === "POST" && path === "/api/v1/billing/topup") return topup(ctx);
  if (method === "POST" && path === "/api/v1/billing/portal") return portal(ctx);
  if (method === "POST" && path === "/api/v1/billing/iap/verify") return verifyIap(ctx);
  if (method === "GET" && path === "/api/v1/billing/ledger") return ledger(ctx);
  if (method === "POST" && path === "/api/v1/billing/webhook") return webhook(ctx);
  if (method === "POST" && path === "/api/v1/billing/webhook/app-store") return appleWebhook(ctx);
  if (method === "POST" && path === "/api/v1/billing/webhook/google-play") return googleWebhook(ctx);

  if (method === "GET" && path === "/api/v1/ai/keys") return listKeys(ctx);
  const key = path.match(/^\/api\/v1\/ai\/keys\/([^/]+)$/);
  if (method === "PUT" && key) return putKey(ctx, decodeURIComponent(key[1]));
  if (method === "DELETE" && key) return deleteKey(ctx, decodeURIComponent(key[1]));
  const test = path.match(/^\/api\/v1\/ai\/keys\/([^/]+)\/test$/);
  if (method === "POST" && test) return testKey(ctx, decodeURIComponent(test[1]));
  if (method === "GET" && path === "/api/v1/ai/usage") return listUsage(ctx);

  if (method === "GET" && path === "/api/v1/jobs") return listJobs(ctx);
  if (method === "POST" && path === "/api/v1/jobs") return createJob(ctx);
  const analyses = path.match(/^\/api\/v1\/jobs\/([^/]+)\/analyses$/);
  if (method === "GET" && analyses) return listAnalyses(ctx, analyses[1]);
  const job = path.match(/^\/api\/v1\/jobs\/([^/]+)$/);
  if (method === "GET" && job) return getJob(ctx, job[1]);
  if (method === "PATCH" && job) return patchJob(ctx, job[1]);

  const recruited = await dispatchRecruiting(ctx, path);
  if (recruited) return recruited;
  const companies = await dispatchCompanies(ctx, path);
  if (companies) return companies;

  if (method === "GET" && path === "/api/v1/calendar/events") return listEvents(ctx);
  if (method === "POST" && path === "/api/v1/calendar/events") return createEvent(ctx);
  const event = path.match(/^\/api\/v1\/calendar\/events\/([^/]+)$/);
  if (method === "PATCH" && event) return patchEvent(ctx, event[1]);
  if (method === "DELETE" && event) return deleteEvent(ctx, event[1]);

  const consents = await dispatchConsents(ctx, path);
  if (consents) return consents;

  return errorResponse(404, "NOT_FOUND", "resource not found", ctx.rid);
}

async function idempotent(ctx: Ctx, path: string): Promise<Response> {
  const key = parseUuid(ctx.request.headers.get("idempotency-key") || "");
  if (!key) {
    return errorResponse(400, "VALIDATION_ERROR", "must be a UUID", ctx.rid, { field: "Idempotency-Key" });
  }
  const body = new Uint8Array(await ctx.request.clone().arrayBuffer());
  const requestHash = await sha256Bytes(body);
  const id = crypto.randomUUID();
  let inserted = false;
  try {
    const row = await one(ctx.deps.query,
      "INSERT INTO idempotency_keys (id, user_id, method, path, key, request_hash, created_at) VALUES ($1,$2,'POST',$3,$4,$5,$6) ON CONFLICT (user_id, method, path, key) DO NOTHING RETURNING id",
      [id, ctx.user.id, path, key, requestHash, ctx.now.toISOString()]);
    inserted = Boolean(row);
  } catch (err) {
    if (!isUnique(err)) return errorResponse(500, "INTERNAL", "internal error", ctx.rid);
  }
  if (!inserted) {
    const existing = await one(ctx.deps.query,
      "SELECT id, request_hash, response_status, response_body, response_headers, created_at FROM idempotency_keys WHERE user_id = $1 AND method = 'POST' AND path = $2 AND key = $3",
      [ctx.user.id, path, key]);
    if (!existing) return errorResponse(500, "INTERNAL", "internal error", ctx.rid);
    const pending = existing.response_status == null;
    const stale = pending && ctx.now.getTime() - Date.parse(String(existing.created_at)) > PENDING_MS;
    if (stale) {
      await query(ctx.deps.query, "DELETE FROM idempotency_keys WHERE id = $1 AND response_status IS NULL", [String(existing.id)]);
      return idempotent(ctx, path);
    }
    if (String(existing.request_hash) !== requestHash || pending) {
      return errorResponse(409, "IDEMPOTENCY_CONFLICT", "idempotency key conflict", ctx.rid);
    }
    const headers = new Headers();
    const stored = parseHeaders(existing.response_headers);
    for (const [name, value] of stored) headers.set(name, value);
    if (![...headers.keys()].some((name) => name.toLowerCase() === "content-type")) {
      headers.set("content-type", "application/json; charset=utf-8");
    }
    const payload = bodyOf(existing.response_body);
    const status = Number(existing.response_status);
    if (status === 204 || status === 205 || status === 304) {
      return new Response(null, { status, headers });
    }
    const replay = typeof payload === "string" ? payload : payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength) as ArrayBuffer;
    return new Response(replay, { status, headers });
  }
  let response: Response;
  try {
    response = await dispatch(ctx, path);
  } catch (err) {
    await query(ctx.deps.query, "DELETE FROM idempotency_keys WHERE id = $1 AND response_status IS NULL", [id]);
    if (err instanceof HttpError) return errorOf(err, ctx.rid);
    return errorResponse(500, "INTERNAL", "internal error", ctx.rid);
  }
  if (response.status < 200 || response.status >= 300) {
    await query(ctx.deps.query, "DELETE FROM idempotency_keys WHERE id = $1 AND response_status IS NULL", [id]);
    return response;
  }
  if (response.status === 204 || response.status === 205 || response.status === 304) {
    const headers = [...response.headers.entries()];
    try {
      await query(ctx.deps.query,
        "UPDATE idempotency_keys SET response_status = $2, response_body = $3, response_headers = $4::jsonb WHERE id = $1",
        [id, response.status, new Uint8Array(), JSON.stringify(headers)]);
    } catch {
      // The client still receives the result. A later retry may run again.
    }
    return new Response(null, { status: response.status, headers: response.headers });
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const headers = [...response.headers.entries()];
  try {
    await query(ctx.deps.query,
      "UPDATE idempotency_keys SET response_status = $2, response_body = $3, response_headers = $4::jsonb WHERE id = $1",
      [id, response.status, bytes, JSON.stringify(headers)]);
  } catch {
    // The client still receives the result. A later retry may run again.
  }
  return new Response(bytes, { status: response.status, headers: response.headers });
}

async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  const buf = await crypto.subtle.digest("SHA-256", copy);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function parseHeaders(value: unknown): [string, string][] {
  let raw = value;
  if (typeof raw === "string") {
    try { raw = JSON.parse(raw); } catch { return []; }
  }
  if (!Array.isArray(raw)) return [];
  return raw.filter((item) => Array.isArray(item) && item.length >= 2).map((item) => [String(item[0]), String(item[1])]);
}

function bodyOf(value: unknown): Uint8Array | string {
  if (value instanceof Uint8Array) return value;
  if (typeof value === "string") {
    if (value.startsWith("\\x")) {
      const hex = value.slice(2);
      const out = new Uint8Array(hex.length / 2);
      for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
      return out;
    }
    return value;
  }
  return "";
}
