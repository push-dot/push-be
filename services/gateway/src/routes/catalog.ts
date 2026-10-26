import { pyJson } from "../time.ts";
import type { Deps, FrontEnv } from "../types.ts";
import { jobSitesBody, listModels, validProvider } from "../models.ts";
import { conditional, fieldError, flag } from "../http.ts";
import { requireUser } from "../middleware/auth.ts";

// Both bodies are static per deployment and built in memory. A Cache API
// lookup cost more than building them and kept serving the previous
// MANAGED_* flags after a deploy.

export async function aiModels(request: Request, env: FrontEnv, deps: Deps, url: URL, rid: string, limits: { user: number; public: number; windowMs: number }, now: () => Date): Promise<Response> {
  const user = await requireUser(request, env, deps, rid, limits, now);
  if (user instanceof Response) return user;
  const provider = url.searchParams.get("provider") || "";
  if (provider && !validProvider(provider)) return fieldError("provider", "unsupported provider", rid);
  const ttl = Math.max(1, Number(env.MODEL_CACHE_TTL || "600") || 600);
  const text = pyJson({
    data: listModels({ provider, managedAi: flag(env.MANAGED_AI), managedGo: flag(env.MANAGED_GO) }),
  });
  return conditional(text, request, rid, `private, max-age=${ttl}`);
}

export async function jobSites(request: Request, env: FrontEnv, deps: Deps, rid: string, limits: { user: number; public: number; windowMs: number }, now: () => Date): Promise<Response> {
  const user = await requireUser(request, env, deps, rid, limits, now);
  if (user instanceof Response) return user;
  const ttl = Math.max(1, Number(env.JOB_SITES_CACHE_TTL || "3600") || 3600);
  return conditional(pyJson(jobSitesBody()), request, rid, `public, max-age=${ttl}`);
}
