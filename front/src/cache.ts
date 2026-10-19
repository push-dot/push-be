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

/** Clamp a TTL in seconds. `0` disables that cache. */
export function clampTtl(raw: string | undefined, fallback: number, max: number): number {
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(Math.floor(n), max);
}

export function weakEtag(body: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < body.length; i++) {
    h ^= body.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `W/"${(h >>> 0).toString(16).padStart(8, "0")}"`;
}

export interface CachedUser {
  id: string;
  displayName: string;
  locale: string;
  createdAt: string;
  expiresAtMs: number;
}

export interface CachedRead {
  body: string;
  userId: string;
  expires: number;
}

const AUTH_CAP = 1024;
const READ_CAP = 256;

export interface IsolateCache {
  reset(): void;
  getAuth(hash: string, nowMs: number): CachedUser | undefined;
  putAuth(hash: string, user: CachedUser, nowMs: number, ttlMs: number): void;
  dropAuth(hash: string): void;
  generation(userId: string): number;
  bump(userId: string): void;
  markDirty(hash: string): void;
  isDirty(hash: string): boolean;
  clearDirty(hash: string): void;
  readKey(userId: string, url: string): string;
  getRead(key: string, nowMs: number): CachedRead | undefined;
  putRead(key: string, rec: CachedRead): void;
}

export function createIsolateCache(): IsolateCache {
  const auth = new Map<string, { user: CachedUser; until: number }>();
  const gen = new Map<string, number>();
  const dirty = new Set<string>();
  const reads = new Map<string, CachedRead>();

  function trim(map: Map<string, unknown>, cap: number): void {
    while (map.size > cap) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) return;
      map.delete(oldest);
    }
  }

  return {
    reset() {
      auth.clear();
      gen.clear();
      dirty.clear();
      reads.clear();
    },
    getAuth(hash, nowMs) {
      const hit = auth.get(hash);
      if (!hit) return undefined;
      if (hit.until <= nowMs) {
        auth.delete(hash);
        return undefined;
      }
      return hit.user;
    },
    putAuth(hash, user, nowMs, ttlMs) {
      auth.delete(hash);
      auth.set(hash, { user, until: nowMs + ttlMs });
      trim(auth, AUTH_CAP);
    },
    dropAuth(hash) {
      auth.delete(hash);
    },
    generation(userId) {
      return gen.get(userId) ?? 0;
    },
    bump(userId) {
      gen.set(userId, (gen.get(userId) ?? 0) + 1);
    },
    markDirty(hash) {
      dirty.add(hash);
    },
    isDirty(hash) {
      return dirty.has(hash);
    },
    clearDirty(hash) {
      dirty.delete(hash);
    },
    readKey(userId, url) {
      return `${userId}:${gen.get(userId) ?? 0}:${url}`;
    },
    getRead(key, nowMs) {
      const hit = reads.get(key);
      if (!hit) return undefined;
      if (hit.expires <= nowMs) {
        reads.delete(key);
        return undefined;
      }
      if (!key.startsWith(`${hit.userId}:`)) return undefined;
      return hit;
    },
    putRead(key, rec) {
      reads.delete(key);
      reads.set(key, rec);
      trim(reads, READ_CAP);
    },
  };
}
