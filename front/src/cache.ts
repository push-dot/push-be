/** Cache API wrapper. Tests pass an in-memory store; production uses `caches.default`. */

export interface CacheStore {
  match(req: Request): Promise<Response | undefined>;
  put(req: Request, res: Response): Promise<void>;
  delete(req: Request): Promise<boolean>;
}

export function memoryCache(now: () => number = Date.now): CacheStore {
  const map = new Map<string, { body: string; expires: number }>();
  return {
    async match(req) {
      const hit = map.get(req.url);
      if (!hit) return undefined;
      if (hit.expires <= now()) {
        map.delete(req.url);
        return undefined;
      }
      return new Response(hit.body, { headers: { "content-type": "application/json" } });
    },
    async put(req, res) {
      const cc = res.headers.get("cache-control") || "";
      const m = cc.match(/max-age=(\d+)/);
      const ttl = (m ? Number(m[1]) : 600) * 1000;
      map.set(req.url, { body: await res.clone().text(), expires: now() + ttl });
    },
    async delete(req) {
      return map.delete(req.url);
    },
  };
}

export function workersCache(): CacheStore | undefined {
  const cache = (globalThis as { caches?: { default?: Cache } }).caches?.default;
  if (!cache) return undefined;
  return {
    async match(req) {
      const hit = await cache.match(req);
      return hit ?? undefined;
    },
    async put(req, res) {
      await cache.put(req, res);
    },
    async delete(req) {
      return cache.delete(req);
    },
  };
}

const PROVIDERS = ["", "OPENAI", "OPENROUTER", "CLAUDE", "GEMINI", "GROK"];
const MODES = ["", "MANAGED", "BYOK"];

export function modelCacheUrl(authHash: string, provider: string, credMode: string): string {
  const q = new URLSearchParams();
  if (provider) q.set("provider", provider);
  if (credMode) q.set("credentialMode", credMode);
  const qs = q.toString();
  return `https://cache.push-be.internal/v1/models/${authHash}${qs ? "?" + qs : ""}`;
}

export function modelCacheUrls(authHash: string): string[] {
  const urls: string[] = [];
  for (const provider of PROVIDERS) {
    for (const mode of MODES) urls.push(modelCacheUrl(authHash, provider, mode));
  }
  return urls;
}

export const JOB_SITES_CACHE_URL = "https://cache.push-be.internal/v1/job-sites";
