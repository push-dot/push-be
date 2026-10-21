import { isMissingRelation, isUndefinedColumn, isUnique, query, one } from "../db.ts";
import { HttpError, asBool, data, randomToken, requireUuid, sha256Hex } from "../http.ts";
import { verifyPkce } from "../crypto.ts";
import { ts } from "../page.ts";
import { cancelSubscriptions } from "./billing.ts";
import type { Ctx, UserRow } from "../types.ts";

const ACCESS_TTL = 900;
const REFRESH_MS = 30 * 24 * 60 * 60 * 1000;
const STATE_MS = 10 * 60 * 1000;
const EXCHANGE_MS = 60 * 1000;
const LOCAL_CALLBACK = /^http:\/\/(?:localhost|127\.0\.0\.1):(\d{1,5})\/auth\/callback$/;
const USER_BY_ID_BASE = "SELECT id, display_name, locale, plan, subscription_status, stripe_customer_id, period_ends_at, created_at, is_employer FROM users WHERE id = $1";
const USER_BY_ID = "SELECT id, display_name, locale, plan, subscription_status, stripe_customer_id, period_ends_at, created_at, is_employer, (SELECT company_id FROM company_members WHERE company_members.user_id = users.id) AS company_id, (SELECT role FROM company_members WHERE company_members.user_id = users.id) AS company_role FROM users WHERE id = $1";
const USER_BY_TOKEN_BASE = "SELECT u.id, u.display_name, u.locale, u.plan, u.subscription_status, u.stripe_customer_id, u.period_ends_at, u.created_at, u.is_employer, t.expires_at AS token_expires_at FROM access_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = $1";
const USER_BY_TOKEN = "SELECT u.id, u.display_name, u.locale, u.plan, u.subscription_status, u.stripe_customer_id, u.period_ends_at, u.created_at, u.is_employer, (SELECT company_id FROM company_members WHERE company_members.user_id = u.id) AS company_id, (SELECT role FROM company_members WHERE company_members.user_id = u.id) AS company_role, t.expires_at AS token_expires_at FROM access_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = $1";

const userBy = async (ctx: Omit<Ctx, "user">, sql: string, fallback: string, params: unknown[]): Promise<Record<string, unknown> | null> => {
  try {
    return await one(ctx.deps.query, sql, params);
  } catch (err) {
    if (!isMissingRelation(err) && !isUndefinedColumn(err)) throw err;
    return one(ctx.deps.query, fallback, params);
  }
};

const employerFlag = (value: unknown): boolean =>
  value === true || value === "t" || value === "true" || value === 1;

const textOrNull = (value: unknown): string | null =>
  value == null || value === "" ? null : String(value);

export const emailTaken = (row: Record<string, unknown>): HttpError => {
  const employer = employerFlag(row.is_employer);
  const accountType = employer ? "EMPLOYER" : "PERSONAL";
  const message = employer
    ? "이 이메일은 기업 계정으로 가입되어 있어요"
    : "이 이메일은 개인 계정으로 가입되어 있어요";
  return new HttpError(409, "EMAIL_TAKEN", message, { accountType });
};

const allowedRedirect = (redirect: string, origins: string | undefined): boolean => {
  if (redirect === "push://auth/callback" || redirect === "http://localhost:5173/auth/callback") return true;
  const local = LOCAL_CALLBACK.exec(redirect);
  if (local) {
    const port = Number(local[1]);
    return port >= 1 && port <= 65535;
  }
  let target: URL;
  try { target = new URL(redirect); } catch { return false; }
  if (target.protocol !== "http:" && target.protocol !== "https:") return false;
  if (target.pathname !== "/auth/callback" || target.search || target.hash || target.username || target.password) return false;
  return (origins ?? "").split(",").map((item) => item.trim()).filter(Boolean).some((origin) => {
    try {
      const base = new URL(origin);
      return (base.pathname === "/" || base.pathname === "") && base.origin === target.origin;
    } catch {
      return false;
    }
  });
};

const accountTypeFrom = (value: string | null): "PERSONAL" | "EMPLOYER" => {
  if (value == null || value === "" || value === "PERSONAL") return "PERSONAL";
  if (value === "EMPLOYER") return "EMPLOYER";
  throw new HttpError(400, "VALIDATION_ERROR", "must be PERSONAL or EMPLOYER", { field: "accountType" });
};

const githubPrimaryEmail = async (fetchImpl: typeof fetch, access: string): Promise<{ email: string | null; verified: boolean }> => {
  try {
    const res = await fetchImpl("https://api.github.com/user/emails", {
      headers: { authorization: "Bearer " + access, accept: "application/json", "user-agent": "push-be" },
    });
    if (!res.ok) return { email: null, verified: false };
    const body = await res.json() as unknown;
    if (!Array.isArray(body)) return { email: null, verified: false };
    for (const item of body) {
      if (!item || typeof item !== "object") continue;
      const row = item as { primary?: unknown; verified?: unknown; email?: unknown };
      if (row.primary && row.verified && typeof row.email === "string" && row.email.trim()) {
        return { email: row.email.trim().toLowerCase(), verified: true };
      }
    }
    return { email: null, verified: false };
  } catch {
    return { email: null, verified: false };
  }
};

const PROVIDERS: Record<string, { auth: string; token: string; user: string }> = {
  google: {
    auth: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
    user: "https://openidconnect.googleapis.com/v1/userinfo",
  },
  github: {
    auth: "https://github.com/login/oauth/authorize",
    token: "https://github.com/login/oauth/access_token",
    user: "https://api.github.com/user",
  },
};

function providerCfg(env: Ctx["env"], provider: string): { id: string; secret: string; auth: string; token: string; user: string } {
  if (!PROVIDERS[provider]) throw new HttpError(404, "NOT_FOUND", "resource not found");
  const id = provider === "google" ? env.GOOGLE_CLIENT_ID : env.GITHUB_CLIENT_ID;
  const secret = provider === "google" ? env.GOOGLE_CLIENT_SECRET : env.GITHUB_CLIENT_SECRET;
  if (!id || !secret) throw new HttpError(503, "NOT_CONFIGURED", `oauth provider ${provider} is not configured`);
  return { id, secret, ...PROVIDERS[provider] };
}

function userFrom(row: Record<string, unknown>): UserRow {
  return {
    id: String(row.id),
    displayName: String(row.display_name ?? ""),
    locale: String(row.locale ?? "ko"),
    plan: String(row.plan ?? "FREE"),
    subscriptionStatus: String(row.subscription_status ?? "NONE"),
    stripeCustomerId: row.stripe_customer_id == null ? null : String(row.stripe_customer_id),
    periodEndsAt: row.period_ends_at == null ? null : String(row.period_ends_at),
    createdAt: String(row.created_at),
    accountType: employerFlag(row.is_employer) ? "EMPLOYER" : "PERSONAL",
    companyId: textOrNull(row.company_id),
    companyRole: textOrNull(row.company_role),
  };
}

export async function resolveUser(ctx: Omit<Ctx, "user">, token: string): Promise<UserRow> {
  const env = ctx.env;
  if (env.APP_ENV === "development" && env.DEV_AUTH_TOKEN && token === env.DEV_AUTH_TOKEN) {
    const id = env.DEV_USER_ID || "";
    const row = await userBy(ctx, USER_BY_ID, USER_BY_ID_BASE, [id]);
    if (!row) throw new HttpError(401, "UNAUTHENTICATED", "dev user not seeded");
    return userFrom(row);
  }
  const hash = await sha256Hex(token);
  const row = await userBy(ctx, USER_BY_TOKEN, USER_BY_TOKEN_BASE, [hash]);
  if (!row) throw new HttpError(401, "UNAUTHENTICATED", "invalid access token");
  if (ctx.now.getTime() > Date.parse(String(row.token_expires_at))) {
    throw new HttpError(401, "TOKEN_EXPIRED", "access token expired");
  }
  return userFrom(row);
}

function sessionBody(access: string, refresh: string, user: UserRow): Record<string, unknown> {
  return {
    accessToken: access,
    refreshToken: refresh,
    expiresIn: ACCESS_TTL,
    user: {
      id: user.id,
      displayName: user.displayName,
      locale: user.locale,
      accountType: user.accountType,
      companyId: user.companyId,
      companyRole: user.companyRole,
    },
  };
}

export async function issue(ctx: Ctx, userId: string): Promise<Record<string, unknown>> {
  const access = randomToken();
  const refresh = randomToken();
  const accessHash = await sha256Hex(access);
  const refreshHash = await sha256Hex(refresh);
  const refreshId = crypto.randomUUID();
  const accessId = crypto.randomUUID();
  const refreshExp = new Date(ctx.now.getTime() + REFRESH_MS).toISOString();
  const accessExp = new Date(ctx.now.getTime() + ACCESS_TTL * 1000).toISOString();
  const created = ctx.now.toISOString();
  await query(ctx.deps.query,
    "WITH rt AS (INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, revoked_at, created_at) VALUES ($1,$2,$3,$4,NULL,$5) RETURNING id) INSERT INTO access_tokens (id, user_id, token_hash, refresh_token_id, expires_at, created_at) SELECT $6,$2,$7,rt.id,$8,$5 FROM rt",
    [refreshId, userId, refreshHash, refreshExp, created, accessId, accessHash, accessExp]);
  const row = await userBy(ctx, USER_BY_ID, USER_BY_ID_BASE, [userId]);
  if (!row) throw new HttpError(500, "INTERNAL", "internal error");
  return sessionBody(access, refresh, userFrom(row));
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
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
}

function requireString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string") throw new HttpError(400, "VALIDATION_ERROR", "invalid request body");
  return value;
}

export async function oauthStart(ctx: Ctx): Promise<Response> {
  const provider = ctx.url.pathname.split("/")[4] || "";
  if (!PROVIDERS[provider]) throw new HttpError(404, "NOT_FOUND", "resource not found");
  const accountType = accountTypeFrom(ctx.url.searchParams.get("accountType"));
  if (provider === "github" && accountType === "EMPLOYER") {
    throw new HttpError(400, "VALIDATION_ERROR", "not allowed", { field: "accountType" });
  }
  const cfg = providerCfg(ctx.env, provider);
  const method = ctx.url.searchParams.get("codeChallengeMethod") || "";
  const challenge = ctx.url.searchParams.get("codeChallenge") || "";
  const redirect = ctx.url.searchParams.get("redirectUri") || "";
  if (method !== "S256") throw new HttpError(400, "VALIDATION_ERROR", "must be S256", { field: "codeChallengeMethod" });
  if (!challenge) throw new HttpError(400, "VALIDATION_ERROR", "required", { field: "codeChallenge" });
  if (!allowedRedirect(redirect, ctx.env.OAUTH_REDIRECT_ORIGINS)) {
    throw new HttpError(400, "VALIDATION_ERROR", "not allowed", { field: "redirectUri" });
  }
  const state = randomToken();
  const callback = new URL(ctx.request.url).origin + "/api/v1/auth/" + provider + "/callback";
  const expires = new Date(ctx.now.getTime() + STATE_MS);
  await query(ctx.deps.query,
    "INSERT INTO oauth_states (state, provider, code_challenge, redirect_uri, final_uri, expires_at, created_at, user_id, purpose, account_type) VALUES ($1,$2,$3,$4,$5,$6,$7,NULL,'LOGIN',$8)",
    [state, provider, challenge, callback, redirect, expires.toISOString(), ctx.now.toISOString(), accountType]);
  const q = new URLSearchParams({
    client_id: cfg.id,
    redirect_uri: callback,
    response_type: "code",
    state,
  });
  if (provider === "google") {
    q.set("scope", "openid email profile");
    q.set("access_type", "offline");
  } else {
    q.set("scope", "read:user user:email");
  }
  return data(200, {
    authorizationUrl: cfg.auth + "?" + q.toString(),
    state,
    expiresAt: ts(expires),
  }, ctx.rid);
}

export async function oauthCallback(ctx: Ctx): Promise<Response> {
  const provider = ctx.url.pathname.split("/")[4] || "";
  const cfg = providerCfg(ctx.env, provider);
  const code = ctx.url.searchParams.get("code") || "";
  const state = ctx.url.searchParams.get("state") || "";
  const rec = await one(ctx.deps.query,
    "SELECT state, provider, code_challenge, redirect_uri, final_uri, expires_at, account_type FROM oauth_states WHERE state = $1",
    [state]);
  if (!rec) throw new HttpError(401, "UNAUTHENTICATED", "invalid state");
  await query(ctx.deps.query, "DELETE FROM oauth_states WHERE state = $1", [state]);
  if (ctx.now.getTime() > Date.parse(String(rec.expires_at)) || String(rec.provider) !== provider) {
    throw new HttpError(401, "UNAUTHENTICATED", "state expired");
  }
  const fetchImpl = ctx.deps.fetch ?? fetch;
  let access = "";
  try {
    const form = new URLSearchParams({
      client_id: cfg.id,
      client_secret: cfg.secret,
      code,
      redirect_uri: String(rec.redirect_uri),
      grant_type: "authorization_code",
    });
    const tokenRes = await fetchImpl(cfg.token, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: form,
    });
    const tokenBody = await tokenRes.json() as { access_token?: string };
    if (!tokenRes.ok || !tokenBody.access_token) throw new Error("exchange");
    access = tokenBody.access_token;
  } catch {
    throw new HttpError(502, "PROVIDER_ERROR", "provider token exchange failed");
  }
  const identityHeaders = { authorization: "Bearer " + access, accept: "application/json", "user-agent": "push-be" };
  let subject = "";
  let name = "";
  let email: string | null = null;
  let emailVerified = false;
  try {
    // GitHub's API rejects requests without a User-Agent (403); Workers' fetch sends none by default.
    const ident = await fetchImpl(cfg.user, { headers: identityHeaders });
    if (!ident.ok) throw new Error("identity");
    const body = await ident.json() as { sub?: string; id?: string | number; name?: string; login?: string; email?: string; email_verified?: boolean };
    subject = body.sub || (body.id != null ? String(body.id) : "");
    if (!subject) throw new Error("subject");
    name = body.name || body.login || body.email || "user";
    if (provider === "google") {
      const raw = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
      email = raw || null;
      emailVerified = body.email_verified === true && email != null;
    }
  } catch {
    throw new HttpError(502, "PROVIDER_ERROR", "provider identity fetch failed");
  }
  if (provider === "github") {
    const picked = await githubPrimaryEmail(fetchImpl, access);
    email = picked.email;
    emailVerified = picked.verified;
  }
  const codeValue = randomToken();
  const expires = new Date(ctx.now.getTime() + EXCHANGE_MS).toISOString();
  const accountType = rec.account_type === "EMPLOYER" ? "EMPLOYER" : "PERSONAL";
  await query(ctx.deps.query,
    "INSERT INTO exchange_codes (code, user_id, code_challenge, expires_at, used_at, created_at, provider, provider_subject, email, email_verified, display_name, account_type) VALUES ($1,$2,$3,$4,NULL,$5,$6,$7,$8,$9,$10,$11)",
    [codeValue, null, String(rec.code_challenge), expires, ctx.now.toISOString(), provider, subject, email, emailVerified, name, accountType]);
  const finalUri = String(rec.final_uri || "push://auth/callback");
  return new Response(null, {
    status: 302,
    headers: { location: finalUri + "?code=" + encodeURIComponent(codeValue), "x-request-id": ctx.rid },
  });
}

export const clearDeletion = async (ctx: Ctx, userId: string): Promise<void> => {
  await query(ctx.deps.query, "UPDATE users SET deletion_requested_at = NULL WHERE id = $1 AND deletion_requested_at IS NOT NULL", [userId])
    .catch((err: unknown) => { if (!isUndefinedColumn(err)) throw err; });
  await query(ctx.deps.query, "UPDATE companies SET deletion_requested_at = NULL WHERE id IN (SELECT company_id FROM company_members WHERE user_id = $1 AND role = 'ADMIN')", [userId])
    .catch((err: unknown) => { if (!isUndefinedColumn(err) && !isMissingRelation(err)) throw err; });
};

const accountLabel = (row: Record<string, unknown>): "PERSONAL" | "EMPLOYER" =>
  employerFlag(row.is_employer) ? "EMPLOYER" : "PERSONAL";

const resolveOAuthUser = async (ctx: Ctx, rec: Record<string, unknown>): Promise<string> => {
  const provider = rec.provider == null || rec.provider === "" ? "" : String(rec.provider);
  if (!provider) {
    if (rec.user_id == null || rec.user_id === "") throw new HttpError(400, "EMAIL_NOT_VERIFIED", "email is not verified");
    return String(rec.user_id);
  }
  const email = rec.email == null ? "" : String(rec.email).trim().toLowerCase();
  if (!asBool(rec.email_verified) || !email) throw new HttpError(400, "EMAIL_NOT_VERIFIED", "email is not verified");
  const accountType = rec.account_type === "EMPLOYER" ? "EMPLOYER" : "PERSONAL";
  const byEmail = await one(ctx.deps.query, "SELECT id, is_employer FROM users WHERE lower(email) = lower($1)", [email]);
  if (byEmail) {
    if (accountLabel(byEmail) !== accountType) throw emailTaken(byEmail);
    return String(byEmail.id);
  }
  const byProvider = await one(ctx.deps.query, "SELECT id, is_employer FROM users WHERE provider = $1 AND provider_subject = $2", [provider, String(rec.provider_subject ?? "")]);
  if (byProvider) {
    if (accountLabel(byProvider) !== accountType) throw emailTaken(byProvider);
    return String(byProvider.id);
  }
  const userId = crypto.randomUUID();
  const now = ctx.now.toISOString();
  try {
    await query(ctx.deps.query,
      "INSERT INTO users (id, provider, provider_subject, display_name, locale, created_at, email, email_verified_at, is_employer, password_hash) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
      [userId, provider, String(rec.provider_subject ?? ""), String(rec.display_name || "user"), "ko", now, email, now, accountType === "EMPLOYER", null]);
  } catch (err) {
    if (!isUnique(err)) throw err;
    const taken = await one(ctx.deps.query, "SELECT id, is_employer FROM users WHERE lower(email) = lower($1)", [email]);
    if (!taken) throw err;
    if (accountLabel(taken) !== accountType) throw emailTaken(taken);
    return String(taken.id);
  }
  return userId;
};

export async function exchange(ctx: Ctx): Promise<Response> {
  const body = await readJson(ctx.request);
  const code = requireString(body, "code");
  const verifier = requireString(body, "codeVerifier");
  const rec = await one(ctx.deps.query,
    "SELECT code, user_id, code_challenge, expires_at, used_at, provider, provider_subject, email, email_verified, display_name, account_type FROM exchange_codes WHERE code = $1",
    [code]);
  if (!rec) throw new HttpError(401, "UNAUTHENTICATED", "invalid code");
  if (rec.used_at != null || ctx.now.getTime() > Date.parse(String(rec.expires_at))) {
    throw new HttpError(401, "UNAUTHENTICATED", "code expired or already used");
  }
  if (!verifier || !(await verifyPkce(verifier, String(rec.code_challenge)))) {
    throw new HttpError(401, "UNAUTHENTICATED", "pkce verification failed");
  }
  const marked = await one(ctx.deps.query,
    "UPDATE exchange_codes SET used_at = $2 WHERE code = $1 AND used_at IS NULL RETURNING code",
    [code, ctx.now.toISOString()]);
  if (!marked) throw new HttpError(401, "UNAUTHENTICATED", "code expired or already used");
  const userId = await resolveOAuthUser(ctx, rec);
  await clearDeletion(ctx, userId);
  return data(200, await issue(ctx, userId), ctx.rid);
}

export async function revokeAll(ctx: Ctx, userId: string): Promise<void> {
  const at = ctx.now.toISOString();
  await query(ctx.deps.query, "UPDATE refresh_tokens SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL", [userId, at]);
  await query(ctx.deps.query, "UPDATE access_tokens SET expires_at = $2 WHERE user_id = $1", [userId, at]);
}

export async function refresh(ctx: Ctx): Promise<Response> {
  const body = await readJson(ctx.request);
  const token = requireString(body, "refreshToken");
  const hash = await sha256Hex(token);
  const rec = await one(ctx.deps.query,
    "SELECT id, user_id, expires_at, revoked_at FROM refresh_tokens WHERE token_hash = $1",
    [hash]);
  if (!rec) throw new HttpError(401, "UNAUTHENTICATED", "invalid refresh token");
  if (rec.revoked_at != null) {
    await revokeAll(ctx, String(rec.user_id));
    throw new HttpError(401, "UNAUTHENTICATED", "refresh token revoked");
  }
  if (ctx.now.getTime() > Date.parse(String(rec.expires_at))) {
    throw new HttpError(401, "TOKEN_EXPIRED", "access token expired");
  }
  const revoked = await one(ctx.deps.query,
    "UPDATE refresh_tokens SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL RETURNING id",
    [String(rec.id), ctx.now.toISOString()]);
  if (!revoked) {
    await revokeAll(ctx, String(rec.user_id));
    throw new HttpError(401, "UNAUTHENTICATED", "refresh token revoked");
  }
  await query(ctx.deps.query, "UPDATE access_tokens SET expires_at = $2 WHERE refresh_token_id = $1", [String(rec.id), ctx.now.toISOString()]);
  return data(200, await issue(ctx, String(rec.user_id)), ctx.rid);
}

export async function logout(ctx: Ctx): Promise<Response> {
  const body = await readJson(ctx.request);
  const token = requireString(body, "refreshToken");
  if (token) {
    const hash = await sha256Hex(token);
    const rec = await one(ctx.deps.query, "SELECT id FROM refresh_tokens WHERE token_hash = $1", [hash]);
    if (rec) {
      const at = ctx.now.toISOString();
      await query(ctx.deps.query, "UPDATE refresh_tokens SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL", [String(rec.id), at]);
      await query(ctx.deps.query, "UPDATE access_tokens SET expires_at = $2 WHERE refresh_token_id = $1", [String(rec.id), at]);
    }
  }
  return new Response(null, { status: 204, headers: { "x-request-id": ctx.rid } });
}

/** Marks the account for deletion; logging in within 30 days restores it, then the cron purges it. */
const companyMembership = async (ctx: Ctx): Promise<Record<string, unknown> | null> => {
  try {
    return await one(ctx.deps.query,
      "SELECT m.role, m.company_id, c.stripe_customer_id, (SELECT count(*) FROM company_members o WHERE o.company_id = m.company_id AND o.user_id <> m.user_id) AS others FROM company_members m JOIN companies c ON c.id = m.company_id WHERE m.user_id = $1",
      [ctx.user.id]);
  } catch (err) {
    if (isUndefinedColumn(err) || isMissingRelation(err)) return null;
    throw err;
  }
};

export async function deleteAccount(ctx: Ctx): Promise<Response> {
  const membership = await companyMembership(ctx);
  const soleAdmin = membership != null && String(membership.role) === "ADMIN" && Number(membership.others ?? 0) === 0;
  if (membership != null && String(membership.role) === "ADMIN" && Number(membership.others ?? 0) > 0) {
    throw new HttpError(409, "ADMIN_TRANSFER_REQUIRED", "transfer admin before deleting the account");
  }
  // Mark first so a missing migration fails before Stripe is touched; undo the mark if Stripe fails.
  await query(ctx.deps.query, "UPDATE users SET deletion_requested_at = $2 WHERE id = $1", [ctx.user.id, ctx.now.toISOString()]);
  try {
    await cancelSubscriptions(ctx);
    const companyCustomer = soleAdmin && membership?.stripe_customer_id != null ? String(membership.stripe_customer_id) : "";
    if (companyCustomer && companyCustomer !== (ctx.user.stripeCustomerId ?? "")) await cancelSubscriptions(ctx, companyCustomer);
  } catch (err) {
    await query(ctx.deps.query, "UPDATE users SET deletion_requested_at = NULL WHERE id = $1", [ctx.user.id]);
    throw err;
  }
  if (soleAdmin) {
    await query(ctx.deps.query, "UPDATE companies SET deletion_requested_at = $2 WHERE id = $1", [String(membership?.company_id), ctx.now.toISOString()]);
  }
  await revokeAll(ctx, ctx.user.id);
  return new Response(null, { status: 204, headers: { "x-request-id": ctx.rid } });
}

export async function me(ctx: Ctx): Promise<Response> {
  return data(200, {
    id: ctx.user.id,
    displayName: ctx.user.displayName,
    locale: ctx.user.locale,
    createdAt: ts(ctx.user.createdAt),
    accountType: ctx.user.accountType,
    companyId: ctx.user.companyId,
    companyRole: ctx.user.companyRole,
  }, ctx.rid);
}

export { requireUuid };
