import assert from "node:assert/strict";
import { test } from "node:test";

import { memoryCache } from "../src/middleware/cache.ts";
import { handle, resetLimits, type Deps, type FrontEnv, type Query } from "../src/handler.ts";

const USER_A = "aaaaaaaa-0000-4000-8000-00000000000a";
const USER_B = "bbbbbbbb-0000-4000-8000-00000000000b";
const NOW = new Date("2026-10-18T00:00:00Z");
const MODELS = "https://push-be.example/api/v1/ai/models";
const TOKENS: Record<string, string> = { [USER_A]: "tok-a", [USER_B]: "tok-b" };
const GO = "opencode-go/deepseek-v4.1-flash";

type Seen = Array<[string, unknown[]]>;

const noBinding = { async fetch(): Promise<Response> { throw new Error("binding should not be called"); } };

const env = (extra: Partial<FrontEnv> = {}): FrontEnv => ({
  DATABASE_URL: "postgres://example",
  API: noBinding,
  CORE: noBinding,
  APP_ENV: "production",
  MANAGED_AI: "1",
  MANAGED_GO: "0",
  ...extra,
});

const deps = (query: Query, cache = memoryCache(() => NOW.getTime())): Deps => ({
  query, cache, sleep: async () => {}, now: () => NOW,
});

const userRow = (id: string): Record<string, unknown> => ({
  id, display_name: "U", locale: "ko", created_at: "2026-01-02T03:04:05Z", expires_at: "2099-01-01T00:00:00Z",
});

const isShared = (sql: string) => sql.startsWith("WITH auth");
const isAuthOnly = (sql: string) => sql.includes("FROM access_tokens") && !isShared(sql);
const isKeys = (sql: string) => sql.startsWith("SELECT EXISTS(SELECT 1 FROM ai_keys");

type Fake = {
  user: string;
  hasKey?: boolean;
  shared?: "throw" | "none";
  keys?: "throw";
};

// Key lookups answer per user id, so a query bound to the wrong user returns the wrong catalog.
const OWNS_KEY = new Set([USER_A]);

const fake = (seen: Seen, f: Fake): Query => async (sql, params = []) => {
  seen.push([sql, params]);
  if (isShared(sql)) {
    if (f.shared === "throw") throw new Error("db down");
    if (f.shared === "none") return [];
    return [{ ...userRow(f.user), hits: 1, has: OWNS_KEY.has(f.user) }];
  }
  if (isAuthOnly(sql)) return [userRow(f.user)];
  if (sql.includes("FROM users u LEFT JOIN company_members")) return [userRow(f.user)];
  if (sql.includes("rate_limits")) return [{ hits: 1 }];
  if (isKeys(sql)) {
    if (f.keys === "throw") throw new Error("db down");
    return [{ has: OWNS_KEY.has(String(params[0])) }];
  }
  return [];
};

const get = (user: string, query = "", headers: Record<string, string> = {}): Request =>
  new Request(MODELS + query, { headers: { authorization: `Bearer ${TOKENS[user]}`, ...headers } });

const goAvailable = async (res: Response): Promise<boolean> => {
  assert.equal(res.status, 200);
  const body = await res.json() as { data: { model: string; available: boolean }[] };
  return body.data.find((m) => m.model === GO)!.available;
};

const keyParams = (seen: Seen) => seen.filter(([sql]) => isKeys(sql)).map(([, p]) => p);

const warm = async (user: string, e: FrontEnv): Promise<void> => {
  const res = await handle(new Request("https://push-be.example/api/v1/auth/me", {
    headers: { authorization: `Bearer ${TOKENS[user]}` },
  }), e, deps(async () => [{ ...userRow(user), hits: 1, granted: 4 }]));
  assert.equal(res.status, 200);
};


test("models needs a bearer token and validates credentialMode", async () => {
  resetLimits();
  const seen: Seen = [];
  const anon = await handle(new Request(MODELS), env(), deps(fake(seen, { user: USER_A })));
  assert.equal(anon.status, 401);
  assert.equal(seen.length, 0);
  const bad = await handle(get(USER_A, "?credentialMode=FREE"), env(), deps(fake(seen, { user: USER_A })));
  assert.equal(bad.status, 400);
  assert.equal((await bad.json() as { error: { details: { field: string } } }).error.details.field, "credentialMode");
});

test("an unknown token on the shared read is 401 and nothing is cached", async () => {
  resetLimits();
  const cache = memoryCache(() => NOW.getTime());
  const res = await handle(get(USER_A), env(), deps(fake([], { user: USER_A, shared: "none" }), cache));
  assert.equal(res.status, 401);
  let queried = 0;
  const again = await handle(get(USER_A), env(), deps(async () => { queried += 1; return []; }, cache));
  assert.equal(again.status, 401);
  assert.ok(queried > 0, "a miss must re-check the token");
});

test("MANAGED mode authenticates but never reads ai_keys", async () => {
  resetLimits();
  const seen: Seen = [];
  const res = await handle(get(USER_A, "?credentialMode=MANAGED"), env(), deps(fake(seen, { user: USER_A })));
  assert.equal(await goAvailable(res), false);
  assert.equal(keyParams(seen).length, 0);
  assert.ok(seen.some(([sql]) => isShared(sql)));

  resetLimits();
  const denied = await handle(get(USER_A, "?credentialMode=MANAGED"), env(), deps(fake([], { user: USER_A, shared: "none" })));
  assert.equal(denied.status, 401);
});

test("a lease without cached auth revalidates, and a revoked token is 401", async () => {
  resetLimits();
  const e = env({ AUTH_CACHE_TTL: "0" });
  await warm(USER_A, e);
  const seen: Seen = [];
  assert.equal((await handle(get(USER_A), e, deps(fake(seen, { user: USER_A })))).status, 200);
  assert.ok(seen.some(([sql]) => isAuthOnly(sql)));

  resetLimits();
  await warm(USER_A, e);
  const revoked = await handle(get(USER_A), e, deps(async (sql) => {
    if (isAuthOnly(sql)) return [];
    throw new Error("must not read keys for a revoked token");
  }));
  assert.equal(revoked.status, 401);
});

test("a cache hit with a revoked token is 401, not the cached body", async () => {
  resetLimits();
  const cache = memoryCache(() => NOW.getTime());
  assert.equal((await handle(get(USER_A), env(), deps(fake([], { user: USER_A }), cache))).status, 200);
  resetLimits();
  const revoked = await handle(get(USER_A), env(), deps(fake([], { user: USER_A, shared: "none" }), cache));
  assert.equal(revoked.status, 401);
});

test("job sites needs a token and serves a public cached body", async () => {
  resetLimits();
  const anon = await handle(new Request("https://push-be.example/api/v1/integrations/job-sites"), env(), deps(fake([], { user: USER_A })));
  assert.equal(anon.status, 401);
  const res = await handle(new Request("https://push-be.example/api/v1/integrations/job-sites", {
    headers: { authorization: "Bearer tok-a" },
  }), env({ JOB_SITES_CACHE_TTL: "junk" }), deps(fake([], { user: USER_A })));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "public, max-age=3600");
  const body = await res.json() as { data: { provider: string }[] };
  assert.deepEqual(body.data.map((s) => s.provider), ["WANTED", "JUMPIT", "JOBKOREA"]);
});
