import { HttpError } from "../http.ts";
import type { CoreEnv } from "../types.ts";

const TTL_SEC = 900;
const text = new TextEncoder();

export type PendingSignup = {
  v: 1;
  provider: string;
  subject: string;
  email: string | null;
  exp: number;
};

const b64url = (bytes: Uint8Array): string => {
  let bin = "";
  for (const byte of bytes) bin += String.fromCharCode(byte);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
};

const fromB64url = (value: string): Uint8Array | null => {
  const pad = value.length % 4 === 0 ? "" : "=".repeat(4 - (value.length % 4));
  const raw = value.replaceAll("-", "+").replaceAll("_", "/") + pad;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) return null;
  try {
    const bin = atob(raw);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
};

const secretOf = (env: CoreEnv): string => {
  const secret = env.PENDING_SIGNUP_SECRET?.trim() ?? "";
  if (!secret) throw new HttpError(503, "NOT_CONFIGURED", "pending signup is not configured");
  return secret;
};

const macOf = async (secret: string, payload: Uint8Array): Promise<Uint8Array> => {
  const key = await crypto.subtle.importKey("raw", text.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const copy = new ArrayBuffer(payload.byteLength);
  new Uint8Array(copy).set(payload);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, copy));
};

const same = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
};

export const signPendingSignup = async (
  env: CoreEnv,
  input: { provider: string; subject: string; email: string | null },
  now: Date,
): Promise<{ token: string; expiresIn: number }> => {
  const body: PendingSignup = {
    v: 1,
    provider: input.provider,
    subject: input.subject,
    email: input.email,
    exp: Math.floor(now.getTime() / 1000) + TTL_SEC,
  };
  const payload = text.encode(JSON.stringify(body));
  const mac = await macOf(secretOf(env), payload);
  return { token: `${b64url(payload)}.${b64url(mac)}`, expiresIn: TTL_SEC };
};

export const readPendingSignup = async (env: CoreEnv, token: string, now: Date): Promise<PendingSignup> => {
  const secret = secretOf(env);
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new HttpError(401, "UNAUTHENTICATED", "invalid pending signup");
  const payload = fromB64url(parts[0]);
  const mac = fromB64url(parts[1]);
  if (!payload || !mac) throw new HttpError(401, "UNAUTHENTICATED", "invalid pending signup");
  if (!same(mac, await macOf(secret, payload))) throw new HttpError(401, "UNAUTHENTICATED", "invalid pending signup");
  let body: PendingSignup;
  try {
    body = JSON.parse(new TextDecoder().decode(payload)) as PendingSignup;
  } catch {
    throw new HttpError(401, "UNAUTHENTICATED", "invalid pending signup");
  }
  if (body?.v !== 1 || typeof body.provider !== "string" || !body.provider || body.provider === "phone") {
    throw new HttpError(401, "UNAUTHENTICATED", "invalid pending signup");
  }
  if (typeof body.subject !== "string" || !body.subject || typeof body.exp !== "number") {
    throw new HttpError(401, "UNAUTHENTICATED", "invalid pending signup");
  }
  if (body.email != null && typeof body.email !== "string") throw new HttpError(401, "UNAUTHENTICATED", "invalid pending signup");
  if (body.exp * 1000 <= now.getTime()) throw new HttpError(401, "TOKEN_EXPIRED", "pending signup expired");
  return { v: 1, provider: body.provider, subject: body.subject, email: body.email ?? null, exp: body.exp };
};
