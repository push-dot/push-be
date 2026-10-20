import { query, one } from "../db.ts";
import { HttpError, data, randomToken, requireUuid, sha256Hex } from "../http.ts";
import { verifyPkce } from "../crypto.ts";
import { ts } from "../page.ts";
import { cancelSubscriptions } from "./billing.ts";
import type { Ctx, UserRow } from "../types.ts";

const ACCESS_TTL = 900;
const REFRESH_MS = 30 * 24 * 60 * 60 * 1000;
const STATE_MS = 10 * 60 * 1000;
const EXCHANGE_MS = 60 * 1000;
const CALLBACKS = new Set(["push://auth/callback", "http://localhost:5173/auth/callback"]);

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
  };
}

export async function resolveUser(ctx: Omit<Ctx, "user">, token: string): Promise<UserRow> {
  const env = ctx.env;
  if (env.APP_ENV === "development" && env.DEV_AUTH_TOKEN && token === env.DEV_AUTH_TOKEN) {
    const id = env.DEV_USER_ID || "";
    const row = await one(ctx.deps.query, "SELECT id, display_name, locale, plan, subscription_status, stripe_customer_id, period_ends_at, created_at FROM users WHERE id = $1", [id]);
    if (!row) throw new HttpError(401, "UNAUTHENTICATED", "dev user not seeded");
    return userFrom(row);
  }
  const hash = await sha256Hex(token);
  const row = await one(ctx.deps.query,
    "SELECT u.id, u.display_name, u.locale, u.plan, u.subscription_status, u.stripe_customer_id, u.period_ends_at, u.created_at, t.expires_at AS token_expires_at FROM access_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = $1",
    [hash]);
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
    user: { id: user.id, displayName: user.displayName, locale: user.locale },
  };
}

async function issue(ctx: Ctx, userId: string): Promise<Record<string, unknown>> {
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
  const row = await one(ctx.deps.query, "SELECT id, display_name, locale, plan, subscription_status, stripe_customer_id, period_ends_at, created_at FROM users WHERE id = $1", [userId]);
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
  const cfg = providerCfg(ctx.env, provider);
  const method = ctx.url.searchParams.get("codeChallengeMethod") || "";
  const challenge = ctx.url.searchParams.get("codeChallenge") || "";
  const redirect = ctx.url.searchParams.get("redirectUri") || "";
  if (method !== "S256") throw new HttpError(400, "VALIDATION_ERROR", "must be S256", { field: "codeChallengeMethod" });
  if (!challenge) throw new HttpError(400, "VALIDATION_ERROR", "required", { field: "codeChallenge" });
  if (!CALLBACKS.has(redirect)) throw new HttpError(400, "VALIDATION_ERROR", "not allowed", { field: "redirectUri" });
  const state = randomToken();
  const callback = new URL(ctx.request.url).origin + "/api/v1/auth/" + provider + "/callback";
  const expires = new Date(ctx.now.getTime() + STATE_MS);
  await query(ctx.deps.query,
    "INSERT INTO oauth_states (state, provider, code_challenge, redirect_uri, final_uri, expires_at, created_at, user_id, purpose) VALUES ($1,$2,$3,$4,$5,$6,$7,NULL,'LOGIN')",
    [state, provider, challenge, callback, redirect, expires.toISOString(), ctx.now.toISOString()]);
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
    "SELECT state, provider, code_challenge, redirect_uri, final_uri, expires_at FROM oauth_states WHERE state = $1",
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
  let subject = "";
  let name = "";
  try {
    // GitHub's API rejects requests without a User-Agent (403); Workers' fetch sends none by default.
    const ident = await fetchImpl(cfg.user, {
      headers: { authorization: "Bearer " + access, accept: "application/json", "user-agent": "push-be" },
    });
    if (!ident.ok) throw new Error("identity");
    const body = await ident.json() as { sub?: string; id?: string | number; name?: string; login?: string; email?: string };
    subject = body.sub || (body.id != null ? String(body.id) : "");
    if (!subject) throw new Error("subject");
    name = body.name || body.login || body.email || "user";
  } catch {
    throw new HttpError(502, "PROVIDER_ERROR", "provider identity fetch failed");
  }
  const exchange = randomToken();
  const expires = new Date(ctx.now.getTime() + EXCHANGE_MS).toISOString();
  const userId = crypto.randomUUID();
  await query(ctx.deps.query,
    "WITH upsert AS (INSERT INTO users (id, provider, provider_subject, display_name, locale, created_at) VALUES ($1,$2,$3,$4,'ko',$5) ON CONFLICT (provider, provider_subject) DO NOTHING RETURNING id), existing AS (UPDATE users SET deletion_requested_at = NULL WHERE provider = $2 AND provider_subject = $3 RETURNING id) INSERT INTO exchange_codes (code, user_id, code_challenge, expires_at, used_at, created_at) SELECT $6, COALESCE((SELECT id FROM upsert), (SELECT id FROM existing)), $7, $8, NULL, $5",
    [userId, provider, subject, name, ctx.now.toISOString(), exchange, String(rec.code_challenge), expires]);
  const finalUri = String(rec.final_uri || "push://auth/callback");
  return new Response(null, {
    status: 302,
    headers: { location: finalUri + "?code=" + encodeURIComponent(exchange), "x-request-id": ctx.rid },
  });
}

export async function exchange(ctx: Ctx): Promise<Response> {
  const body = await readJson(ctx.request);
  const code = requireString(body, "code");
  const verifier = requireString(body, "codeVerifier");
  const rec = await one(ctx.deps.query,
    "SELECT code, user_id, code_challenge, expires_at, used_at FROM exchange_codes WHERE code = $1",
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
  return data(200, await issue(ctx, String(rec.user_id)), ctx.rid);
}

async function revokeAll(ctx: Ctx, userId: string): Promise<void> {
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
export async function deleteAccount(ctx: Ctx): Promise<Response> {
  await cancelSubscriptions(ctx);
  await query(ctx.deps.query, "UPDATE users SET deletion_requested_at = $2 WHERE id = $1", [ctx.user.id, ctx.now.toISOString()]);
  await revokeAll(ctx, ctx.user.id);
  return new Response(null, { status: 204, headers: { "x-request-id": ctx.rid } });
}

export async function me(ctx: Ctx): Promise<Response> {
  return data(200, {
    id: ctx.user.id,
    displayName: ctx.user.displayName,
    locale: ctx.user.locale,
    createdAt: ts(ctx.user.createdAt),
  }, ctx.rid);
}

export { requireUuid };
