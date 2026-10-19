import type { Deps, FrontEnv } from "../types.ts";
import { errorResponse, sha256Hex } from "../http.ts";
import { cacheOf, modelCacheUrls } from "../middleware/cache.ts";
import { clearLease, isolate } from "../middleware/ratelimit.ts";

export async function proxy(request: Request, env: FrontEnv, rid: string): Promise<Response> {
  if (!env.API) return errorResponse(500, "INTERNAL", "internal error", rid);
  const headers = new Headers(request.headers);
  headers.set("x-request-id", rid);
  const init: RequestInit = { method: request.method, headers, redirect: "manual" };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = await request.arrayBuffer();
  }
  const forwarded = new Request(request.url, init);
  let res: Response;
  try {
    res = await env.API.fetch(forwarded);
  } catch {
    return errorResponse(500, "INTERNAL", "internal error", rid);
  }
  const out = new Headers(res.headers);
  if (!out.has("x-request-id")) out.set("x-request-id", rid);
  if (res.status === 204 || res.status === 205 || res.status === 304) {
    return new Response(null, { status: res.status, headers: out });
  }
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out });
}
export async function invalidateAfterWrite(request: Request, path: string, deps: Deps): Promise<void> {
  if (path !== "/api/v1/auth/logout" && path !== "/api/v1/auth/refresh") return;
  const authz = request.headers.get("authorization") || "";
  if (!authz.startsWith("Bearer ")) return;
  const token = authz.slice(7);
  if (!token) return;
  try {
    const hash = await sha256Hex(token);
    isolate.dropAuth(hash);
    await clearLease(deps, hash);
  } catch {
    return;
  }
}
export async function purgeModelCache(request: Request, deps: Deps): Promise<void> {
  try {
    const token = (request.headers.get("authorization") || "").replace(/^Bearer /, "");
    if (!token) return;
    const cache = cacheOf(deps);
    const hash = await sha256Hex(token);
    await Promise.all(modelCacheUrls(hash).map((url) => cache.delete(new Request(url))));
  } catch {
    // Invalidation is best-effort. The TTL still expires the entry.
  }
}
