import type { Deps, FrontEnv } from "../types.ts";
import { errorResponse, sha256Hex } from "../http.ts";
import { clearLease, isolate } from "../middleware/ratelimit.ts";

const stripInternal = (headers: Headers): void => {
  headers.delete("x-push-internal");
  headers.delete("x-push-internal-secret");
  headers.delete("x-push-act-as");
  headers.delete("x-push-company");
};

/** True when the request carries the AI worker's act-as secret. Only core routes may keep the act-as headers. */
export async function isInternalCall(request: Request, env: FrontEnv): Promise<boolean> {
  const want = (env.INTERNAL_API_SECRET || "").trim();
  const got = request.headers.get("x-push-internal-secret") || "";
  if (!want || !got) return false;
  return (await sha256Hex(got)) === (await sha256Hex(want));
}

export async function proxy(request: Request, binding: FrontEnv["API"] | undefined, rid: string, keepInternal = false): Promise<Response> {
  if (!binding) return errorResponse(500, "INTERNAL", "internal error", rid);
  const headers = new Headers(request.headers);
  if (keepInternal) headers.delete("x-push-internal");
  else stripInternal(headers);
  headers.set("x-request-id", rid);
  const init: RequestInit = { method: request.method, headers, redirect: "manual" };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = await request.arrayBuffer();
  }
  const forwarded = new Request(request.url, init);
  let res: Response;
  try {
    res = await binding.fetch(forwarded);
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

function copied(res: Response, rid: string): Response {
  const out = new Headers(res.headers);
  if (!out.has("x-request-id")) out.set("x-request-id", rid);
  if (res.status === 204 || res.status === 205 || res.status === 304) {
    return new Response(null, { status: res.status, headers: out });
  }
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out });
}

/**
 * AI routes stay on the `API` service binding unless AI_ORIGIN is set.
 * The origin is the Hostinger VPS. The shared secret is not logged.
 */
export async function proxyPython(request: Request, env: FrontEnv, deps: Deps, rid: string): Promise<Response> {
  const origin = (env.AI_ORIGIN || "").trim().replace(/\/$/, "");
  if (!origin) return proxy(request, env.API, rid);
  const url = new URL(request.url);
  const headers = new Headers(request.headers);
  stripInternal(headers);
  headers.delete("host");
  headers.set("x-request-id", rid);
  const secret = (env.AI_SHARED_SECRET || "").trim();
  if (secret) headers.set("x-push-ai-secret", secret);
  const init: RequestInit = { method: request.method, headers, redirect: "manual" };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = await request.arrayBuffer();
  }
  const fetchImpl = deps.fetch ?? fetch;
  let res: Response;
  try {
    res = await fetchImpl(origin + url.pathname + url.search, init);
  } catch {
    return errorResponse(500, "INTERNAL", "internal error", rid);
  }
  return copied(res, rid);
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
