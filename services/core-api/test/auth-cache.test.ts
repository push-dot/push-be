import assert from "node:assert/strict";
import { test } from "node:test";

import { AUTH_CACHE_TTL_MS, AuthCache } from "../src/auth-cache.ts";
import type { Query } from "../src/db.ts";
import { resolveUser } from "../src/routes/auth.ts";
import type { Ctx } from "../src/types.ts";

const NOW = Date.parse("2026-11-26T00:00:00Z");
const EXPIRES = new Date(NOW + 900_000).toISOString();

const userRow = (id: string) => ({
  id, display_name: "n", locale: "ko", plan: "FREE", subscription_status: "NONE", stripe_customer_id: null,
  period_ends_at: null, created_at: "2026-01-01T00:00:00Z", is_employer: false, email: "", provider: "",
  company_id: null, company_role: null, token_expires_at: EXPIRES,
});

const ctxOf = (method: string, cache: AuthCache, nowMs: number, counter: { n: number }, id = "u1") => {
  const query: Query = async () => {
    counter.n += 1;
    return { rows: [userRow(id)], rowCount: 1 };
  };
  return {
    request: new Request("https://core.test/api/v1/me", { method }),
    env: {},
    deps: { query, authCache: cache },
    rid: "r",
    url: new URL("https://core.test/api/v1/me"),
    now: new Date(nowMs),
  } as unknown as Omit<Ctx, "user">;
};

test("GET reuses the user inside the TTL and reloads after it", async () => {
  const cache = new AuthCache();
  const counter = { n: 0 };
  await resolveUser(ctxOf("GET", cache, NOW, counter), "tok");
  await resolveUser(ctxOf("GET", cache, NOW + AUTH_CACHE_TTL_MS - 1, counter), "tok");
  assert.equal(counter.n, 1);
  await resolveUser(ctxOf("GET", cache, NOW + AUTH_CACHE_TTL_MS, counter), "tok");
  assert.equal(counter.n, 2);
});

test("a write always reads fresh and drops the caller's cached tokens", async () => {
  const cache = new AuthCache();
  const counter = { n: 0 };
  await resolveUser(ctxOf("GET", cache, NOW, counter), "tok");
  await resolveUser(ctxOf("POST", cache, NOW, counter), "tok");
  assert.equal(counter.n, 2);
  assert.equal(cache.size, 0);
  await resolveUser(ctxOf("GET", cache, NOW, counter), "tok");
  assert.equal(counter.n, 3);
});

test("an entry never outlives its token", () => {
  const cache = new AuthCache();
  const user = { id: "u1" } as Parameters<AuthCache["put"]>[1];
  cache.put("h", user, NOW, NOW + 1000);
  assert.equal(cache.get("h", NOW + 999)?.id, "u1");
  assert.equal(cache.get("h", NOW + 1000), undefined);
  cache.put("gone", user, NOW, NOW);
  assert.equal(cache.size, 0);
});

test("without a cache every request queries", async () => {
  const counter = { n: 0 };
  const ctx = ctxOf("GET", new AuthCache(), NOW, counter);
  const bare = { ...ctx, deps: { query: ctx.deps.query } } as Omit<Ctx, "user">;
  await resolveUser(bare, "tok");
  await resolveUser(bare, "tok");
  assert.equal(counter.n, 2);
});
