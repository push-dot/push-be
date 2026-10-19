import type { Deps } from "../types.ts";
import { clientIp, errorResponse, jsonResponse } from "../http.ts";
import { allowShared } from "../middleware/ratelimit.ts";

export async function health(
  request: Request, deps: Deps, path: string, rid: string,
  limits: { user: number; public: number; windowMs: number }, now: () => Date,
): Promise<Response> {
  if (path === "/api/v1/healthz" && !await allowShared(
    deps, "ip", clientIp(request), limits.public, limits.windowMs, now(),
  )) {
    return errorResponse(429, "RATE_LIMITED", "too many requests", rid);
  }
  return jsonResponse(200, { data: { status: "ok" } }, rid);
}
