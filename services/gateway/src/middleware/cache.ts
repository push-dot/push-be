/** Isolate-local auth cache, the TTL clamp, and the ETag hash. */

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
  accountType: "PERSONAL" | "EMPLOYER";
  companyId: string | null;
  companyRole: string | null;
  email: string;
  provider: string;
  plan: string;
  expiresAtMs: number;
}

const AUTH_CAP = 1024;

export interface IsolateCache {
  reset(): void;
  getAuth(hash: string, nowMs: number): CachedUser | undefined;
  putAuth(hash: string, user: CachedUser, nowMs: number, ttlMs: number): void;
  dropAuth(hash: string): void;
}

export function createIsolateCache(): IsolateCache {
  const auth = new Map<string, { user: CachedUser; until: number }>();

  return {
    reset() {
      auth.clear();
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
      while (auth.size > AUTH_CAP) {
        const oldest = auth.keys().next().value;
        if (oldest === undefined) return;
        auth.delete(oldest);
      }
    },
    dropAuth(hash) {
      auth.delete(hash);
    },
  };
}
