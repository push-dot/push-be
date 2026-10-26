import assert from "node:assert/strict";
import { test } from "node:test";

import type { Query } from "../src/db.ts";
import { HttpError, errorOf } from "../src/http.ts";
import { checkBackpressure } from "../src/jobs/backpressure.ts";
import { estimateMicro, queueDepthLimit, queueFor } from "../src/jobs/config.ts";
import { availableMicro, enqueueJob } from "../src/jobs/enqueue.ts";

const USER = "11111111-1111-4111-8111-111111111111";
const COMPANY = "22222222-2222-4222-8222-222222222222";

const scripted = (
  rowsFor: (sql: string, params: unknown[]) => Record<string, unknown> | null,
  calls: string[],
): Query => async (sql, params = []) => {
  calls.push(sql);
  const row = rowsFor(sql, params);
  return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
};

const funded = (calls: string[], balance: bigint): Query => scripted((sql, params) => {
  if (sql.includes("idempotency_key") && sql.includes("FROM ai_jobs")) return null;
  if (sql.includes("billing_ledger")) return { balance_after: balance.toString() };
  if (sql.includes("ai_usage")) return { settled: "0" };
  if (sql.includes("SUM") && sql.includes("credit_reservations")) return { reserved: "0" };
  if (sql.includes("INSERT INTO ai_jobs")) return { id: String(params[0]), queue: String(params[2]) };
  return null;
}, calls);

test("enqueue reserves credits, writes job and outbox in one transaction", async () => {
  const calls: string[] = [];
  const out = await enqueueJob(funded(calls, estimateMicro("chat", "FREE")), {
    type: "chat",
    userId: USER,
    plan: "FREE",
    payload: { text: "hi" },
  });
  assert.equal(out.queue, "q:chat");
  assert.match(out.jobId, /^[0-9a-f-]{36}$/);
  const writes = calls.filter((sql) => sql.includes("INSERT INTO") && !sql.includes("INSERT INTO billing_ledger"));
  assert.equal(writes.length, 1);
  assert.match(writes[0], /INSERT INTO ai_jobs/);
  assert.match(writes[0], /INSERT INTO credit_reservations/);
  assert.match(writes[0], /INSERT INTO outbox/);
  assert.equal(queueFor("chat", "FREE", "PERSONAL"), "q:chat");
});

test("enqueue routes employer PRO to q:chat:priority", async () => {
  const calls: string[] = [];
  const out = await enqueueJob(funded(calls, estimateMicro("employer_ai", "PRO")), {
    type: "employer_ai",
    userId: USER,
    companyId: COMPANY,
    plan: "PRO",
    payload: {},
  });
  assert.equal(out.queue, "q:chat:priority");
  assert.equal(queueFor("employer_ai", "PRO", "EMPLOYER"), "q:chat:priority");
});

test("enqueue rejects when reservation exceeds balance with 402 INSUFFICIENT_CREDITS", async () => {
  const calls: string[] = [];
  const need = estimateMicro("chat", "FREE");
  await assert.rejects(
    () => enqueueJob(funded(calls, need - 1n), {
      type: "chat",
      userId: USER,
      plan: "FREE",
      payload: {},
    }),
    (err: unknown) => {
      assert.ok(err instanceof HttpError);
      assert.equal(err.status, 402);
      assert.equal(err.code, "INSUFFICIENT_CREDITS");
      return true;
    },
  );
  assert.equal(calls.some((sql) => sql.includes("INSERT INTO ai_jobs")), false);
});

test("every AI job reserves credits", async () => {
  for (const type of ["chat", "employer_ai", "document", "fit"] as const) {
    const calls: string[] = [];
    await enqueueJob(funded(calls, 10_000_000n), {
      type, userId: USER, companyId: type === "employer_ai" ? COMPANY : undefined, plan: "PRO", payload: {},
    });
    assert.match(calls.find((sql) => sql.includes("INSERT INTO ai_jobs")) || "", /INSERT INTO credit_reservations/, type);
  }
});

test("same idempotencyKey returns the existing jobId", async () => {
  const calls: string[] = [];
  const tx = scripted((sql) => {
    if (sql.includes("idempotency_key") && sql.includes("FROM ai_jobs")) {
      return { id: "33333333-3333-4333-8333-333333333333", queue: "q:chat" };
    }
    return null;
  }, calls);
  const out = await enqueueJob(tx, {
    type: "chat",
    userId: USER,
    plan: "FREE",
    payload: {},
    idempotencyKey: "same-key",
  });
  assert.equal(out.jobId, "33333333-3333-4333-8333-333333333333");
  assert.equal(out.queue, "q:chat");
  assert.equal(calls.some((sql) => sql.includes("INSERT INTO")), false);
});

test("backpressure returns 429 QUEUE_BUSY with Retry-After over threshold for FREE but not ULTRA", async () => {
  const depth = queueDepthLimit("FREE") + 1;
  const db: Query = async () => ({ rows: [{ n: depth }], rowCount: 1 });
  const free = await checkBackpressure(db, "q:chat", "FREE");
  const ultra = await checkBackpressure(db, "q:chat", "ULTRA");
  assert.equal(free.ok, false);
  if (free.ok) return;
  assert.equal(ultra.ok, true);
  assert.equal(queueDepthLimit("ULTRA") > depth, true);
  const err = new HttpError(429, "QUEUE_BUSY", "queue is busy", { retryAfterSec: free.retryAfterSec });
  const res = errorOf(err, "rid");
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("retry-after"), String(free.retryAfterSec));
  const body = await res.json() as { error: { code: string } };
  assert.equal(body.error.code, "QUEUE_BUSY");
});

test("balance counts RESERVED without the 10-minute window", async () => {
  const calls: string[] = [];
  const tx = scripted((sql) => {
    assert.equal(sql.includes("10 minutes"), false);
    if (sql.includes("billing_ledger")) return { balance_after: "100" };
    if (sql.includes("ai_usage")) return { settled: "30" };
    if (sql.includes("credit_reservations")) return { reserved: "25" };
    return null;
  }, calls);
  assert.equal(await availableMicro(tx, USER), 45n);
  assert.equal(calls.some((sql) => sql.includes("RESERVED")), true);
  assert.equal(calls.some((sql) => sql.includes("SETTLED")), true);
});

test("enqueue grants the plan's monthly credits before reserving, so a new FREE user can chat", async () => {
  const calls: string[] = [];
  const grants: unknown[][] = [];
  let ledger: string | null = null;
  const q = scripted((sql, params) => {
    if (sql.includes("idempotency_key") && sql.includes("FROM ai_jobs")) return null;
    if (sql.includes("INSERT INTO billing_ledger")) {
      grants.push(params);
      ledger = String(params[2]);
      return null;
    }
    if (sql.includes("billing_ledger")) return ledger == null ? null : { balance_after: ledger };
    if (sql.includes("ai_usage")) return { settled: "0" };
    if (sql.includes("SUM") && sql.includes("credit_reservations")) return { reserved: "0" };
    if (sql.includes("INSERT INTO ai_jobs")) return { id: String(params[0]), queue: String(params[2]) };
    return null;
  }, calls);
  const out = await enqueueJob(q, {
    type: "chat", userId: USER, plan: "FREE", payload: {}, now: new Date("2026-10-22T00:00:00Z"),
  });
  assert.equal(out.queue, "q:chat");
  assert.equal(grants.length, 1);
  assert.equal(grants[0][1], USER);
  assert.equal(grants[0][2], 1_800_000);
  assert.equal(grants[0][3], "monthly:2026-10");
});

test("employer jobs grant the company plan", async () => {
  const calls: string[] = [];
  await enqueueJob(funded(calls, 10_000_000n), {
    type: "employer_ai", userId: USER, companyId: COMPANY, plan: "PRO", payload: {}, now: new Date("2026-10-22T00:00:00Z"),
  });
  assert.ok(calls.some((sql) => sql.includes("INSERT INTO billing_ledger") && sql.includes("company_id")));
});
