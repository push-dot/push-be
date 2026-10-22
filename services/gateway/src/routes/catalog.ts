import { pyJson } from "../time.ts";
import type { Deps, FrontEnv } from "../types.ts";
import { jobSitesBody, listModels, validProvider } from "../models.ts";
import { JOB_SITES_CACHE_URL, modelCacheUrl } from "../middleware/cache.ts";
import { cacheOf, putCache } from "../middleware/cache.ts";
import { conditional, fieldError, flag, sha256Hex } from "../http.ts";
import { interpretAuth, rememberBag, revalidateAuth, requireUser, tokenContext } from "../middleware/auth.ts";
import { AUTH_RATE_SQL, rateParams } from "../middleware/ratelimit.ts";

export async function aiModels(request: Request, env: FrontEnv, deps: Deps, url: URL, rid: string, limits: { user: number; public: number; windowMs: number }, now: () => Date): Promise<Response> {
  const provider = url.searchParams.get("provider") || "";
  const ctx = await tokenContext(request, env, deps, rid, limits, now);
  if (ctx instanceof Response) return ctx;
  if (provider && !validProvider(provider)) return fieldError("provider", "unsupported provider", rid);
  const authHash = await sha256Hex((request.headers.get("authorization") || "").slice(7));
  const cache = cacheOf(deps);
  const ttl = Math.max(1, Number(env.MODEL_CACHE_TTL || "600") || 600);
  const cacheControl = `private, max-age=${ttl}`;
  const cacheReq = new Request(modelCacheUrl(authHash, provider));
  const hit = await cache.match(cacheReq);
  if (hit) {
    const user = ctx.user ?? await requireUser(request, env, deps, rid, limits, now);
    if (user instanceof Response) return user;
    return conditional(await hit.text(), request, rid, cacheControl);
  }
  if (ctx.dev) {
    const user = ctx.user ?? await requireUser(request, env, deps, rid, limits, now);
    if (user instanceof Response) return user;
  } else if (!ctx.user && ctx.revalidate) {
    const user = await revalidateAuth(ctx, env, deps, rid);
    if (user instanceof Response) return user;
  } else if (!ctx.user) {
    try {
      const rows = await deps.query(AUTH_RATE_SQL, rateParams(ctx.hash, ctx.moment, limits.user, ctx.batch, ctx.release));
      const authed = interpretAuth(rows, ctx.moment, limits.user, limits.windowMs, ctx.cacheKey, true, rid, deps, rememberBag(ctx, env));
      if (authed instanceof Response) return authed;
    } catch {
      const user = await requireUser(request, env, deps, rid, limits, now);
      if (user instanceof Response) return user;
    }
  }
  const body = {
    data: listModels({
      provider,
      managedAi: flag(env.MANAGED_AI),
      managedGo: flag(env.MANAGED_GO),
    }),
  };
  const text = pyJson(body);
  await putCache(cache, cacheReq, new Response(text, {
    headers: { "content-type": "application/json", "cache-control": cacheControl },
  }));
  return conditional(text, request, rid, cacheControl);
}

export async function jobSites(request: Request, env: FrontEnv, deps: Deps, rid: string, limits: { user: number; public: number; windowMs: number }, now: () => Date): Promise<Response> {
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
