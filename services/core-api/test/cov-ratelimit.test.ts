import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { beforeEach, test } from "node:test";

import type { Query } from "../src/db.ts";
import { handle, type Deps } from "../src/handler.ts";
import { allow, resetLimits } from "../src/ratelimit.ts";

type Call = { sql: string; params: unknown[] };
const T0 = Date.parse("2026-10-22T00:00:30Z");
const WINDOW = Math.floor(T0 / 60_000);

const recording = (reply: (params: unknown[]) => Record<string, unknown>[] | Error) => {
  const seen: Call[] = [];
  const query: Query = async (sql, params = []) => {
    seen.push({ sql, params });
    const r = reply(params);
    if (r instanceof Error) throw r;
    return { rows: r, rowCount: r.length };
  };
  return { seen, query };
};

beforeEach(() => resetLimits());

test("ratelimit: consumes a per-minute bucket in postgres", async () => {
  const db = recording(() => [{ hits: 3 }]);
  assert.equal(await allow(db.query, "user", "u1", 3, T0), true);
  assert.equal(db.seen.length, 1);
  assert.match(db.seen[0].sql, /^INSERT INTO rate_limits .* ON CONFLICT \(bucket\) DO UPDATE SET hits = rate_limits\.hits \+ 1 WHERE rate_limits\.hits < \$3 RETURNING hits$/);
  assert.deepEqual(db.seen[0].params, [`user:u1:${WINDOW}`, WINDOW * 60 + 120, 3]);
});

test("ratelimit: an empty key shares the 'unknown' bucket", async () => {
  const db = recording(() => [{ hits: 1 }]);
  await allow(db.query, "ip", "", 60, T0);
  assert.equal(db.seen[0].params[0], `ip:unknown:${WINDOW}`);
});

test("ratelimit: denies when the capped upsert returns no row or exceeds the limit", async () => {
  assert.equal(await allow(recording(() => []).query, "user", "u1", 5, T0), false);
  assert.equal(await allow(recording(() => [{ hits: "6" }]).query, "user", "u1", 5, T0), false);
  assert.equal(await allow(recording(() => [{ hits: "5" }]).query, "user", "u1", 5, T0), true);
});

for (const [name, err] of [
  ["missing table (42P01)", Object.assign(new Error("boom"), { code: "42P01" })],
  ["missing table by message", new Error('relation "rate_limits" does not exist')],
  ["any other database error", new Error("connection reset")],
] as const) {
  test(`ratelimit: falls back to the in-memory window on ${name}`, async () => {
    const db = recording(() => err);
    assert.equal(await allow(db.query, "user", "u1", 2, T0), true);
    assert.equal(await allow(db.query, "user", "u1", 2, T0 + 1_000), true);
    assert.equal(await allow(db.query, "user", "u1", 2, T0 + 2_000), false);
    assert.equal(await allow(db.query, "user", "u2", 2, T0 + 2_000), true, "other keys keep their own budget");
    assert.equal(await allow(db.query, "user", "u1", 2, T0 + 60_000), true, "next minute window starts fresh");
    resetLimits();
    assert.equal(await allow(db.query, "user", "u1", 2, T0 + 3_000), true, "reset clears the memory window");
  });
}

test("ratelimit: a non-Error rejection still falls back to memory", async () => {
  const query: Query = async () => { throw "rate_limits does not exist"; };
  assert.equal(await allow(query, "user", "u1", 1, T0), true);
  assert.equal(await allow(query, "user", "u1", 1, T0), false);
});

const authRow = { id: "12345678-1234-5678-1234-567812345678", display_name: "Ada", locale: "ko", plan: "FREE", created_at: "2026-01-01T00:00:00Z", token_expires_at: "2099-01-01T00:00:00Z" };

test("ratelimit: an authenticated caller over budget gets 429 RATE_LIMITED before routing", async () => {
  const seen: Call[] = [];
  const query: Query = async (sql, params = []) => {
    seen.push({ sql, params });
    if (sql.includes("access_tokens")) return { rows: params[0] === createHash("sha256").update("t").digest("hex") ? [authRow] : [], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
  const res = await handle(new Request("https://core.example/api/v1/jobs", { headers: { authorization: "Bearer t", "x-request-id": "rid-1" } }),
    { APP_ENV: "production" }, { query, now: () => new Date(T0) });
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("x-request-id"), "rid-1");
  const body = await res.json() as { error: { code: string } };
  assert.equal(body.error.code, "RATE_LIMITED");
  const limit = seen.find((c) => c.sql.includes("rate_limits"))!;
  assert.deepEqual(limit.params, [`user:${authRow.id}:${WINDOW}`, WINDOW * 60 + 120, 600]);
  assert.equal(seen.some((c) => c.sql.includes("FROM jobs")), false);
});

test("ratelimit: public routes are limited per client ip at 60/min", async () => {
  const seen: Call[] = [];
  const query: Query = async (sql, params = []) => {
    seen.push({ sql, params });
    return { rows: [], rowCount: 0 };
  };
  const res = await handle(new Request("https://core.example/api/v1/auth/refresh", {
    method: "POST", headers: { "x-forwarded-for": "203.0.113.9, 10.0.0.1" }, body: "{}",
  }), { APP_ENV: "production" }, { query, now: () => new Date(T0) });
  assert.equal(res.status, 429);
  assert.deepEqual(seen.find((c) => c.sql.includes("rate_limits"))?.params, [`ip:203.0.113.9:${WINDOW}`, WINDOW * 60 + 120, 60]);
});

test("the in-memory rate limit fallback drops buckets from past minutes", async () => {
  const { allow, memoryBuckets, resetLimits } = await import("../src/ratelimit.ts");
  resetLimits();
  const down: Deps["query"] = async () => { throw new Error("connection reset"); };
  const t0 = Date.parse("2026-10-22T00:00:30Z");
  for (let i = 0; i < 50; i += 1) await allow(down, "ip", "10.0.0." + i, 60, t0);
  assert.equal(memoryBuckets(), 50);
  await allow(down, "ip", "10.0.0.1", 60, t0 + 60_000);
  assert.equal(memoryBuckets(), 1);
});
