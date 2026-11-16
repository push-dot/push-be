// Isolate-local TTL cache for reads that do not depend on the caller (posting counts, facets, skill counts).
// Each Workers isolate keeps its own copy, so a busy deploy runs one query per isolate per minute instead of one per request.
// Only resolved values are stored: a promise shared between requests would break Workers' per-request I/O.

export const READ_CACHE_TTL_MS = 60_000;
export const READ_CACHE_MAX_ENTRIES = 128;
const MAX_KEY_LENGTH = 1024;

export class ReadCache {
  private readonly entries = new Map<string, { value: unknown; expiresAt: number }>();

  get size(): number {
    return this.entries.size;
  }

  async get<T>(key: string, nowMs: number, load: () => Promise<T>): Promise<T> {
    if (key.length > MAX_KEY_LENGTH) return load();
    const hit = this.entries.get(key);
    if (hit && hit.expiresAt > nowMs) return hit.value as T;
    const value = await load();
    this.store(key, value, nowMs);
    return value;
  }

  clear(): void {
    this.entries.clear();
  }

  private store(key: string, value: unknown, nowMs: number): void {
    this.entries.delete(key);
    if (this.entries.size >= READ_CACHE_MAX_ENTRIES) this.sweep(nowMs);
    this.entries.set(key, { value, expiresAt: nowMs + READ_CACHE_TTL_MS });
  }

  private sweep(nowMs: number): void {
    for (const [key, entry] of this.entries) if (entry.expiresAt <= nowMs) this.entries.delete(key);
    if (this.entries.size < READ_CACHE_MAX_ENTRIES) return;
    const oldest = this.entries.keys().next().value;
    if (oldest !== undefined) this.entries.delete(oldest);
  }
}
