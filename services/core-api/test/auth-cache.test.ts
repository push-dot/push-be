import assert from "node:assert/strict";
import { test } from "node:test";

import { AUTH_CACHE_TTL_MS, AuthCache } from "../src/auth-cache.ts";
import { resolveUser } from "../src/routes/auth.ts";
import { ctxFor } from "../test-support/recorder.ts";
import type { Deps } from "../src/handler.ts";

const NOW = Date.parse("2026-11-26T00:00:00Z");
const EXPIRES = new Date(NOW + 900_000).toISOString();

const userRow = (id: string) => ({
  id, display_name: "n", locale: "ko", plan: "FREE", subscription_status: "NONE", stripe_customer_id: null,
  period_ends_at: null, created_at: "2026-01-01T00:00:00Z", is_employer: false, email: "", provider: "",
  company_id: null, company_role: null, token_expires_at: EXPIRES,
});

const ctxOf = (method: string, cache: AuthCache | undefined, nowMs: number, counter: { n: number }, id = "u1") => {
  const query: Deps["query"] = async () => {
    counter.n += 1;
    return { rows: [userRow(id)], rowCount: 1 };
  };
  return { ...ctxFor({ query, authCache: cache }, {}, new Date(nowMs)), request: new Request("https://core.test/api/v1/me", { method }) };
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
  const { user } = ctxFor({ query: async () => ({ rows: [], rowCount: 0 }) });
  cache.put("h", user, NOW, NOW + 1000);
  assert.equal(cache.get("h", NOW + 999)?.id, user.id);
  assert.equal(cache.get("h", NOW + 1000), undefined);
  cache.put("gone", user, NOW, NOW);
  assert.equal(cache.size, 0);
});

test("without a cache every request queries", async () => {
  const counter = { n: 0 };
  await resolveUser(ctxOf("GET", undefined, NOW, counter), "tok");
  await resolveUser(ctxOf("GET", undefined, NOW, counter), "tok");
  assert.equal(counter.n, 2);
});
