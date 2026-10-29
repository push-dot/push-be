import { isUnique, one, query } from "../db.ts";
import { HttpError, asBool, data, fieldError, noContent, randomToken, sha256Hex } from "../http.ts";
import { createMailer, type Mailer } from "../mail/mailer.ts";
import { hashPassword, verifyPassword } from "../mail/password.ts";
import { allow } from "../ratelimit.ts";
import type { Ctx } from "../types.ts";
import { clearDeletion, emailTaken, issue, revokeAll } from "./auth.ts";

const HOUR_MS = 60 * 60 * 1000;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 128;
const LOGIN_PER_MINUTE = 10;
const MAIL_PER_MINUTE = 3;

let decoy: Promise<string> | null = null;
const decoyHash = (): Promise<string> => (decoy ??= hashPassword(crypto.randomUUID()));

const limitEmail = async (ctx: Ctx, kind: "login" | "mail", email: string, limit: number): Promise<void> => {
  if (!(await allow(ctx.deps.query, kind, email, limit, ctx.now.getTime()))) {
    throw new HttpError(429, "RATE_LIMITED", "too many requests", { retryAfterSec: 60 });
  }
};

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

const requireString = (body: Record<string, unknown>, key: string): string => {
  const value = body[key];
  if (typeof value !== "string" || !value) throw new HttpError(400, "VALIDATION_ERROR", "invalid request body");
  return value;
};

const requireEmail = (value: unknown): string => {
  if (typeof value !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())) {
    throw fieldError("email", "must be an email");
  }
  return value.trim().toLowerCase();
};

const requirePassword = (value: unknown): string => {
  const length = typeof value === "string" ? [...value].length : 0;
  if (typeof value !== "string" || length < PASSWORD_MIN || length > PASSWORD_MAX) {
    throw fieldError("password", "must be 8 to 128 characters");
  }
  return value;
};

const requireDisplayName = (value: unknown): string => {
  if (typeof value !== "string" || value.trim().length === 0 || [...value.trim()].length > 80) {
    throw fieldError("displayName", "must be 1 to 80 characters");
  }
  return value.trim();
};

const requireAccountType = (value: unknown): "EMPLOYER" => {
  if (value !== "EMPLOYER") throw fieldError("accountType", "must be EMPLOYER");
  return "EMPLOYER";
};

const mailerOf = (ctx: Ctx): Mailer => ctx.deps.mailer ?? createMailer(ctx.env, ctx.deps.fetch);

const originOf = (ctx: Ctx): string => (ctx.env.APP_WEB_ORIGIN || "http://localhost:5174").replace(/\/$/, "");

const sendLink = async (ctx: Ctx, to: string, kind: "verify" | "reset", token: string): Promise<void> => {
  const path = kind === "verify" ? "/auth/verify" : "/auth/reset";
  const url = `${originOf(ctx)}${path}?token=${encodeURIComponent(token)}`;
  const subject = kind === "verify" ? "이메일 인증" : "비밀번호 재설정";
  const text = url;
  const html = `<p><a href="${url}">${url}</a></p>`;
  await mailerOf(ctx).send({ to, subject, text, html, idempotencyKey: token });
};

// Issuing a link revokes the owner's unused links of the same kind, so only the newest one works.
const ISSUE_EMAIL_TOKEN = "WITH revoked AS (DELETE FROM email_tokens WHERE kind = $4 AND used_at IS NULL AND (user_id = $2 OR signup_id = $3)) INSERT INTO email_tokens (id, user_id, signup_id, kind, token_hash, expires_at, used_at) VALUES ($1,$2,$3,$4,$5,$6,NULL)";

const issueEmailToken = async (ctx: Ctx, kind: "VERIFY" | "RESET", userId: string | null, signupId: string | null): Promise<string> => {
  const token = randomToken();
  const hash = await sha256Hex(token);
  const expires = new Date(ctx.now.getTime() + (kind === "VERIFY" ? 24 * HOUR_MS : HOUR_MS)).toISOString();
  await query(ctx.deps.query, ISSUE_EMAIL_TOKEN, [crypto.randomUUID(), userId, signupId, kind, hash, expires]);
  return token;
};

const consumeToken = async (ctx: Ctx, id: string): Promise<boolean> => {
  const row = await one(ctx.deps.query,
    "UPDATE email_tokens SET used_at = $2 WHERE id = $1 AND used_at IS NULL RETURNING id",
    [id, ctx.now.toISOString()]);
  return Boolean(row);
};

const fresh = (row: Record<string, unknown>, now: Date): boolean =>
  row.used_at == null && now.getTime() <= Date.parse(String(row.expires_at));

const signup = async (ctx: Ctx): Promise<Response> => {
  const body = await readJson(ctx.request);
  const email = requireEmail(body.email);
  const password = requirePassword(body.password);
  const accountType = requireAccountType(body.accountType);
  const displayName = requireDisplayName(body.displayName);
  const consent = false;
  await limitEmail(ctx, "mail", email, MAIL_PER_MINUTE);
  const existing = await one(ctx.deps.query, "SELECT id, is_employer FROM users WHERE lower(email) = lower($1)", [email]);
  if (existing) throw emailTaken(existing);
  const passwordHash = await hashPassword(password);
  const now = ctx.now.toISOString();
  const id = crypto.randomUUID();
  const row = await one(ctx.deps.query,
    "INSERT INTO email_signups (id, email, password_hash, is_employer, display_name, consent_reference, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, is_employer = EXCLUDED.is_employer, display_name = EXCLUDED.display_name, consent_reference = EXCLUDED.consent_reference, created_at = EXCLUDED.created_at RETURNING id",
    [id, email, passwordHash, accountType === "EMPLOYER", displayName, consent, now]);
  const signupId = String(row?.id ?? id);
  const token = await issueEmailToken(ctx, "VERIFY", null, signupId);
  await sendLink(ctx, email, "verify", token);
  return data(202, { accepted: true }, ctx.rid);
};

const verify = async (ctx: Ctx): Promise<Response> => {
  const body = await readJson(ctx.request);
  const token = requireString(body, "token");
  const hash = await sha256Hex(token);
  const row = await one(ctx.deps.query,
    "SELECT t.id, t.used_at, t.expires_at, t.signup_id, s.email, s.password_hash, s.is_employer, s.display_name, s.consent_reference FROM email_tokens t JOIN email_signups s ON s.id = t.signup_id WHERE t.token_hash = $1 AND t.kind = 'VERIFY'",
    [hash]);
  if (!row || !fresh(row, ctx.now)) throw new HttpError(401, "UNAUTHENTICATED", "invalid token");
  if (!(await consumeToken(ctx, String(row.id)))) throw new HttpError(401, "UNAUTHENTICATED", "invalid token");
  const email = String(row.email).toLowerCase();
  const existing = await one(ctx.deps.query, "SELECT id, is_employer FROM users WHERE lower(email) = lower($1)", [email]);
  if (existing) throw emailTaken(existing);
  const userId = crypto.randomUUID();
  const now = ctx.now.toISOString();
  const employer = asBool(row.is_employer);
  try {
    await query(ctx.deps.query,
      "INSERT INTO users (id, provider, provider_subject, display_name, locale, created_at, email, email_verified_at, is_employer, password_hash) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
      [userId, "email", email, String(row.display_name), "ko", now, email, now, employer, String(row.password_hash)]);
  } catch (err) {
    if (!isUnique(err)) throw err;
    const taken = await one(ctx.deps.query, "SELECT id, is_employer FROM users WHERE lower(email) = lower($1)", [email]);
    if (taken) throw emailTaken(taken);
    throw err;
  }
  await Promise.all([
    asBool(row.consent_reference)
      ? query(ctx.deps.query, "INSERT INTO user_consents (user_id, reference_data, updated_at) VALUES ($1,$2,$3)", [userId, true, now])
      : null,
    query(ctx.deps.query, "DELETE FROM email_signups WHERE id = $1", [String(row.signup_id)]),
  ]);
  return data(200, await issue(ctx, userId), ctx.rid);
};

const login = async (ctx: Ctx): Promise<Response> => {
  const body = await readJson(ctx.request);
  const email = requireEmail(body.email);
  const password = typeof body.password === "string" ? body.password : "";
  await limitEmail(ctx, "login", email, LOGIN_PER_MINUTE);
  const user = await one(ctx.deps.query,
    "SELECT id, password_hash, email_verified_at, is_employer FROM users WHERE lower(email) = lower($1)",
    [email]);
  if (!user) {
    await verifyPassword(password, await decoyHash());
    const pending = await one(ctx.deps.query, "SELECT id FROM email_signups WHERE lower(email) = lower($1)", [email]);
    if (pending) throw new HttpError(403, "EMAIL_NOT_VERIFIED", "email is not verified");
    throw new HttpError(401, "INVALID_CREDENTIALS", "invalid credentials");
  }
  if (user.email_verified_at == null) throw new HttpError(403, "EMAIL_NOT_VERIFIED", "email is not verified");
  const stored = user.password_hash == null ? "" : String(user.password_hash);
  if (!(await verifyPassword(password, stored || await decoyHash())) || !stored) {
    throw new HttpError(401, "INVALID_CREDENTIALS", "invalid credentials");
  }
  await clearDeletion(ctx, String(user.id));
  return data(200, await issue(ctx, String(user.id)), ctx.rid);
};

const requestReset = async (ctx: Ctx): Promise<Response> => {
  const body = await readJson(ctx.request);
  const email = requireEmail(body.email);
  await limitEmail(ctx, "mail", email, MAIL_PER_MINUTE);
  const user = await one(ctx.deps.query, "SELECT id FROM users WHERE lower(email) = lower($1)", [email]);
  if (user) {
    const token = await issueEmailToken(ctx, "RESET", String(user.id), null);
    await sendLink(ctx, email, "reset", token);
  }
  return data(202, { accepted: true }, ctx.rid);
};

const confirmReset = async (ctx: Ctx): Promise<Response> => {
  const body = await readJson(ctx.request);
  const token = requireString(body, "token");
  const password = requirePassword(body.password);
  const hash = await sha256Hex(token);
  const row = await one(ctx.deps.query,
    "SELECT id, user_id, expires_at, used_at FROM email_tokens WHERE token_hash = $1 AND kind = 'RESET'",
    [hash]);
  if (!row || row.user_id == null || !fresh(row, ctx.now)) throw new HttpError(401, "UNAUTHENTICATED", "invalid token");
  if (!(await consumeToken(ctx, String(row.id)))) throw new HttpError(401, "UNAUTHENTICATED", "invalid token");
  await query(ctx.deps.query, "UPDATE users SET password_hash = $2 WHERE id = $1", [String(row.user_id), await hashPassword(password)]);
  await revokeAll(ctx, String(row.user_id));
  return noContent(ctx.rid);
};

export const dispatchEmailAuth = async (ctx: Ctx, path: string): Promise<Response | null> => {
  if (ctx.request.method !== "POST") return null;
  if (path === "/api/v1/auth/email/signup") return signup(ctx);
  if (path === "/api/v1/auth/email/verify") return verify(ctx);
  if (path === "/api/v1/auth/email/login") return login(ctx);
  if (path === "/api/v1/auth/email/password-reset") return requestReset(ctx);
  if (path === "/api/v1/auth/email/password-reset/confirm") return confirmReset(ctx);
  return null;
};
