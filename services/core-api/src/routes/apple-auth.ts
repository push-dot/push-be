import { HttpError, sha256Hex } from "../http.ts";
import { one, query } from "../db.ts";
import type { Ctx } from "../types.ts";
import { completePersonalSocial } from "./auth.ts";

const CALLBACK_PATH = "/api/v1/auth/apple/callback";
const NATIVE_PATH = "/api/v1/auth/apple/native";
const APPLE_ISS = "https://appleid.apple.com";
const APPLE_KEYS = "https://appleid.apple.com/auth/keys";
const APPLE_TOKEN = "https://appleid.apple.com/auth/token";
const SKEW_MS = 60_000;
const SECRET_S = 300;

type Jwk = JsonWebKey & { kid?: string };

let jwksCache: { at: number; keys: Jwk[] } | null = null;

export const resetAppleJwks = (): void => {
  jwksCache = null;
};

const copyBytes = (bytes: Uint8Array): ArrayBuffer => {
  const buf = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buf).set(bytes);
  return buf;
};

const bytesToB64url = (bytes: Uint8Array): string => {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
};

const b64urlToBytes = (value: string): Uint8Array => {
  const pad = value.length % 4 === 0 ? "" : "=".repeat(4 - (value.length % 4));
  const bin = atob(value.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

const pemToDer = (pem: string): ArrayBuffer => {
  const body = pem.replace(/\\n/g, "\n").replace(/-----[^-]+-----/g, "").replace(/\s/g, "");
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return copyBytes(out);
};

const signEs256 = async (pem: string, kid: string, payload: Record<string, unknown>): Promise<string> => {
  const key = await crypto.subtle.importKey("pkcs8", pemToDer(pem), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const header = bytesToB64url(new TextEncoder().encode(JSON.stringify({ alg: "ES256", kid })));
  const body = bytesToB64url(new TextEncoder().encode(JSON.stringify(payload)));
  const input = `${header}.${body}`;
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(input)));
  return `${input}.${bytesToB64url(sig)}`;
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

const requireText = (body: Record<string, unknown>, key: string): string => {
  const value = body[key];
  if (typeof value !== "string" || !value.trim()) throw new HttpError(400, "VALIDATION_ERROR", "required", { field: key });
  return value.trim();
};

const appleEnv = (ctx: Ctx): { clientId: string; teamId: string; keyId: string; privateKey: string } => {
  const clientId = ctx.env.APPLE_CLIENT_ID || "";
  const teamId = ctx.env.APPLE_TEAM_ID || "";
  const keyId = ctx.env.APPLE_KEY_ID || "";
  const privateKey = ctx.env.APPLE_PRIVATE_KEY || "";
  if (!clientId || !teamId || !keyId || !privateKey) {
    throw new HttpError(503, "NOT_CONFIGURED", "oauth provider apple is not configured");
  }
  return { clientId, teamId, keyId, privateKey };
};

const loadJwks = async (ctx: Ctx): Promise<Jwk[]> => {
  if (jwksCache && ctx.now.getTime() - jwksCache.at < 3_600_000) return jwksCache.keys;
  const fetchImpl = ctx.deps.fetch ?? fetch;
  let body: { keys?: Jwk[] };
  try {
    const res = await fetchImpl(APPLE_KEYS);
    if (!res.ok) throw new Error("status");
    body = await res.json() as { keys?: Jwk[] };
  } catch {
    throw new HttpError(502, "PROVIDER_ERROR", "apple jwks fetch failed");
  }
  if (!body.keys?.length) throw new HttpError(502, "PROVIDER_ERROR", "apple jwks fetch failed");
  jwksCache = { at: ctx.now.getTime(), keys: body.keys };
  return body.keys;
};

const verifyIdentity = async (
  ctx: Ctx,
  token: string,
  audience: string,
  nonce: string | null,
): Promise<{ sub: string; email: string | null; emailVerified: boolean }> => {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    throw new HttpError(401, "UNAUTHENTICATED", "invalid identity token");
  }
  let header: { alg?: string; kid?: string };
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[0]))) as { alg?: string; kid?: string };
  } catch {
    throw new HttpError(401, "UNAUTHENTICATED", "invalid identity token");
  }
  if (header.alg !== "ES256" || !header.kid) throw new HttpError(401, "UNAUTHENTICATED", "invalid identity token");
  const jwk = (await loadJwks(ctx)).find((key) => key.kid === header.kid);
  if (!jwk) throw new HttpError(401, "UNAUTHENTICATED", "invalid identity token");
  let ok = false;
  try {
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    ok = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      copyBytes(b64urlToBytes(parts[2])),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    );
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(401, "UNAUTHENTICATED", "invalid identity token");
  }
  if (!ok) throw new HttpError(401, "UNAUTHENTICATED", "invalid identity token");
  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[1]))) as Record<string, unknown>;
  } catch {
    throw new HttpError(401, "UNAUTHENTICATED", "invalid identity token");
  }
  if (claims.iss !== APPLE_ISS) throw new HttpError(401, "UNAUTHENTICATED", "invalid identity token");
  const aud = claims.aud;
  const audOk = aud === audience || (Array.isArray(aud) && aud.includes(audience));
  if (!audOk) throw new HttpError(401, "UNAUTHENTICATED", "invalid identity token");
  const exp = Number(claims.exp);
  if (!Number.isFinite(exp) || exp * 1000 + SKEW_MS < ctx.now.getTime()) {
    throw new HttpError(401, "TOKEN_EXPIRED", "identity token expired");
  }
  if (nonce != null) {
    const claim = typeof claims.nonce === "string" ? claims.nonce.toLowerCase() : "";
    if (claim !== await sha256Hex(nonce)) throw new HttpError(401, "UNAUTHENTICATED", "nonce mismatch");
  }
  const sub = typeof claims.sub === "string" ? claims.sub : "";
  if (!sub) throw new HttpError(401, "UNAUTHENTICATED", "invalid identity token");
  const email = typeof claims.email === "string" && claims.email.trim() ? claims.email.trim().toLowerCase() : null;
  const emailVerified = claims.email_verified === true || claims.email_verified === "true";
  return { sub, email, emailVerified };
};

const nameFrom = (raw: string | null): string => {
  if (!raw) return "";
  try {
    const body = JSON.parse(raw) as { name?: { firstName?: string; lastName?: string } };
    const first = body.name?.firstName;
    const last = body.name?.lastName;
    return [first, last].filter((part) => typeof part === "string" && part.trim()).join(" ").trim();
  } catch {
    return "";
  }
};

const clientSecret = async (ctx: Ctx, cfg: { clientId: string; teamId: string; keyId: string; privateKey: string }): Promise<string> => {
  const iat = Math.floor(ctx.now.getTime() / 1000);
  try {
    return await signEs256(cfg.privateKey, cfg.keyId, {
      iss: cfg.teamId,
      iat,
      exp: iat + SECRET_S,
      aud: APPLE_ISS,
      sub: cfg.clientId,
    });
  } catch {
    throw new HttpError(503, "NOT_CONFIGURED", "apple key is unreadable");
  }
};

export const appleCallback = async (ctx: Ctx): Promise<Response> => {
  const cfg = appleEnv(ctx);
  const form = new URLSearchParams(await ctx.request.text());
  const code = form.get("code") || "";
  const state = form.get("state") || "";
  if (!code || !state) throw new HttpError(401, "UNAUTHENTICATED", "invalid state");
  const rec = await one(ctx.deps.query,
    "DELETE FROM oauth_states WHERE state = $1 RETURNING state, provider, code_challenge, redirect_uri, final_uri, expires_at, account_type",
    [state]);
  if (!rec || String(rec.provider) !== "apple") throw new HttpError(401, "UNAUTHENTICATED", "invalid state");
  if (ctx.now.getTime() > Date.parse(String(rec.expires_at))) throw new HttpError(401, "UNAUTHENTICATED", "state expired");
  const secret = await clientSecret(ctx, cfg);
  const fetchImpl = ctx.deps.fetch ?? fetch;
  let idToken = "";
  try {
    const body = new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: secret,
      code,
      grant_type: "authorization_code",
      redirect_uri: String(rec.redirect_uri),
    });
    const tokenRes = await fetchImpl(APPLE_TOKEN, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    const tokenBody = await tokenRes.json() as { id_token?: string };
    if (!tokenRes.ok || !tokenBody.id_token) throw new Error("token");
    idToken = tokenBody.id_token;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(502, "PROVIDER_ERROR", "provider token exchange failed");
  }
  const identity = await verifyIdentity(ctx, idToken, cfg.clientId, null);
  const display = nameFrom(form.get("user")) || identity.email || "user";
  const codeValue = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  const expires = new Date(ctx.now.getTime() + 60_000).toISOString();
  await query(ctx.deps.query,
    "INSERT INTO exchange_codes (code, user_id, code_challenge, expires_at, used_at, created_at, provider, provider_subject, email, email_verified, display_name, account_type) VALUES ($1,$2,$3,$4,NULL,$5,$6,$7,$8,$9,$10,$11)",
    [codeValue, null, String(rec.code_challenge), expires, ctx.now.toISOString(), "apple", identity.sub, identity.email, identity.emailVerified, display, "PERSONAL"]);
  const finalUri = String(rec.final_uri || "push://auth/callback");
  return new Response(null, {
    status: 302,
    headers: { location: finalUri + "?code=" + encodeURIComponent(codeValue), "x-request-id": ctx.rid },
  });
};

export const appleNative = async (ctx: Ctx): Promise<Response> => {
  const bundleId = ctx.env.APPLE_BUNDLE_ID || "";
  if (!bundleId) throw new HttpError(503, "NOT_CONFIGURED", "oauth provider apple is not configured");
  const body = await readJson(ctx.request);
  const identityToken = requireText(body, "identityToken");
  const nonce = requireText(body, "nonce");
  const identity = await verifyIdentity(ctx, identityToken, bundleId, nonce);
  return completePersonalSocial(ctx, {
    provider: "apple",
    provider_subject: identity.sub,
    email: identity.email,
    email_verified: identity.emailVerified,
    display_name: "user",
    account_type: "PERSONAL",
  });
};

export const dispatchAppleAuth = async (ctx: Ctx, path: string): Promise<Response | null> => {
  if (ctx.request.method === "POST" && path === CALLBACK_PATH) return appleCallback(ctx);
  if (ctx.request.method === "POST" && path === NATIVE_PATH) return appleNative(ctx);
  return null;
};
