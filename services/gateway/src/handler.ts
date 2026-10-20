/**
 * Gateway request pipeline.
 *
 * index.ts is the Worker entry. This module dispatches the routes the
 * gateway answers itself and forwards everything else to the Python worker.
 */

import type { Deps, FrontEnv } from "./types.ts";
import { errorResponse, preflight, requestIdOf, withCors } from "./http.ts";
import { authMe } from "./routes/auth.ts";
import { health } from "./routes/health.ts";
import { listConversations, listMessages, streamActive } from "./routes/conversations.ts";
import { aiModels, jobSites } from "./routes/catalog.ts";
import { ownerOf } from "./routes/owner.ts";
import { invalidateAfterWrite, proxy, proxyPython, purgeModelCache } from "./routes/proxy.ts";

export type { Deps, FrontEnv, Query } from "./types.ts";
export { releaseExpired, resetLimits } from "./middleware/ratelimit.ts";

export async function handle(request: Request, env: FrontEnv, deps: Deps): Promise<Response> {
  const rid = requestIdOf(request);
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return errorResponse(400, "VALIDATION_ERROR", "invalid url", rid);
  }
  const path = url.pathname;
  if (request.method === "OPTIONS") {
    try {
      return withCors(request, preflight(request));
    } catch {
      return errorResponse(500, "INTERNAL", "internal error", rid);
    }
  }
  try {
    const response = await route(request, env, deps, url, path, rid);
    return withCors(request, response);
  } catch {
    try {
      return withCors(request, errorResponse(500, "INTERNAL", "internal error", rid));
    } catch {
      return errorResponse(500, "INTERNAL", "internal error", rid);
    }
  }
}

async function route(request: Request, env: FrontEnv, deps: Deps, url: URL, path: string, rid: string): Promise<Response> {
  const now = deps.now ?? (() => new Date());
  const limits = deps.limits ?? { user: 600, public: 60, windowMs: 60_000 };
  if (request.method === "GET" && (path === "/healthz" || path === "/api/v1/healthz")) {
    return health(request, deps, path, rid, limits, now);
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
  const owner = ownerOf(request.method, path);
  if (owner === "deny") return errorResponse(404, "NOT_FOUND", "resource not found", rid);
  const proxied = owner === "core"
    ? await proxy(request, env.CORE, rid)
    : await proxyPython(request, env, deps, rid);
  if (proxied.status >= 200 && proxied.status < 300) {
    const method = request.method;
    if (method === "POST" || method === "PATCH" || method === "PUT" || method === "DELETE") {
      await invalidateAfterWrite(request, path, deps);
    }
  }
  if (request.method === "PUT" || request.method === "DELETE") {
    if (/^\/api\/v1\/ai\/keys\/[^/]+$/.test(path) && proxied.status >= 200 && proxied.status < 300) {
      await purgeModelCache(request, deps);
    }
  }
  return proxied;
}
