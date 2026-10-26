import assert from "node:assert/strict";
import { test } from "node:test";

import { handle, resetLimits, type Deps, type FrontEnv, type Query } from "../src/handler.ts";

const USER_A = "aaaaaaaa-0000-4000-8000-00000000000a";
const NOW = new Date("2026-10-18T00:00:00Z");
const MODELS = "https://push-be.example/api/v1/ai/models";
const TOKENS: Record<string, string> = { [USER_A]: "tok-a" };
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

const deps = (query: Query): Deps => ({
  query, sleep: async () => {}, now: () => NOW,
});

const userRow = (id: string): Record<string, unknown> => ({
  id, display_name: "U", locale: "ko", created_at: "2026-01-02T03:04:05Z", expires_at: "2099-01-01T00:00:00Z",
});

const isShared = (sql: string) => sql.startsWith("WITH auth");
const isAuthOnly = (sql: string) => sql.includes("FROM access_tokens") && !isShared(sql);

type Fake = {
  user: string;
  shared?: "throw" | "none";
};

const fake = (seen: Seen, f: Fake): Query => async (sql, params = []) => {
  seen.push([sql, params]);
  if (isShared(sql)) {
    if (f.shared === "throw") throw new Error("db down");
    if (f.shared === "none") return [];
    return [{ ...userRow(f.user), hits: 1 }];
  }
  if (isAuthOnly(sql)) return [userRow(f.user)];
  if (sql.includes("FROM users u LEFT JOIN company_members")) return [userRow(f.user)];
  if (sql.includes("rate_limits")) return [{ hits: 1 }];
  return [];
};

const get = (user: string, query = "", headers: Record<string, string> = {}): Request =>
  new Request(MODELS + query, { headers: { authorization: `Bearer ${TOKENS[user]}`, ...headers } });

const goAvailable = async (res: Response): Promise<boolean> => {
  assert.equal(res.status, 200);
  const body = await res.json() as { data: { model: string; available: boolean }[] };
  return body.data.find((m) => m.model === GO)!.available;
};


const warm = async (user: string, e: FrontEnv): Promise<void> => {
  const res = await handle(new Request("https://push-be.example/api/v1/auth/me", {
    headers: { authorization: `Bearer ${TOKENS[user]}` },
  }), e, deps(async () => [{ ...userRow(user), hits: 1, granted: 4 }]));
  assert.equal(res.status, 200);
};


test("models needs a bearer token and validates provider", async () => {
  resetLimits();
  const seen: Seen = [];
  const anon = await handle(new Request(MODELS), env(), deps(fake(seen, { user: USER_A })));
  assert.equal(anon.status, 401);
  assert.equal(seen.length, 0);
  const bad = await handle(get(USER_A, "?provider=NOPE"), env(), deps(fake(seen, { user: USER_A })));
  assert.equal(bad.status, 400);
  assert.equal((await bad.json() as { error: { details: { field: string } } }).error.details.field, "provider");
});

test("a leftover credentialMode param is ignored", async () => {
  resetLimits();
  const res = await handle(get(USER_A, "?credentialMode=BYOK"), env(), deps(fake([], { user: USER_A })));
  assert.equal(await goAvailable(res), false);
});

test("an unknown token on the shared read is 401 and the next request re-checks it", async () => {
  resetLimits();
  const res = await handle(get(USER_A), env(), deps(fake([], { user: USER_A, shared: "none" })));
  assert.equal(res.status, 401);
  let queried = 0;
  const again = await handle(get(USER_A), env(), deps(async () => { queried += 1; return []; }));
  assert.equal(again.status, 401);
  assert.ok(queried > 0, "a miss must re-check the token");
});

test("availability follows MANAGED_AI and MANAGED_GO only", async () => {
  resetLimits();
  const seen: Seen = [];
  const res = await handle(get(USER_A), env(), deps(fake(seen, { user: USER_A })));
  assert.equal(await goAvailable(res), false);
  assert.ok(seen.some(([sql]) => isShared(sql)));
  assert.equal(seen.some(([sql]) => sql.includes("ai_keys")), false);

  resetLimits();
  assert.equal(await goAvailable(await handle(get(USER_A), env({ MANAGED_GO: "1" }), deps(fake([], { user: USER_A })))), true);

  resetLimits();
  const denied = await handle(get(USER_A), env(), deps(fake([], { user: USER_A, shared: "none" })));
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

test("a revoked token is 401 after an earlier success", async () => {
  resetLimits();
  assert.equal((await handle(get(USER_A), env(), deps(fake([], { user: USER_A })))).status, 200);
  resetLimits();
  const revoked = await handle(get(USER_A), env(), deps(fake([], { user: USER_A, shared: "none" })));
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
