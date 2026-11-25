import type { Deps, FrontEnv } from "../types.ts";
import { errorResponse, secretEquals, sha256Hex } from "../http.ts";
import { clearLease, isolate } from "../middleware/ratelimit.ts";

// Largest body a worker accepts (core sources, python evidence uploads).
const MAX_BODY_BYTES = 20 << 20;
// Headers the AI worker sends to core with the internal secret. x-push-approval names the card core checks.
const ACT_AS = new Set(["x-push-internal-secret", "x-push-act-as", "x-push-company", "x-push-approval"]);

/** True when the request carries the AI worker's act-as secret. Only core routes may keep the act-as headers. */
export async function isInternalCall(request: Request, env: FrontEnv): Promise<boolean> {
  return secretEquals(request.headers.get("x-push-internal-secret") || "", (env.INTERNAL_API_SECRET || "").trim());
}

// Inits whose streamed body went over the cap; relay answers those with 413 instead of 500.
const overCap = new WeakSet<RequestInit>();

// content-length is the client's word, and a chunked body has none: count the bytes as they stream through.
function capped(body: ReadableStream<Uint8Array>, init: RequestInit): ReadableStream<Uint8Array> {
  let seen = 0;
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen <= MAX_BODY_BYTES) {return controller.enqueue(chunk);}
      overCap.add(init);
      controller.error(new Error("request body too large"));
    },
  }));
}

// Every x-push-* header is the gateway's or a worker's to set. A client copy is dropped.
function forwardInit(request: Request, rid: string, keepActAs: boolean): (RequestInit & { headers: Headers }) | Response {
  if (Number(request.headers.get("content-length")) > MAX_BODY_BYTES) {
    return errorResponse(413, "PAYLOAD_TOO_LARGE", "request body too large", rid);
  }
  const headers = new Headers(request.headers);
  for (const name of Array.from(headers.keys())) {
    if (name.startsWith("x-push-") && !(keepActAs && ACT_AS.has(name))) {headers.delete(name);}
  }
  headers.delete("host");
  headers.set("x-request-id", rid);
  const init: RequestInit & { headers: Headers; duplex?: "half" } = { method: request.method, headers, redirect: "manual" };
  if (request.method !== "GET" && request.method !== "HEAD" && request.body) {
    // Stream the body through; buffering it let one upload exhaust isolate memory.
    init.body = capped(request.body, init);
    init.duplex = "half";
  }
  return init;
}

async function relay(send: () => Promise<Response>, rid: string, init: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await send();
  } catch {
    if (overCap.has(init)) {return errorResponse(413, "PAYLOAD_TOO_LARGE", "request body too large", rid);}
    return errorResponse(500, "INTERNAL", "internal error", rid);
  }
  const out = new Headers(res.headers);
  if (!out.has("x-request-id")) {out.set("x-request-id", rid);}
  if (res.status === 204 || res.status === 205 || res.status === 304) {
    return new Response(null, { status: res.status, headers: out });
  }
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out });
}

export async function proxy(request: Request, binding: FrontEnv["CORE"] | undefined, rid: string, keepActAs = false): Promise<Response> {
  if (!binding) {return errorResponse(500, "INTERNAL", "internal error", rid);}
  const init = forwardInit(request, rid, keepActAs);
  if (init instanceof Response) {return init;}
  return relay(() => binding.fetch(new Request(request.url, init)), rid, init);
}

// The origin is the public VPS, so it must be HTTPS and carry the shared secret. push-bot (AI_ORIGIN) unless the caller names push-agent's.
export async function proxyPython(request: Request, env: FrontEnv, deps: Deps, rid: string, target = env.AI_ORIGIN): Promise<Response> {
  const origin = (target || "").trim().replace(/\/$/, "");
  const secret = (env.AI_SHARED_SECRET || "").trim();
  if (!origin) {return errorResponse(500, "NOT_CONFIGURED", "ai origin is not configured", rid);}
  if (!secret || !origin.startsWith("https://")) {return errorResponse(500, "INTERNAL", "internal error", rid);}
  const init = forwardInit(request, rid, false);
  if (init instanceof Response) {return init;}
  const outHeaders = init.headers;
  outHeaders.set("x-push-ai-secret", secret);
  outHeaders.delete("x-forwarded-for");
  const edgeIp = request.headers.get("cf-connecting-ip")?.trim();
  if (edgeIp) {outHeaders.set("cf-connecting-ip", edgeIp);}
  else {outHeaders.delete("cf-connecting-ip");}
  const url = new URL(request.url);
  const fetchImpl = deps.fetch ?? fetch;
  // Concatenate, never resolve: ownerOf already refused `//`, so the host stays the origin's.
  return relay(() => fetchImpl(origin + url.pathname + url.search, init), rid, init);
}
export async function invalidateAfterWrite(request: Request, path: string, deps: Deps): Promise<void> {
  if (path !== "/api/v1/auth/logout" && path !== "/api/v1/auth/refresh") {return;}
  const authz = request.headers.get("authorization") || "";
  if (!authz.startsWith("Bearer ")) {return;}
  const token = authz.slice(7);
  if (!token) {return;}
  try {
    const hash = await sha256Hex(token);
    isolate.dropAuth(hash);
    await clearLease(deps, hash);
  } catch {
    return;
  }
}
