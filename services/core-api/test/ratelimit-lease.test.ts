import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import type { Query } from "../src/db.ts";
import { handle } from "../src/handler.ts";
import { allow, resetLimits } from "../src/ratelimit.ts";

const T0 = Date.parse("2026-10-22T00:00:30Z");

beforeEach(() => resetLimits());

// The table behind rate_limits: the lease upsert adds $4 while the bucket is under $3.
const counter = () => {
  const hits = new Map<string, number>();
  const writes: unknown[][] = [];
  const query: Query = async (_sql, params = []) => {
    writes.push(params);
    const [bucket, , limit, size] = params as [string, number, number, number];
    const now = hits.get(bucket);
    if (now !== undefined && now >= limit) return { rows: [], rowCount: 0 };
    hits.set(bucket, (now ?? 0) + size);
    return { rows: [{ hits: hits.get(bucket) }], rowCount: 1 };
  };
  return { hits, writes, query };
};

test("a lease of ten writes once per ten requests", async () => {
  const db = counter();
  for (let i = 0; i < 25; i++) assert.equal(await allow(db.query, "user", "u1", 600, T0, 10), true);
  assert.equal(db.writes.length, 3);
  assert.equal(db.writes[0][3], 10);
});

test("a lease never admits more than the limit, in one isolate or across two", async () => {
  const db = counter();
  let admitted = 0;
  for (let i = 0; i < 40; i++) if (await allow(db.query, "user", "u1", 25, T0, 10)) admitted++;
  assert.equal(admitted, 25);
  resetLimits();
  for (let i = 0; i < 40; i++) if (await allow(db.query, "user", "u1", 25, T0, 10)) admitted++;
  assert.equal(admitted, 25, "a second isolate gets nothing once the bucket is full");
});

test("two isolates share one budget; unused lease tokens are the only loss", async () => {
  const db = counter();
  let admitted = 0;
  for (let i = 0; i < 15; i++) if (await allow(db.query, "user", "u1", 25, T0, 10)) admitted++;
  resetLimits();
  for (let i = 0; i < 40; i++) if (await allow(db.query, "user", "u1", 25, T0, 10)) admitted++;
  assert.equal(admitted, 20, "5 tokens stay stranded in the first isolate's lease");
  assert.equal(admitted <= 25, true);
});

test("the next minute starts a new budget", async () => {
  const db = counter();
  for (let i = 0; i < 30; i++) await allow(db.query, "user", "u1", 25, T0, 10);
  assert.equal(await allow(db.query, "user", "u1", 25, T0, 10), false);
  assert.equal(await allow(db.query, "user", "u1", 25, T0 + 60_000, 10), true);
});

test("a limit below the chunk leases only the limit", async () => {
  const db = counter();
  let admitted = 0;
  for (let i = 0; i < 10; i++) if (await allow(db.query, "user", "u1", 3, T0, 10)) admitted++;
  assert.equal(admitted, 3);
  assert.equal(db.writes[0][3], 3);
});

test("concurrent requests share one lease write", async () => {
  const db = counter();
  const results = await Promise.all(Array.from({ length: 8 }, () => allow(db.query, "user", "u1", 600, T0, 10)));
  assert.deepEqual(results, Array(8).fill(true));
  assert.equal(db.writes.length, 1);
});

test("a failing database falls back to the isolate window and counts the limit", async () => {
  const query: Query = async () => { throw new Error("connection reset"); };
  assert.equal(await allow(query, "user", "u1", 2, T0, 10), true);
  assert.equal(await allow(query, "user", "u1", 2, T0 + 1_000, 10), true);
  assert.equal(await allow(query, "user", "u1", 2, T0 + 2_000, 10), false);
});

test("the default chunk of one is still a write per request", async () => {
  const db = counter();
  const query: Query = async (sql, params) => {
    db.writes.push(params ?? []);
    return { rows: [{ hits: 1 }], rowCount: 1 };
  };
  for (let i = 0; i < 5; i++) await allow(query, "user", "u1", 600, T0);
  assert.equal(db.writes.length, 5);
});

const USER = "12345678-1234-5678-1234-567812345678";

test("an authenticated user's requests write the rate_limits row once per lease, not once per request", async () => {
  const sql: string[] = [];
  const query: Query = async (text) => {
    sql.push(text);
    if (text.includes("rate_limits")) return { rows: [{ hits: 10 }], rowCount: 1 };
    if (text.includes("access_tokens")) {
      return { rows: [{ id: USER, display_name: "Ada", locale: "ko", plan: "FREE", subscription_status: "NONE", created_at: "2026-01-02T03:04:05Z", token_expires_at: "2099-01-01T00:00:00Z" }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  const send = () => handle(
    new Request("https://core.example/api/v1/bots", { headers: { authorization: "Bearer secret-token" } }),
    { APP_ENV: "production", MANAGED_AI: "1" },
    { query, now: () => new Date(T0) },
  );
  for (let i = 0; i < 25; i++) await send();
  assert.equal(sql.filter((text) => text.includes("rate_limits")).length, 3);
});
