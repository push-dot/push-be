import { readPendingSignup, type PendingSignup } from "../auth/pending-signup.ts";
import { isUnique, one, query } from "../db.ts";
import { HttpError, data, fieldError, sha256Hex } from "../http.ts";
import { ts } from "../page.ts";
import { createSmsSender, smsConfigured } from "../sms/sender.ts";
import type { Ctx, UserRow } from "../types.ts";
import { clearDeletion, issue, resolveUser } from "./auth.ts";

const SEND_PATH = "/api/v1/auth/phone/send";
const VERIFY_PATH = "/api/v1/auth/phone/verify";
const PHONE_RE = /^\+[1-9]\d{7,14}$/;
const CODE_RE = /^\d{6}$/;
const DEFAULT_COOLDOWN = 168;
const DEFAULT_TTL = 180;
const DEFAULT_ATTEMPTS = 5;

const LATEST_SENT = "SELECT sent_at FROM phone_codes WHERE phone = $1 ORDER BY sent_at DESC LIMIT 1";
const CONSUME_OPEN = "UPDATE phone_codes SET consumed_at = $2 WHERE phone = $1 AND consumed_at IS NULL";
const INSERT_CODE = "INSERT INTO phone_codes (id, phone, code_hash, expires_at, attempts, sent_at, consumed_at) VALUES ($1,$2,$3,$4,0,$5,NULL)";
const ACTIVE_CODE = "SELECT id, code_hash, expires_at, attempts FROM phone_codes WHERE phone = $1 AND consumed_at IS NULL ORDER BY sent_at DESC LIMIT 1";
const BUMP = "UPDATE phone_codes SET attempts = attempts + 1 WHERE id = $1 RETURNING attempts";
const CONSUME_ONE = "UPDATE phone_codes SET consumed_at = $2 WHERE id = $1 AND consumed_at IS NULL";
const BY_PHONE = "SELECT id FROM users WHERE phone = $1 AND is_employer = false";
const INSERT_USER = "INSERT INTO users (id, provider, provider_subject, display_name, locale, created_at, email, email_verified_at, is_employer, password_hash, phone) VALUES ($1,'phone',$2,'user','ko',$3,NULL,NULL,false,NULL,$2)";
const INSERT_SOCIAL = "INSERT INTO users (id, provider, provider_subject, display_name, locale, created_at, email, email_verified_at, is_employer, password_hash, phone) VALUES ($1,$2,$3,'user','ko',$4,$5,$6,false,NULL,$7)";
const SET_SOCIAL = "UPDATE users SET provider = $2, provider_subject = $3 WHERE id = $1 AND provider = 'phone'";
const ME = "SELECT id, provider, provider_subject, is_employer FROM users WHERE id = $1";
const LIST_PROVIDERS = "SELECT provider FROM user_identities WHERE user_id = $1";
const IDENTITY = "SELECT user_id FROM user_identities WHERE provider = $1 AND provider_subject = $2";
const INSERT_IDENTITY = "INSERT INTO user_identities (user_id, provider, provider_subject, created_at) VALUES ($1,$2,$3,$4)";

const readJson = async (request: Request): Promise<Record<string, unknown>> => {
  const raw = await request.text();
  if (!raw) throw new HttpError(400, "VALIDATION_ERROR", "request body required");
  try {
    const body = JSON.parse(raw) as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new HttpError(400, "VALIDATION_ERROR", "invalid request body");
    }
    return body as Record<string, unknown>;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, "VALIDATION_ERROR", "invalid request body");
  }
};

const envInt = (value: string | undefined, fallback: number, max: number): number => {
  if (value == null || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) return fallback;
  return parsed;
};

const phoneOf = (body: Record<string, unknown>): string => {
  const phone = body.phone;
  if (typeof phone !== "string" || !PHONE_RE.test(phone)) throw fieldError("phone", "must be E.164");
  return phone;
};

const codeOf = (body: Record<string, unknown>): string => {
  const code = body.code;
  if (typeof code !== "string" || !CODE_RE.test(code)) throw fieldError("code", "must be 6 digits");
  return code;
};

const six = (): string => {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return String(buf[0] % 1000000).padStart(6, "0");
};

const callerOf = async (ctx: Ctx): Promise<UserRow | null> => {
  const header = ctx.request.headers.get("authorization") || "";
  if (!header) return null;
  if (!header.startsWith("Bearer ")) throw new HttpError(401, "UNAUTHENTICATED", "missing bearer token");
  const user = await resolveUser(ctx, header.slice(7));
  if (user.accountType === "EMPLOYER") throw new HttpError(403, "FORBIDDEN", "phone auth is for personal accounts");
  return user;
};

const bindIdentity = async (ctx: Ctx, userId: string, provider: string, subject: string): Promise<void> => {
  if (!provider || !subject) return;
  const existing = await one(ctx.deps.query, IDENTITY, [provider, subject]);
  if (existing) {
    if (String(existing.user_id) === userId) return;
    throw new HttpError(409, "PHONE_TAKEN", "this login is already linked to another account");
  }
  try {
    await query(ctx.deps.query, INSERT_IDENTITY, [userId, provider, subject, ctx.now.toISOString()]);
  } catch (err) {
    if (!isUnique(err)) throw err;
    const again = await one(ctx.deps.query, IDENTITY, [provider, subject]);
    if (again && String(again.user_id) === userId) return;
    throw new HttpError(409, "PHONE_TAKEN", "this login is already linked to another account");
  }
};

const session = async (ctx: Ctx, userId: string, created: boolean, link?: { provider: string }): Promise<Response> => {
  await clearDeletion(ctx, userId);
  const body = await issue(ctx, userId);
  return data(200, { ...body, created, ...(link ? { linked: true, provider: link.provider } : {}) }, ctx.rid);
};

const socialProviders = async (ctx: Ctx, userId: string): Promise<string[]> => {
  const me = await one(ctx.deps.query, ME, [userId]);
  const listed = await query(ctx.deps.query, LIST_PROVIDERS, [userId]);
  const found = new Set<string>();
  const add = (value: unknown): void => {
    const provider = String(value ?? "");
    if (!provider || provider === "phone") return;
    found.add(provider);
  };
  add(me?.provider);
  for (const row of listed.rows) add(row.provider);
  return [...found];
};

const pendingOf = async (ctx: Ctx, body: Record<string, unknown>): Promise<PendingSignup | null> => {
  if (body.pendingToken == null || body.pendingToken === "") return null;
  if (typeof body.pendingToken !== "string") throw fieldError("pendingToken", "must be a string");
  return readPendingSignup(ctx.env, body.pendingToken, ctx.now);
};

const sendPhone = async (ctx: Ctx): Promise<Response> => {
  const phone = phoneOf(await readJson(ctx.request));
  await callerOf(ctx);
  const cooldown = envInt(ctx.env.PHONE_CODE_COOLDOWN_SEC, DEFAULT_COOLDOWN, 3600);
  const ttl = envInt(ctx.env.PHONE_CODE_TTL_SEC, DEFAULT_TTL, 3600);
  const latest = await one(ctx.deps.query, LATEST_SENT, [phone]);
  if (latest?.sent_at != null) {
    const wait = Math.ceil((Date.parse(String(latest.sent_at)) + cooldown * 1000 - ctx.now.getTime()) / 1000);
    if (wait > 0) throw new HttpError(429, "RATE_LIMITED", "resend cooldown", { retryAfterSec: wait });
  }
  if (!ctx.deps.sms && !smsConfigured(ctx.env)) {
    throw new HttpError(503, "NOT_CONFIGURED", "sms provider is not configured");
  }
  const id = crypto.randomUUID();
  const code = six();
  const now = ctx.now.toISOString();
  const expires = new Date(ctx.now.getTime() + ttl * 1000);
  await query(ctx.deps.query, CONSUME_OPEN, [phone, now]);
  await query(ctx.deps.query, INSERT_CODE, [id, phone, await sha256Hex(`${id}:${code}`), expires.toISOString(), now]);
  const sender = ctx.deps.sms ?? createSmsSender(ctx.env);
  try {
    await sender.send(phone, code);
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(503, "NOT_CONFIGURED", "sms provider is not configured");
  }
  return data(202, { cooldownSeconds: cooldown, expiresAt: ts(expires) }, ctx.rid);
};

const finishOwned = async (ctx: Ctx, userId: string, phone: string, created: boolean): Promise<Response> => {
  await bindIdentity(ctx, userId, "phone", phone);
  return session(ctx, userId, created);
};

const linkOrBlock = async (ctx: Ctx, userId: string, pending: PendingSignup, phone: string): Promise<Response> => {
  const existing = await socialProviders(ctx, userId);
  if (existing.length > 0) {
    throw new HttpError(409, "PHONE_ALREADY_REGISTERED", "phone is already registered", { existingProviders: existing });
  }
  const taken = await one(ctx.deps.query, IDENTITY, [pending.provider, pending.subject]);
  if (taken && String(taken.user_id) !== userId) {
    throw new HttpError(409, "PHONE_TAKEN", "this login is already linked to another account");
  }
  try {
    await query(ctx.deps.query, SET_SOCIAL, [userId, pending.provider, pending.subject]);
  } catch (err) {
    if (!isUnique(err)) throw err;
    throw new HttpError(409, "PHONE_TAKEN", "this login is already linked to another account");
  }
  await bindIdentity(ctx, userId, pending.provider, pending.subject);
  await bindIdentity(ctx, userId, "phone", phone);
  return session(ctx, userId, false, { provider: pending.provider });
};

const insertSocial = async (ctx: Ctx, userId: string, pending: PendingSignup, phone: string, email: string | null): Promise<void> => {
  const now = ctx.now.toISOString();
  await query(ctx.deps.query, INSERT_SOCIAL, [userId, pending.provider, pending.subject, now, email, email ? now : null, phone]);
};

const createFromPending = async (ctx: Ctx, pending: PendingSignup, phone: string): Promise<Response> => {
  const userId = crypto.randomUUID();
  try {
    await insertSocial(ctx, userId, pending, phone, pending.email);
  } catch (err) {
    if (!isUnique(err)) throw err;
    const raced = await one(ctx.deps.query, BY_PHONE, [phone]);
    if (raced) return linkOrBlock(ctx, String(raced.id), pending, phone);
    if (!pending.email) throw new HttpError(409, "PHONE_TAKEN", "this login is already linked to another account");
    try {
      await insertSocial(ctx, userId, pending, phone, null);
    } catch (err2) {
      if (!isUnique(err2)) throw err2;
      const again = await one(ctx.deps.query, BY_PHONE, [phone]);
      if (again) return linkOrBlock(ctx, String(again.id), pending, phone);
      throw new HttpError(409, "PHONE_TAKEN", "this login is already linked to another account");
    }
  }
  await bindIdentity(ctx, userId, pending.provider, pending.subject);
  return finishOwned(ctx, userId, phone, true);
};

const verifyPhone = async (ctx: Ctx): Promise<Response> => {
  const body = await readJson(ctx.request);
  const phone = phoneOf(body);
  const code = codeOf(body);
  const max = envInt(ctx.env.PHONE_CODE_MAX_ATTEMPTS, DEFAULT_ATTEMPTS, 20);
  const row = await one(ctx.deps.query, ACTIVE_CODE, [phone]);
  if (!row) throw new HttpError(400, "PHONE_CODE_INVALID", "code is invalid");
  if (Date.parse(String(row.expires_at)) <= ctx.now.getTime()) {
    await query(ctx.deps.query, CONSUME_ONE, [String(row.id), ctx.now.toISOString()]);
    throw new HttpError(400, "PHONE_CODE_EXPIRED", "code is expired");
  }
  if (Number(row.attempts) >= max) throw new HttpError(429, "RATE_LIMITED", "too many attempts");
  if (await sha256Hex(`${String(row.id)}:${code}`) !== String(row.code_hash)) {
    await query(ctx.deps.query, BUMP, [String(row.id)]);
    throw new HttpError(400, "PHONE_CODE_INVALID", "code is invalid");
  }
  const pending = await pendingOf(ctx, body);
  await query(ctx.deps.query, CONSUME_ONE, [String(row.id), ctx.now.toISOString()]);
  if (pending) {
    const owner = await one(ctx.deps.query, BY_PHONE, [phone]);
    if (owner) return linkOrBlock(ctx, String(owner.id), pending, phone);
    return createFromPending(ctx, pending, phone);
  }
  const owner = await one(ctx.deps.query, BY_PHONE, [phone]);
  if (owner) return finishOwned(ctx, String(owner.id), phone, false);
  const userId = crypto.randomUUID();
  try {
    await query(ctx.deps.query, INSERT_USER, [userId, phone, ctx.now.toISOString()]);
  } catch (err) {
    if (!isUnique(err)) throw err;
    const raced = await one(ctx.deps.query, BY_PHONE, [phone]);
    if (!raced) throw err;
    return finishOwned(ctx, String(raced.id), phone, false);
  }
  return finishOwned(ctx, userId, phone, true);
};

export const dispatchPhoneAuth = async (ctx: Ctx, path: string): Promise<Response | null> => {
  if (ctx.request.method !== "POST") return null;
  if (path === SEND_PATH) return sendPhone(ctx);
  if (path === VERIFY_PATH) return verifyPhone(ctx);
  return null;
};
