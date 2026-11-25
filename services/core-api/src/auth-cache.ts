// Isolate-local cache of access token hash -> user, mirroring the gateway's AUTH_CACHE_TTL (5 s).
// Only GET requests read it. Any other request resolves fresh and drops the caller's entries, so logout, refresh,
// account deletion and profile or company changes take effect at once on this isolate and within the TTL on others.

import type { UserRow } from "./types.ts";

export const AUTH_CACHE_TTL_MS = 5000;
const AUTH_CACHE_MAX_ENTRIES = 1024;

export class AuthCache {
  private readonly entries = new Map<string, { user: UserRow; until: number }>();

  get size(): number {
    return this.entries.size;
  }

  get(hash: string, nowMs: number): UserRow | undefined {
    const hit = this.entries.get(hash);
    if (!hit) {return undefined;}
    if (hit.until <= nowMs) {
      this.entries.delete(hash);
      return undefined;
    }
    return hit.user;
  }

  put(hash: string, user: UserRow, nowMs: number, tokenExpiresMs: number): void {
    const until = Math.min(nowMs + AUTH_CACHE_TTL_MS, tokenExpiresMs);
    if (!(until > nowMs)) {return;}
    this.entries.delete(hash);
    this.entries.set(hash, { user, until });
    while (this.entries.size > AUTH_CACHE_MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) {return;}
      this.entries.delete(oldest);
    }
  }

  dropUser(userId: string): void {
    for (const [hash, entry] of this.entries) {if (entry.user.id === userId) {this.entries.delete(hash);}}
  }

  clear(): void {
    this.entries.clear();
  }
}
