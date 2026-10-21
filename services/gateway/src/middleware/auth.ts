/**
 * Access-token checks and the quota lease taken before an authenticated read.
 */

import { formatJsonTimestamp } from "../time.ts";
import type { CachedUser } from "./cache.ts";
import { clampTtl } from "./cache.ts";
import type { Deps, FrontEnv } from "../types.ts";
import type { User } from "../types.ts";
import { codedError, errorResponse, sha256Hex } from "../http.ts";
import {
  acceptGrant, allow, allowShared, AUTH_RATE_SQL, AUTH_SQL, isolate, leases,
  nextBatch, rateParams, readCap, releaseExpired, remoteHits, spendLease, tsText, windowOf,
} from "./ratelimit.ts";

function authTtlMs(env: FrontEnv): number {
  // Cross-isolate revocation is bounded by this TTL. Logout on the isolate
  // that handled it drops the entry immediately.
  return clampTtl(env.AUTH_CACHE_TTL, 5, 5) * 1000;
}
function rememberAuth(hash: string, user: User, expiresAtMs: number, nowMs: number, ttlMs: number): void {
  if (!hash || ttlMs <= 0) return;
  const cached: CachedUser = {
    id: user.id,
    displayName: user.displayName,
    locale: user.locale,
    createdAt: user.createdAt,
    accountType: user.accountType,
    companyId: user.companyId,
    companyRole: user.companyRole,
    expiresAtMs,
  };
  isolate.putAuth(hash, cached, nowMs, ttlMs);
}

export function interpretAuth(
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
function userFromCached(cached: CachedUser): User {
  return {
    id: cached.id,
    displayName: cached.displayName,
    locale: cached.locale,
    createdAt: cached.createdAt,
    accountType: cached.accountType,
    companyId: cached.companyId,
    companyRole: cached.companyRole,
  };
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
export async function tokenContext(request: Request, env: FrontEnv, deps: Deps, rid: string, limits: { user: number }, now: () => Date): Promise<TokenCtx | Response> {
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
    // Take the unit before the auth read awaits, so the return timer keeps
    // it on the counter for this request.
    spendLease(cacheKey, moment.getTime(), deps);
    return { dev: false, hash, moment, cacheKey, revalidate: true, batch: 1, release: 0 };
  }
  return {
    dev: false, hash, moment, cacheKey,
    batch: nextBatch(lease, moment.getTime(), release),
    release,
  };
}

export async function revalidateAuth(ctx: TokenCtx, env: FrontEnv, deps: Deps, rid: string): Promise<User | Response> {
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
  rememberAuth(ctx.hash, user, expires, ctx.moment.getTime(), authTtlMs(env));
  return user;
}

export function rememberBag(ctx: TokenCtx, env: FrontEnv): { hash: string; ttlMs: number } {
  return { hash: ctx.hash, ttlMs: authTtlMs(env) };
}

export async function requireUser(request: Request, env: FrontEnv, deps: Deps, rid: string, limits: { user: number; windowMs: number }, now: () => Date): Promise<User | Response> {
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
async function resolveDevUser(env: FrontEnv, deps: Deps): Promise<User | null> {
  const rows = await deps.query(
    "SELECT u.id, u.display_name, u.locale, " + tsText("u.created_at") + " AS created_at, u.is_employer, m.company_id, m.role AS company_role FROM users u LEFT JOIN company_members m ON m.user_id = u.id WHERE u.id = $1::uuid",
    [env.DEV_USER_ID || ""],
  );
  if (!rows.length) {
    throw Object.assign(new Error("dev user not seeded"), { status: 401, code: "UNAUTHENTICATED" });
  }
  return userFrom(rows[0]);
}

const employerFlag = (value: unknown): boolean =>
  value === true || value === "t" || value === "true" || value === 1;

const textOrNull = (value: unknown): string | null =>
  value == null || value === "" ? null : String(value);

export function userFrom(row: Record<string, unknown>): User {
  return {
    id: String(row.id),
    displayName: String(row.display_name ?? ""),
    locale: String(row.locale ?? "ko"),
    createdAt: formatJsonTimestamp(row.created_at),
    accountType: employerFlag(row.is_employer) ? "EMPLOYER" : "PERSONAL",
    companyId: textOrNull(row.company_id),
    companyRole: textOrNull(row.company_role),
  };
}
