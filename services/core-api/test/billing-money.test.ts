// Employer billing money rules on a real Postgres (BILLING_PG_URL, a migrated schema; CI test-db sets it).
// Stripe is a fake that keeps subscription state; event and object shapes follow the test-mode sandbox.
import assert from "node:assert/strict";
import { after, before, test, type TestContext } from "node:test";

import { hmacSha256Hex } from "../src/crypto.ts";
import type { Query } from "../src/db.ts";
import { handle, type CoreEnv, type Deps } from "../src/handler.ts";
import { resetLimits } from "../src/ratelimit.ts";
import { livePg, type LivePg } from "./parity/pg.ts";

const URL_ = process.env.BILLING_PG_URL;
const BASIC = "price_1UZkaG0iRL0sMmznUELNqD4P";
const PRO = "price_1UZkaI0iRL0sMmznnP3RfVxG";
const ULTRA = "price_1UZkaJ0iRL0sMmznX1goyOQq";
const PRICE = { BASIC, PRO, ULTRA } as const;
const CENTS = { BASIC: 2000, PRO: 10000, ULTRA: 20000 } as const;
const RECEIPT = "https://invoice.stripe.com/i/acct_1USKFA0iRL0sMmzn/test_receipt?s=ap";
const MICRO = 6000;
const DAY = 86_400_000;
const PERIOD = 30 * DAY;
const START = Date.parse("2026-11-02T09:00:00.000Z");
const REFUND = "?prorate=true&invoice_now=true&cancellation_details%5Bcomment%5D=push%3A+replaced%2C+unused+time+refunded";

type Plan = keyof typeof PRICE;
type Row = Record<string, unknown>;
type Item = { price: { id: string }; current_period_start: number; current_period_end: number };
type Sub = {
  id: string; object: "subscription"; customer: string; status: string; created: number; currency: "usd"; items: { object: "list"; data: Item[] };
  metadata: Record<string, string>; cancellation_details?: { comment: string | null };
};

const env: CoreEnv = {
  APP_ENV: "production", PAYMENTS_ENABLED: "1",
  STRIPE_SECRET_KEY: "sk_test",
  STRIPE_WEBHOOK_SECRET: "whsec_test",
  STRIPE_PRICE_PRO: "price_personal_pro",
  STRIPE_PRICE_ULTRA: "price_personal_ultra",
  STRIPE_PRICE_EMPLOYER_BASIC: BASIC,
  STRIPE_PRICE_EMPLOYER_PRO: PRO,
  STRIPE_PRICE_EMPLOYER_ULTRA: ULTRA,
  STRIPE_PRICE_TOPUP: "price_pack",
  STRIPE_RETURN_ORIGINS: "http://localhost:5174",
  IAP_PRODUCT_PRO: "ios.pro",
  IAP_PRODUCT_ULTRA: "ios.ultra",
  IAP_PRODUCT_TOPUP: "ios.topup",
};

let pg: LivePg | undefined;
before(async () => { if (URL_) pg = await livePg(URL_); });
after(async () => { await pg?.close(); });

const rand = () => crypto.randomUUID().replaceAll("-", "").slice(0, 14);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// Auth, rate limits and idempotency are not under test: they answer from memory, everything else hits Postgres.
const dbFor = (who: { userId: string; companyId: string | null; plan?: string }): Query => async (sql, params = []) => {
  if (sql.includes("rate_limits")) return { rows: [{ hits: 1 }], rowCount: 1 };
  if (sql.includes("idempotency_keys")) return sql.includes("INSERT") ? { rows: [{ id: "idem" }], rowCount: 1 } : { rows: [], rowCount: 0 };
  if (sql.includes("access_tokens")) {
    return { rows: [{
      id: who.userId, display_name: "이민아", locale: "ko", plan: who.plan ?? "FREE", subscription_status: who.plan ? "ACTIVE" : "NONE",
      stripe_customer_id: null, period_ends_at: null, created_at: new Date(START).toISOString(), token_expires_at: "2099-01-01T00:00:00Z",
      is_employer: who.companyId != null, company_id: who.companyId, company_role: who.companyId ? "ADMIN" : null,
    }], rowCount: 1 };
  }
  return pg!.query(sql, params);
};

function stripeWorld(customer: string) {
  const subs = new Map<string, Sub>();
  const calls: string[] = [];
  const ended: string[] = [];
  const open = new Map<string, string[]>();
  const fail = { get: 0, delete: 0 };
  const sessions: Row[] = [];
  const subscribe = (plan: Plan, at: number): Sub => {
    const sub: Sub = {
      id: "sub_" + rand(), object: "subscription", customer, status: "active", created: Math.floor(at / 1000), currency: "usd",
      items: { object: "list", data: [{ price: { id: PRICE[plan] }, current_period_start: Math.floor(at / 1000), current_period_end: Math.floor((at + PERIOD) / 1000) }] },
      metadata: { audience: "EMPLOYER", plan },
    };
    subs.set(sub.id, sub);
    return sub;
  };
  const fetchImpl = (async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url.pathname}${url.search}`);
    const one = /^\/v1\/subscriptions\/([^/]+)$/.exec(url.pathname)?.[1];
    if (one && method === "GET") {
      if (fail.get-- > 0) return json({ error: { type: "api_error" } }, 500);
      const sub = subs.get(decodeURIComponent(one));
      return sub ? json(sub) : json({ error: { code: "resource_missing" } }, 404);
    }
    if (one && method === "DELETE") {
      if (fail.delete-- > 0) return json({ error: { type: "api_error" } }, 500);
      const sub = subs.get(decodeURIComponent(one));
      if (!sub) return json({ error: { code: "resource_missing" } }, 404);
      sub.status = "canceled";
      sub.cancellation_details = { comment: url.searchParams.get("cancellation_details[comment]") };
      ended.push(`DELETE ${url.pathname}${url.search}`);
      return json(sub);
    }
    if (url.pathname === "/v1/invoices" && method === "GET") {
      return json({ object: "list", data: (open.get(url.searchParams.get("subscription") ?? "") ?? []).map((id) => ({ id, object: "invoice", status: "open" })), has_more: false });
    }
    const voided = /^\/v1\/invoices\/([^/]+)\/void$/.exec(url.pathname)?.[1];
    if (voided && method === "POST") {
      for (const [sub, ids] of open) open.set(sub, ids.filter((id) => id !== voided));
      ended.push(`POST ${url.pathname}`);
      return json({ id: voided, object: "invoice", status: "void" });
    }
    if (url.pathname === "/v1/subscriptions") {
      const owner = url.searchParams.get("customer");
      return json({ object: "list", data: [...subs.values()].filter((sub) => sub.customer === owner && sub.status !== "canceled"), has_more: false });
    }
    if (url.pathname.startsWith("/v1/invoices/")) return json({ id: url.pathname.split("/").at(-1), object: "invoice", hosted_invoice_url: RECEIPT });
    if (url.pathname === "/v1/checkout/sessions" && method === "GET") {
      const intent = url.searchParams.get("payment_intent");
      return json({ object: "list", data: sessions.filter((session) => session.payment_intent === intent), has_more: false });
    }
    return json({ error: { code: "resource_missing" } }, 404);
  }) as typeof fetch;
  return { subs, calls, fail, open, sessions, subscribe, fetchImpl, deletes: () => [...ended] };
}

type World = ReturnType<typeof stripeWorld>;

const company = async (t: TestContext): Promise<{ id: string; customer: string } | null> => {
  if (!pg) {
    t.skip("set BILLING_PG_URL to a migrated Postgres");
    return null;
  }
  const id = crypto.randomUUID();
  await pg.query("INSERT INTO companies (id, name) VALUES ($1, 'push-be fixture company')", [id]);
  return { id, customer: "cus_" + rand() };
};

const signed = async (event: Row, at: number): Promise<Request> => {
  const payload = JSON.stringify(event);
  const stamp = Math.floor(at / 1000);
  const hex = await hmacSha256Hex("whsec_test", new TextEncoder().encode(`${stamp}.${payload}`));
  return new Request("https://core.example/api/v1/billing/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": `t=${stamp},v1=${hex}` },
    body: payload,
  });
};

// `wrap` sees every statement of the webhook transaction, to inject a failure or start a concurrent request mid-way.
const deliver = async (stripe: World, event: Row, at: number, wrap: (q: Query) => Query = (q) => q): Promise<number> => {
  resetLimits();
  const deps: Deps = {
    query: dbFor({ userId: crypto.randomUUID(), companyId: null }), now: () => new Date(at), fetch: stripe.fetchImpl,
    transaction: (work) => pg!.transaction!((q) => work(wrap(q))),
  };
  return (await handle(await signed(event, at), env, deps)).status;
};

const checkout = (companyId: string, sub: Sub, plan: Plan, at: number) => ({
  id: "evt_" + rand(),
  object: "event",
  type: "checkout.session.completed",
  created: Math.floor(at / 1000),
  data: { object: {
    id: "cs_test_" + rand(), object: "checkout.session", mode: "subscription", status: "complete", payment_status: "paid",
    amount_total: CENTS[plan], currency: "usd", customer: sub.customer, subscription: sub.id, invoice: "in_" + rand(),
    payment_intent: null, client_reference_id: companyId, metadata: { audience: "EMPLOYER", plan },
  } },
});

const subscriptionEvent = (type: string, sub: Sub, previous: Row = {}) => ({
  id: "evt_" + rand(), object: "event", api_version: "2026-09-30.endive", created: sub.created, livemode: false, pending_webhooks: 1,
  request: { id: null, idempotency_key: null }, type, data: { object: structuredClone(sub), previous_attributes: previous },
});

const refundInvoice = (sub: Sub, cents: number) => ({
  id: "evt_" + rand(),
  object: "event",
  type: "invoice.paid",
  data: { object: {
    id: "in_" + rand(), object: "invoice", billing_reason: "subscription_cycle", status: "paid", currency: "usd", customer: sub.customer,
    amount_paid: 0, total: -cents, hosted_invoice_url: RECEIPT, parent: { type: "subscription_details", subscription_details: { subscription: sub.id } },
    lines: { object: "list", data: [{ amount: -cents, pricing: { price_details: { price: sub.items.data[0]!.price.id }, type: "price_details" } }] },
  } },
});

// The cycle invoice of the period starting at `start`; Stripe moves the subscription to that period first.
const renewal = (stripe: World, sub: Sub, plan: Plan, start: number, paid: { amount_paid: number; total: number } = { amount_paid: CENTS[plan], total: CENTS[plan] }) => {
  const live = stripe.subs.get(sub.id)!;
  live.items.data[0]!.current_period_start = Math.floor(start / 1000);
  live.items.data[0]!.current_period_end = Math.floor((start + PERIOD) / 1000);
  const period = { start: Math.floor(start / 1000), end: Math.floor((start + PERIOD) / 1000) };
  return {
    id: "evt_" + rand(),
    object: "event",
    type: "invoice.paid",
    data: { object: {
      id: "in_" + rand(), object: "invoice", billing_reason: "subscription_cycle", status: "paid", currency: "usd", customer: sub.customer,
      ...paid, hosted_invoice_url: RECEIPT, parent: { type: "subscription_details", subscription_details: { subscription: sub.id } },
      lines: { object: "list", data: [{ amount: CENTS[plan], period, pricing: { price_details: { price: PRICE[plan] }, type: "price_details" } }] },
    } },
  };
};

const billingRead = async (companyId: string, at: number): Promise<Row> => {
  resetLimits();
  const res = await handle(new Request("https://core.example/api/v1/billing", { headers: { authorization: "Bearer t" } }), env,
    { query: dbFor({ userId: crypto.randomUUID(), companyId }), now: () => new Date(at) });
  assert.equal(res.status, 200);
  return (await res.json() as { data: Row }).data;
};

const ledgerOf = async (companyId: string) => (await pg!.query(
  "SELECT reference_id, amount_micro_credits, description, amount_usd_cents FROM billing_ledger WHERE company_id = $1 ORDER BY created_at, reference_id",
  [companyId])).rows.map((row) => ({
  reference: String(row.reference_id).replace(/_test_[0-9a-f]+|_[0-9a-f]{14}\b/g, "_…").replace(/:(\d{10}):/, (_, unix: string) => ":" + new Date(Number(unix) * 1000).toISOString().slice(0, 10) + ":"),
  credits: Number(row.amount_micro_credits) / MICRO,
  description: row.description,
  usd: row.amount_usd_cents == null ? null : Number(row.amount_usd_cents) / 100,
}));

const planCredits = (rows: { reference: string; credits: number }[]) =>
  grants(rows).reduce((sum, row) => sum + row.credits, 0);

const grants = <T extends { reference: string }>(rows: T[]): T[] => rows.filter((row) => /^(monthly|period):/.test(row.reference));
const grantRows = (rows: { reference: string; credits: number }[]) => grants(rows).map((row) => [row.reference, row.credits]);
const payments = (rows: { description: unknown; usd: number | null }[]) => rows.filter((row) => row.usd != null).map((row) => [row.description, row.usd]);

const alertsOf = async (companyId: string) => (await pg!.query(
  "SELECT kind, reference_id, resolved_at IS NOT NULL AS resolved FROM billing_alerts WHERE company_id = $1 ORDER BY created_at", [companyId])).rows;

const companyRow = async (companyId: string) => (await pg!.query("SELECT plan, stripe_subscription_id FROM companies WHERE id = $1", [companyId])).rows[0]!;

const show = (t: TestContext, rows: unknown[]) => { for (const row of rows) t.diagnostic(JSON.stringify(row)); };

test("audit S1/S2: a late replay of a failed Ultra checkout never cancels the live subscription or points the company at a dead one", async (t) => {
  const co = await company(t);
  if (!co) return;
  const stripe = stripeWorld(co.customer);
  const pro = stripe.subscribe("PRO", START);
  assert.equal(await deliver(stripe, checkout(co.id, pro, "PRO", START), START), 200);

  const u1 = stripe.subscribe("ULTRA", START + DAY);
  const s1 = checkout(co.id, u1, "ULTRA", START + DAY);
  stripe.fail.get = 1;
  assert.equal(await deliver(stripe, s1, START + DAY), 500);

  const u2 = stripe.subscribe("ULTRA", START + DAY + 600_000);
  assert.equal(await deliver(stripe, checkout(co.id, u2, "ULTRA", START + DAY + 600_000), START + DAY + 600_000), 200);
  assert.deepEqual(stripe.deletes(), [
    `DELETE /v1/subscriptions/${pro.id}${REFUND}`,
    `DELETE /v1/subscriptions/${u1.id}${REFUND}`,
  ]);
  assert.equal(await deliver(stripe, refundInvoice(pro, 9667), START + DAY + 601_000), 200);
  assert.equal(await deliver(stripe, refundInvoice(u1, 20000), START + DAY + 602_000), 200);

  assert.equal(await deliver(stripe, s1, START + 3 * DAY), 200);
  assert.equal(await deliver(stripe, subscriptionEvent("customer.subscription.deleted", stripe.subs.get(u1.id)!), START + 3 * DAY + 1000), 200);
  assert.equal(await deliver(stripe, subscriptionEvent("customer.subscription.deleted", stripe.subs.get(pro.id)!), START + 3 * DAY + 2000), 200);

  assert.equal(stripe.deletes().length, 2);
  assert.equal(stripe.subs.get(u2.id)!.status, "active");
  assert.deepEqual(await companyRow(co.id), { plan: "ULTRA", stripe_subscription_id: u2.id });
  const rows = await ledgerOf(co.id);
  show(t, rows);
  assert.equal(planCredits(rows), 30_000);
  assert.deepEqual(rows.filter((row) => row.usd != null).map((row) => [row.description, row.usd]), [
    ["Pro 월 구독", 100], ["Ultra 월 구독", 200], ["요금제 변경 환급", -96.67], ["요금제 변경 환급", -200], ["Ultra 월 구독", 200],
  ]);
  assert.equal((await billingRead(co.id, START + 4 * DAY)).balanceMicroCredits, 30_000 * MICRO);
});

test("a checkout whose replaced subscription will not cancel leaves no switch behind; the older checkout's replay adopts, the retry replaces it with a refund", async (t) => {
  const co = await company(t);
  if (!co) return;
  const stripe = stripeWorld(co.customer);
  const u1 = stripe.subscribe("ULTRA", START);
  const s1 = checkout(co.id, u1, "ULTRA", START);
  stripe.fail.get = 1;
  assert.equal(await deliver(stripe, s1, START), 500);
  const u2 = stripe.subscribe("ULTRA", START + 60_000);
  const s2 = checkout(co.id, u2, "ULTRA", START + 60_000);
  stripe.fail.delete = 1;
  assert.equal(await deliver(stripe, s2, START + 60_000), 500);
  assert.deepEqual(await alertsOf(co.id), [{ kind: "CANCEL_FAILED", reference_id: u1.id, resolved: false }]);
  assert.equal(await deliver(stripe, s1, START + DAY), 200);
  assert.deepEqual(stripe.deletes(), []);
  assert.equal(await deliver(stripe, s2, START + DAY + 60_000), 200);
  assert.deepEqual(stripe.deletes(), [`DELETE /v1/subscriptions/${u1.id}${REFUND}`]);
  assert.deepEqual(await companyRow(co.id), { plan: "ULTRA", stripe_subscription_id: u2.id });
  assert.equal(planCredits(await ledgerOf(co.id)), 30_000);
  assert.deepEqual(await alertsOf(co.id), [{ kind: "CANCEL_FAILED", reference_id: u1.id, resolved: true }]);
});

test("a replaced subscription that will not cancel opens an operator alert, fails the event so Stripe retries it, and the retry resolves it", async (t) => {
  const co = await company(t);
  if (!co) return;
  const stripe = stripeWorld(co.customer);
  const basic = stripe.subscribe("BASIC", START);
  assert.equal(await deliver(stripe, checkout(co.id, basic, "BASIC", START), START), 200);
  const pro = stripe.subscribe("PRO", START + DAY);
  const event = checkout(co.id, pro, "PRO", START + DAY);
  stripe.fail.delete = 1;
  assert.equal(await deliver(stripe, event, START + DAY), 500);
  assert.deepEqual(await alertsOf(co.id), [{ kind: "CANCEL_FAILED", reference_id: basic.id, resolved: false }]);
  assert.equal(await deliver(stripe, event, START + DAY + 60_000), 200);
  assert.equal(stripe.subs.get(basic.id)!.status, "canceled");
  assert.deepEqual(await alertsOf(co.id), [{ kind: "CANCEL_FAILED", reference_id: basic.id, resolved: true }]);
  const rows = await ledgerOf(co.id);
  show(t, rows);
  assert.equal(rows.filter((row) => row.description === "이전 구독 해지 실패" || row.reference.startsWith("cancel_failed:")).length, 0);
  assert.deepEqual(grantRows(rows), [
    ["period:sub_…:2026-11-02:BASIC", 3000], ["period:sub_…:2026-11-03:BASIC", 0], ["period:sub_…:2026-11-03:PRO", 12000],
  ]);
});

test("Basic → Ultra → Basic → Ultra: upgrades carry the replaced period's tiers and are refunded, the downgrade starts Basic fresh without a refund", async (t) => {
  const co = await company(t);
  if (!co) return;
  const stripe = stripeWorld(co.customer);
  const steps: [Plan, number][] = [["BASIC", 0], ["ULTRA", 1], ["BASIC", 2], ["ULTRA", 3]];
  const subs: Sub[] = [];
  for (const [plan, day] of steps) {
    const at = START + day * DAY;
    const sub = stripe.subscribe(plan, at);
    subs.push(sub);
    assert.equal(await deliver(stripe, checkout(co.id, sub, plan, at), at), 200);
    await billingRead(co.id, at + 1000);
  }
  assert.deepEqual(stripe.deletes(), [
    `DELETE /v1/subscriptions/${subs[0]!.id}${REFUND}`,
    `DELETE /v1/subscriptions/${subs[1]!.id}`,
    `DELETE /v1/subscriptions/${subs[2]!.id}${REFUND}`,
  ]);
  assert.equal(await deliver(stripe, refundInvoice(subs[0]!, 1933), START + DAY + 2000), 200);
  assert.equal(await deliver(stripe, refundInvoice(subs[2]!, 1867), START + 3 * DAY + 2000), 200);
  const rows = await ledgerOf(co.id);
  show(t, rows);
  assert.deepEqual(grantRows(rows), [
    ["period:sub_…:2026-11-02:BASIC", 3000],
    ["period:sub_…:2026-11-03:BASIC", 0], ["period:sub_…:2026-11-03:PRO", 12000], ["period:sub_…:2026-11-03:ULTRA", 15000],
    ["period:sub_…:2026-11-04:BASIC", 3000],
    ["period:sub_…:2026-11-05:BASIC", 0], ["period:sub_…:2026-11-05:PRO", 12000], ["period:sub_…:2026-11-05:ULTRA", 15000],
  ]);
  assert.equal(planCredits(rows), 60_000);
  assert.deepEqual(payments(rows), [
    ["Basic 월 구독", 20], ["Ultra 월 구독", 200], ["요금제 변경 환급", -19.33], ["Basic 월 구독", 20], ["Ultra 월 구독", 200], ["요금제 변경 환급", -18.67],
  ]);
  assert.deepEqual(await companyRow(co.id), { plan: "ULTRA", stripe_subscription_id: subs[3]!.id });
});

test("a company on calendar months that upgrades carries this month's tiers into its Stripe period, and the next credits wait for the paid renewal", async (t) => {
  const co = await company(t);
  if (!co) return;
  const stripe = stripeWorld(co.customer);
  await pg!.query("UPDATE companies SET plan = 'PRO' WHERE id = $1", [co.id]);
  await pg!.query("INSERT INTO billing_ledger (id, company_id, type, amount_micro_credits, balance_after, reference_id, created_at) VALUES ($1, $2, 'PURCHASE', 90000000, 90000000, 'monthly:2026-11', $3)",
    [crypto.randomUUID(), co.id, new Date(START).toISOString()]);
  await billingRead(co.id, START + 1000);
  assert.equal(planCredits(await ledgerOf(co.id)), 15_000);
  const ultra = stripe.subscribe("ULTRA", START + DAY);
  assert.equal(await deliver(stripe, checkout(co.id, ultra, "ULTRA", START + DAY), START + DAY), 200);
  await billingRead(co.id, START + DAY + 1000);
  const rows = await ledgerOf(co.id);
  show(t, rows);
  assert.deepEqual(grantRows(rows), [
    ["monthly:2026-11", 15000], ["period:sub_…:2026-11-03:BASIC", 0], ["period:sub_…:2026-11-03:PRO", 0], ["period:sub_…:2026-11-03:ULTRA", 15000],
  ]);
  assert.equal((await billingRead(co.id, Date.parse("2026-12-01T00:00:00.000Z"))).balanceMicroCredits, 30_000 * MICRO);
  assert.equal(await deliver(stripe, renewal(stripe, ultra, "ULTRA", START + DAY + PERIOD), START + DAY + PERIOD + 3_600_000), 200);
  assert.equal((await billingRead(co.id, START + DAY + PERIOD + 7_200_000)).balanceMicroCredits, 60_000 * MICRO);
});

// Starts `side` when the webhook reaches the plan switch, then fails the transaction on its next statement, as a dropped connection would.
const failAfterSwitch = (side: () => Promise<unknown> = async () => {}) => {
  let step: "switch" | "fail" | "done" = "switch";
  let started: Promise<unknown> = Promise.resolve();
  const wrap = (q: Query): Query => async (sql, params) => {
    if (step === "switch" && sql.startsWith("UPDATE companies SET plan = $2, stripe_customer_id")) {
      step = "fail";
      started = side();
      return q(sql, params);
    }
    if (step === "fail") {
      step = "done";
      throw new Error("Connection terminated unexpectedly");
    }
    return q(sql, params);
  };
  return { wrap, done: () => started, failed: () => step === "done" };
};

test("audit A2: a read that grants the month while the switch is in flight, then a DB error and Stripe's retry, still pay out the Ultra plan once", async (t) => {
  const co = await company(t);
  if (!co) return;
  const stripe = stripeWorld(co.customer);
  await pg!.query("UPDATE companies SET plan = 'PRO' WHERE id = $1", [co.id]);
  const at = START + DAY;
  const ultra = stripe.subscribe("ULTRA", at);
  const event = checkout(co.id, ultra, "ULTRA", at);
  const race = failAfterSwitch(() => billingRead(co.id, at));
  assert.equal(await deliver(stripe, event, at, race.wrap), 500);
  assert.ok(race.failed());
  await race.done();
  assert.equal(await deliver(stripe, event, at + 60_000), 200);
  const rows = await ledgerOf(co.id);
  show(t, rows);
  assert.deepEqual(grantRows(rows), [
    ["monthly:2026-11:BASIC", 3000], ["monthly:2026-11:PRO", 12000],
    ["period:sub_…:2026-11-03:BASIC", 0], ["period:sub_…:2026-11-03:PRO", 0], ["period:sub_…:2026-11-03:ULTRA", 15000],
  ]);
  assert.equal(planCredits(rows), 30_000);
  assert.equal((await billingRead(co.id, at + 120_000)).balanceMicroCredits, 30_000 * MICRO);
});

test("concurrent checkout, its duplicate delivery and billing reads grant the month's plan exactly once", async (t) => {
  const co = await company(t);
  if (!co) return;
  const stripe = stripeWorld(co.customer);
  await pg!.query("UPDATE companies SET plan = 'PRO' WHERE id = $1", [co.id]);
  const ultra = stripe.subscribe("ULTRA", START);
  const event = checkout(co.id, ultra, "ULTRA", START);
  const statuses = await Promise.all([
    deliver(stripe, event, START), deliver(stripe, event, START),
    billingRead(co.id, START).then(() => 200), billingRead(co.id, START).then(() => 200), billingRead(co.id, START).then(() => 200),
  ]);
  assert.deepEqual(statuses, [200, 200, 200, 200, 200]);
  const rows = await ledgerOf(co.id);
  show(t, rows);
  assert.equal(planCredits(rows), 30_000);
  assert.equal(rows.filter((row) => row.description === "Ultra 월 구독").length, 1);
  assert.equal((await billingRead(co.id, START + 1000)).balanceMicroCredits, 30_000 * MICRO);
});

test("out of order: the new subscription's update before its checkout, and the old one's delete after it, leave the plan right", async (t) => {
  const co = await company(t);
  if (!co) return;
  const stripe = stripeWorld(co.customer);
  const pro = stripe.subscribe("PRO", START);
  assert.equal(await deliver(stripe, checkout(co.id, pro, "PRO", START), START), 200);
  const ultra = stripe.subscribe("ULTRA", START + DAY);
  assert.equal(await deliver(stripe, subscriptionEvent("customer.subscription.updated", ultra), START + DAY), 200);
  assert.deepEqual(await companyRow(co.id), { plan: "PRO", stripe_subscription_id: pro.id });
  assert.equal(await deliver(stripe, checkout(co.id, ultra, "ULTRA", START + DAY), START + DAY + 1000), 200);
  assert.equal(await deliver(stripe, subscriptionEvent("customer.subscription.deleted", stripe.subs.get(pro.id)!), START + DAY + 2000), 200);
  assert.deepEqual(await companyRow(co.id), { plan: "ULTRA", stripe_subscription_id: ultra.id });
  assert.equal(await deliver(stripe, subscriptionEvent("customer.subscription.deleted", { ...ultra, status: "canceled" }), START + 2 * DAY), 200);
  assert.equal((await companyRow(co.id)).plan, null);
});

test("audit E: a late customer.subscription.updated sent before the cancel does not bring back the plan of the deleted subscription", async (t) => {
  const co = await company(t);
  if (!co) return;
  const stripe = stripeWorld(co.customer);
  const ultra = stripe.subscribe("ULTRA", START);
  assert.equal(await deliver(stripe, checkout(co.id, ultra, "ULTRA", START), START), 200);
  const late = subscriptionEvent("customer.subscription.updated", ultra, { cancel_at_period_end: false, metadata: {} });
  stripe.subs.get(ultra.id)!.status = "canceled";
  assert.equal(await deliver(stripe, subscriptionEvent("customer.subscription.deleted", stripe.subs.get(ultra.id)!), START + DAY), 200);
  assert.equal(await deliver(stripe, late, START + DAY + 5000), 200);
  assert.deepEqual(await companyRow(co.id), { plan: null, stripe_subscription_id: ultra.id });
  assert.ok(stripe.calls.includes(`GET /v1/subscriptions/${ultra.id}`));
});

test("customer.subscription.updated applies the subscription as Stripe has it now, not the event's copy", async (t) => {
  const co = await company(t);
  if (!co) return;
  const stripe = stripeWorld(co.customer);
  const pro = stripe.subscribe("PRO", START);
  assert.equal(await deliver(stripe, checkout(co.id, pro, "PRO", START), START), 200);
  const live = stripe.subs.get(pro.id)!;
  live.status = "unpaid";
  const unpaid = subscriptionEvent("customer.subscription.updated", live, { status: "past_due" });
  live.status = "active";
  const paid = subscriptionEvent("customer.subscription.updated", live, { status: "unpaid" });
  assert.equal(await deliver(stripe, paid, START + 10 * DAY), 200);
  assert.equal(await deliver(stripe, unpaid, START + 10 * DAY + 1000), 200);
  assert.deepEqual(await companyRow(co.id), { plan: "PRO", stripe_subscription_id: pro.id });
  live.status = "unpaid";
  assert.equal(await deliver(stripe, subscriptionEvent("customer.subscription.updated", live, { status: "past_due" }), START + 20 * DAY), 200);
  assert.equal((await companyRow(co.id)).plan, null);
});

test("audit D: a paid renewal of a replaced subscription writes its 결제 내역 row and grants nothing", async (t) => {
  const co = await company(t);
  if (!co) return;
  const stripe = stripeWorld(co.customer);
  const basic = stripe.subscribe("BASIC", START);
  assert.equal(await deliver(stripe, checkout(co.id, basic, "BASIC", START), START), 200);
  const pro = stripe.subscribe("PRO", START + DAY);
  assert.equal(await deliver(stripe, checkout(co.id, pro, "PRO", START + DAY), START + DAY), 200);
  assert.equal(await deliver(stripe, renewal(stripe, basic, "BASIC", START + PERIOD), START + PERIOD + 3_600_000), 200);
  const rows = await ledgerOf(co.id);
  show(t, rows);
  assert.deepEqual(grantRows(rows), [
    ["period:sub_…:2026-11-02:BASIC", 3000], ["period:sub_…:2026-11-03:BASIC", 0], ["period:sub_…:2026-11-03:PRO", 12000],
  ]);
  assert.deepEqual(payments(rows), [["Basic 월 구독", 20], ["Pro 월 구독", 100], ["Basic 월 구독", 20]]);
  assert.deepEqual(await companyRow(co.id), { plan: "PRO", stripe_subscription_id: pro.id });
  assert.equal((await billingRead(co.id, START + PERIOD + 7_200_000)).balanceMicroCredits, 15_000 * MICRO);
});

test("a cycle invoice that also carries a proration line opens the period from the plan line, not the proration", async (t) => {
  const co = await company(t);
  if (!co) return;
  const stripe = stripeWorld(co.customer);
  const pro = stripe.subscribe("PRO", START);
  assert.equal(await deliver(stripe, checkout(co.id, pro, "PRO", START), START), 200);
  const event = renewal(stripe, pro, "PRO", START + PERIOD) as { data: { object: { lines: { data: Row[] } } } };
  const mid = Math.floor((START + PERIOD - 10 * DAY) / 1000);
  event.data.object.lines.data.unshift({
    amount: 3333, period: { start: mid, end: Math.floor((START + PERIOD) / 1000) },
    parent: { type: "subscription_item_details", subscription_item_details: { proration: true, subscription: pro.id } },
    pricing: { price_details: { price: PRO }, type: "price_details" },
  });
  assert.equal(await deliver(stripe, event, START + PERIOD + 3_600_000), 200);
  const rows = await ledgerOf(co.id);
  show(t, rows);
  assert.deepEqual(grantRows(rows), [
    ["period:sub_…:2026-11-02:BASIC", 3000], ["period:sub_…:2026-11-02:PRO", 12000],
    ["period:sub_…:2026-12-02:BASIC", 3000], ["period:sub_…:2026-12-02:PRO", 12000],
  ]);
});

test("a checkout whose subscription is not the paid plan's price changes nothing but the payment row", async (t) => {
  const co = await company(t);
  if (!co) return;
  const stripe = stripeWorld(co.customer);
  const basic = stripe.subscribe("BASIC", START);
  assert.equal(await deliver(stripe, checkout(co.id, basic, "ULTRA", START), START), 200);
  assert.deepEqual(await companyRow(co.id), { plan: null, stripe_subscription_id: null });
  assert.equal(planCredits(await ledgerOf(co.id)), 0);
  assert.deepEqual(stripe.deletes(), []);
  assert.deepEqual(await alertsOf(co.id), [{ kind: "NOT_ADOPTED", reference_id: basic.id, resolved: false }]);
});

test("two subscriptions created in the same second: the higher id is kept and the other ended, whichever checkout comes first", async (t) => {
  const co = await company(t);
  if (!co) return;
  const stripe = stripeWorld(co.customer);
  const [lo, hi] = [stripe.subscribe("ULTRA", START), stripe.subscribe("ULTRA", START)].sort((a, b) => (a.id < b.id ? -1 : 1));
  assert.equal(await deliver(stripe, checkout(co.id, hi!, "ULTRA", START), START), 200);
  assert.equal(await deliver(stripe, checkout(co.id, lo!, "ULTRA", START), START + 1000), 200);
  assert.deepEqual(stripe.deletes(), [`DELETE /v1/subscriptions/${lo!.id}${REFUND}`]);
  assert.deepEqual(await companyRow(co.id), { plan: "ULTRA", stripe_subscription_id: hi!.id });
  const rows = await ledgerOf(co.id);
  show(t, rows);
  assert.equal(grants(rows).length, 3);
  assert.equal(planCredits(rows), 30_000);
});

test("sign up on the 30th and cancel at period end: one payment, one period of credits, nothing on the 1st", async (t) => {
  const co = await company(t);
  if (!co) return;
  const stripe = stripeWorld(co.customer);
  const at = Date.parse("2026-10-30T09:00:00.000Z");
  const basic = stripe.subscribe("BASIC", at);
  assert.equal(await deliver(stripe, checkout(co.id, basic, "BASIC", at), at), 200);
  for (const day of ["2026-11-01T00:00:00.000Z", "2026-11-15T00:00:00.000Z", "2026-11-29T08:00:00.000Z"]) await billingRead(co.id, Date.parse(day));
  stripe.subs.get(basic.id)!.status = "canceled";
  assert.equal(await deliver(stripe, subscriptionEvent("customer.subscription.deleted", stripe.subs.get(basic.id)!), at + PERIOD), 200);
  const december = await billingRead(co.id, Date.parse("2026-12-01T00:00:00.000Z"));
  const rows = await ledgerOf(co.id);
  show(t, rows);
  assert.deepEqual(grantRows(rows), [["period:sub_…:2026-10-30:BASIC", 3000]]);
  assert.deepEqual(payments(rows), [["Basic 월 구독", 20]]);
  assert.equal(december.balanceMicroCredits, 3000 * MICRO);
  assert.equal(december.plan, null);
});

test("past_due gets no credits: neither billing reads nor a replayed checkout open the unpaid period, its late payment does", async (t) => {
  const co = await company(t);
  if (!co) return;
  const stripe = stripeWorld(co.customer);
  const basic = stripe.subscribe("BASIC", START);
  const signup = checkout(co.id, basic, "BASIC", START);
  assert.equal(await deliver(stripe, signup, START), 200);
  const next = START + PERIOD;
  const live = stripe.subs.get(basic.id)!;
  live.items.data[0]!.current_period_start = Math.floor(next / 1000);
  assert.equal(await deliver(stripe, { ...signup, id: "evt_" + rand() }, next + 600_000), 200);
  live.status = "past_due";
  assert.equal(await deliver(stripe, subscriptionEvent("customer.subscription.updated", live), next + 3_600_000), 200);
  for (const day of [1, 3, 10]) await billingRead(co.id, next + day * DAY);
  assert.equal(planCredits(await ledgerOf(co.id)), 3000);
  assert.equal((await companyRow(co.id)).plan, "BASIC");
  live.status = "active";
  const paid = renewal(stripe, basic, "BASIC", next);
  assert.equal(await deliver(stripe, paid, next + 12 * DAY), 200);
  assert.equal(await deliver(stripe, { ...paid, id: "evt_" + rand() }, next + 12 * DAY + 1000), 200);
  const rows = await ledgerOf(co.id);
  show(t, rows);
  assert.deepEqual(grantRows(rows), [["period:sub_…:2026-11-02:BASIC", 3000], ["period:sub_…:2026-12-02:BASIC", 3000]]);
  assert.deepEqual(payments(rows), [["Basic 월 구독", 20], ["Basic 월 구독", 20]]);
});

test("a renewal paid in full from the Stripe balance (amount_paid 0, total > 0) still opens the period and writes its 결제 내역 row", async (t) => {
  const co = await company(t);
  if (!co) return;
  const stripe = stripeWorld(co.customer);
  const pro = stripe.subscribe("PRO", START);
  assert.equal(await deliver(stripe, checkout(co.id, pro, "PRO", START), START), 200);
  assert.equal(await deliver(stripe, renewal(stripe, pro, "PRO", START + PERIOD, { amount_paid: 0, total: CENTS.PRO }), START + PERIOD + 3_600_000), 200);
  const rows = await ledgerOf(co.id);
  show(t, rows);
  assert.deepEqual(grantRows(rows), [
    ["period:sub_…:2026-11-02:BASIC", 3000], ["period:sub_…:2026-11-02:PRO", 12000],
    ["period:sub_…:2026-12-02:BASIC", 3000], ["period:sub_…:2026-12-02:PRO", 12000],
  ]);
  assert.deepEqual(payments(rows), [["Pro 월 구독", 100], ["Pro 월 구독", 100]]);
  assert.equal((await billingRead(co.id, START + PERIOD + 7_200_000)).balanceMicroCredits, 30_000 * MICRO);
});

test("audit X1: a company whose subscription ended in dunning and that pays again 60 days later gets the new period in full", async (t) => {
  const co = await company(t);
  if (!co) return;
  const stripe = stripeWorld(co.customer);
  const pro = stripe.subscribe("PRO", START);
  assert.equal(await deliver(stripe, checkout(co.id, pro, "PRO", START), START), 200);
  const live = stripe.subs.get(pro.id)!;
  live.items.data[0]!.current_period_start = Math.floor((START + PERIOD) / 1000);
  live.items.data[0]!.current_period_end = Math.floor((START + 2 * PERIOD) / 1000);
  live.status = "past_due";
  assert.equal(await deliver(stripe, subscriptionEvent("customer.subscription.updated", live), START + PERIOD + 3_600_000), 200);
  live.status = "canceled";
  assert.equal(await deliver(stripe, subscriptionEvent("customer.subscription.deleted", live), START + PERIOD + 20 * DAY), 200);
  const back = START + PERIOD + 80 * DAY;
  const again = stripe.subscribe("PRO", back);
  assert.equal(await deliver(stripe, checkout(co.id, again, "PRO", back), back), 200);
  assert.equal(await deliver(stripe, subscriptionEvent("customer.subscription.updated", again), back + 1000), 200);
  const rows = await ledgerOf(co.id);
  show(t, rows);
  assert.deepEqual(grantRows(rows), [
    ["period:sub_…:2026-11-02:BASIC", 3000], ["period:sub_…:2026-11-02:PRO", 12000],
    ["period:sub_…:2027-02-20:BASIC", 3000], ["period:sub_…:2027-02-20:PRO", 12000],
  ]);
  assert.deepEqual(payments(rows), [["Pro 월 구독", 100], ["Pro 월 구독", 100]]);
  assert.deepEqual(stripe.deletes(), []);
  assert.deepEqual(await companyRow(co.id), { plan: "PRO", stripe_subscription_id: again.id });
  assert.equal((await billingRead(co.id, back + 2000)).balanceMicroCredits, 30_000 * MICRO);
});

test("audit X1: a past_due subscription whose paid period is over is replaced without a carry and without a refund", async (t) => {
  const co = await company(t);
  if (!co) return;
  const stripe = stripeWorld(co.customer);
  const pro = stripe.subscribe("PRO", START);
  assert.equal(await deliver(stripe, checkout(co.id, pro, "PRO", START), START), 200);
  const live = stripe.subs.get(pro.id)!;
  live.items.data[0]!.current_period_start = Math.floor((START + PERIOD) / 1000);
  live.items.data[0]!.current_period_end = Math.floor((START + 2 * PERIOD) / 1000);
  live.status = "past_due";
  const at = START + PERIOD + 5 * DAY;
  const ultra = stripe.subscribe("ULTRA", at);
  assert.equal(await deliver(stripe, checkout(co.id, ultra, "ULTRA", at), at), 200);
  const rows = await ledgerOf(co.id);
  show(t, rows);
  assert.deepEqual(grantRows(rows), [
    ["period:sub_…:2026-11-02:BASIC", 3000], ["period:sub_…:2026-11-02:PRO", 12000],
    ["period:sub_…:2026-12-07:BASIC", 3000], ["period:sub_…:2026-12-07:PRO", 12000], ["period:sub_…:2026-12-07:ULTRA", 15000],
  ]);
  assert.deepEqual(stripe.deletes(), [`DELETE /v1/subscriptions/${pro.id}`]);
  assert.deepEqual(await companyRow(co.id), { plan: "ULTRA", stripe_subscription_id: ultra.id });
});

test("audit X2: two checkouts that each fail right after the switch, with the first one's retry in between, pay out the Ultra plan once", async (t) => {
  const co = await company(t);
  if (!co) return;
  const stripe = stripeWorld(co.customer);
  const pro = stripe.subscribe("PRO", START);
  const proEvent = checkout(co.id, pro, "PRO", START);
  assert.equal(await deliver(stripe, proEvent, START, failAfterSwitch().wrap), 500);
  const at = START + DAY;
  const ultra = stripe.subscribe("ULTRA", at);
  const ultraEvent = checkout(co.id, ultra, "ULTRA", at);
  const race = failAfterSwitch(() => deliver(stripe, proEvent, at));
  assert.equal(await deliver(stripe, ultraEvent, at, race.wrap), 500);
  assert.equal(await race.done(), 200);
  assert.equal(await deliver(stripe, ultraEvent, at + 60_000), 200);
  const rows = await ledgerOf(co.id);
  show(t, rows);
  assert.deepEqual(grantRows(rows), [
    ["period:sub_…:2026-11-02:BASIC", 3000], ["period:sub_…:2026-11-02:PRO", 12000],
    ["period:sub_…:2026-11-03:BASIC", 0], ["period:sub_…:2026-11-03:PRO", 0], ["period:sub_…:2026-11-03:ULTRA", 15000],
  ]);
  assert.equal(planCredits(rows), 30_000);
  assert.deepEqual(stripe.deletes(), [`DELETE /v1/subscriptions/${pro.id}${REFUND}`]);
  assert.deepEqual(await companyRow(co.id), { plan: "ULTRA", stripe_subscription_id: ultra.id });
});

// The update reads the subscription from Stripe while it is still active; Stripe then cancels it and sends the delete at once.
const deleteDuringRead = (stripe: World, sub: Sub, at: number) => {
  let sent: Promise<number> = Promise.resolve(0);
  const world: World = {
    ...stripe,
    fetchImpl: (async (input, init) => {
      const res = await stripe.fetchImpl(input, init);
      const live = stripe.subs.get(sub.id)!;
      if (live.status === "active") {
        live.status = "canceled";
        sent = deliver(stripe, subscriptionEvent("customer.subscription.deleted", live), at);
      }
      return res;
    }) as typeof fetch,
  };
  return { world, deleted: () => sent };
};

test("audit X4: an update read from Stripe before the delete and written after it does not bring back the ended plan", async (t) => {
  const co = await company(t);
  if (!co) return;
  const stripe = stripeWorld(co.customer);
  const ultra = stripe.subscribe("ULTRA", START);
  assert.equal(await deliver(stripe, checkout(co.id, ultra, "ULTRA", START), START), 200);
  const update = subscriptionEvent("customer.subscription.updated", ultra, { cancel_at_period_end: false });
  const race = deleteDuringRead(stripe, ultra, START + DAY);
  assert.equal(await deliver(race.world, update, START + DAY + 1000), 200);
  assert.equal(await race.deleted(), 200);
  assert.equal(stripe.subs.get(ultra.id)!.status, "canceled");
  assert.deepEqual(await companyRow(co.id), { plan: null, stripe_subscription_id: ultra.id });
  assert.equal(await deliver(stripe, checkout(co.id, ultra, "ULTRA", START), START + DAY + 2000), 200);
  assert.deepEqual(await companyRow(co.id), { plan: null, stripe_subscription_id: ultra.id });
});

test("audit 4b: a renewal paid during an upgrade pays the Ultra difference on the renewed period once, in either order or concurrently", async (t) => {
  for (const order of ["renewal first", "upgrade first", "concurrent"] as const) {
    const co = await company(t);
    if (!co) return;
    const stripe = stripeWorld(co.customer);
    const pro = stripe.subscribe("PRO", START);
    assert.equal(await deliver(stripe, checkout(co.id, pro, "PRO", START), START), 200);
    const renewed = renewal(stripe, pro, "PRO", START + PERIOD);
    const at = START + PERIOD + 60_000;
    const ultra = stripe.subscribe("ULTRA", at);
    const upgrade = checkout(co.id, ultra, "ULTRA", at);
    if (order === "concurrent") assert.deepEqual(await Promise.all([deliver(stripe, renewed, at), deliver(stripe, upgrade, at)]), [200, 200]);
    else for (const event of order === "renewal first" ? [renewed, upgrade] : [upgrade, renewed]) assert.equal(await deliver(stripe, event, at), 200);
    const rows = await ledgerOf(co.id);
    show(t, rows);
    assert.equal(planCredits(rows), 45_000, order);
    assert.deepEqual(stripe.deletes(), [`DELETE /v1/subscriptions/${pro.id}${REFUND}`], order);
    assert.deepEqual(await alertsOf(co.id), [], order);
    assert.deepEqual(await companyRow(co.id), { plan: "ULTRA", stripe_subscription_id: ultra.id }, order);
  }
});

test("audit 5: replacing a past_due subscription voids its open invoice before the cancel, so the unpaid period cannot be paid later", async (t) => {
  const co = await company(t);
  if (!co) return;
  const stripe = stripeWorld(co.customer);
  const pro = stripe.subscribe("PRO", START);
  assert.equal(await deliver(stripe, checkout(co.id, pro, "PRO", START), START), 200);
  const live = stripe.subs.get(pro.id)!;
  live.items.data[0]!.current_period_start = Math.floor((START + PERIOD) / 1000);
  live.items.data[0]!.current_period_end = Math.floor((START + 2 * PERIOD) / 1000);
  live.status = "past_due";
  stripe.open.set(pro.id, ["in_open_pro"]);
  const at = START + PERIOD + 2 * DAY;
  const ultra = stripe.subscribe("ULTRA", at);
  assert.equal(await deliver(stripe, checkout(co.id, ultra, "ULTRA", at), at), 200);
  assert.deepEqual(stripe.deletes(), ["POST /v1/invoices/in_open_pro/void", `DELETE /v1/subscriptions/${pro.id}`]);
  assert.equal(planCredits(await ledgerOf(co.id)), 45_000);
});

test("a renewal paid just before a downgrade still grants its period when it arrives after the downgrade", async (t) => {
  const co = await company(t);
  if (!co) return;
  const stripe = stripeWorld(co.customer);
  const ultra = stripe.subscribe("ULTRA", START);
  assert.equal(await deliver(stripe, checkout(co.id, ultra, "ULTRA", START), START), 200);
  const renewed = renewal(stripe, ultra, "ULTRA", START + PERIOD);
  const at = START + PERIOD + 480_000;
  const basic = stripe.subscribe("BASIC", at);
  assert.equal(await deliver(stripe, checkout(co.id, basic, "BASIC", at), at), 200);
  assert.equal(await deliver(stripe, renewed, at + 1000), 200);
  const rows = await ledgerOf(co.id);
  show(t, rows);
  assert.equal(planCredits(rows), 63_000);
  assert.deepEqual(stripe.deletes(), [`DELETE /v1/subscriptions/${ultra.id}`]);
  assert.deepEqual(await alertsOf(co.id), []);
});

const legacyUser = async (t: TestContext, customer: string): Promise<string | null> => {
  if (!pg) {
    t.skip("set BILLING_PG_URL to a migrated Postgres");
    return null;
  }
  const userId = crypto.randomUUID();
  await pg.query("INSERT INTO users (id, provider, provider_subject, display_name, stripe_customer_id, plan, subscription_status) VALUES ($1, 'apple', $3, 'fixture', $2, 'PRO', 'ACTIVE')",
    [userId, customer, userId]);
  return userId;
};

const personalSub = (stripe: World, at: number): Sub => {
  const sub = stripe.subscribe("PRO", at);
  sub.items.data[0]!.price.id = env.STRIPE_PRICE_PRO!;
  return sub;
};

const userRow = async (userId: string) => (await pg!.query("SELECT plan, subscription_status FROM users WHERE id = $1", [userId])).rows[0]!;

test("personal: a late customer.subscription.updated copy after the delete is read back from Stripe and keeps the user canceled", async (t) => {
  const customer = "cus_" + rand();
  const userId = await legacyUser(t, customer);
  if (!userId) return;
  const stripe = stripeWorld(customer);
  const sub = personalSub(stripe, START);
  const late = subscriptionEvent("customer.subscription.updated", sub, { cancel_at_period_end: false });
  sub.status = "canceled";
  assert.equal(await deliver(stripe, subscriptionEvent("customer.subscription.deleted", sub), START + DAY), 200);
  assert.equal(await deliver(stripe, late, START + DAY + 5000), 200);
  assert.deepEqual(await userRow(userId), { plan: "FREE", subscription_status: "CANCELED" });
  assert.ok(stripe.calls.includes(`GET /v1/subscriptions/${sub.id}`));
});

test("personal audit X4: an update read from Stripe before the delete and written after it keeps the user canceled", async (t) => {
  const customer = "cus_" + rand();
  const userId = await legacyUser(t, customer);
  if (!userId) return;
  const stripe = stripeWorld(customer);
  const sub = personalSub(stripe, START);
  const update = subscriptionEvent("customer.subscription.updated", sub, { cancel_at_period_end: false });
  const race = deleteDuringRead(stripe, sub, START + DAY);
  assert.equal(await deliver(race.world, update, START + DAY + 1000), 200);
  assert.equal(await race.deleted(), 200);
  assert.equal(stripe.subs.get(sub.id)!.status, "canceled");
  assert.deepEqual(await userRow(userId), { plan: "FREE", subscription_status: "CANCELED" });
});

test("personal: a late Stripe delete leaves a user whose App Store subscription is active on that plan", async (t) => {
  const customer = "cus_" + rand();
  const userId = await legacyUser(t, customer);
  if (!userId) return;
  await pg!.query("INSERT INTO iap_subscriptions (id, user_id, platform, original_transaction_id, product_id, expires_at, status) VALUES ($1, $2, 'APP_STORE', $3, 'ios.ultra', '2099-01-01T00:00:00Z', 'ACTIVE')",
    [crypto.randomUUID(), userId, "tx-" + userId]);
  await pg!.query("UPDATE users SET plan = 'ULTRA' WHERE id = $1", [userId]);
  const stripe = stripeWorld(customer);
  const sub = personalSub(stripe, START);
  sub.status = "canceled";
  assert.equal(await deliver(stripe, subscriptionEvent("customer.subscription.deleted", sub), START + DAY), 200);
  assert.deepEqual(await userRow(userId), { plan: "ULTRA", subscription_status: "ACTIVE" });
});

test("personal grants are unchanged: one full row per store purchase and one monthly row", async (t) => {
  if (!pg) return t.skip("set BILLING_PG_URL to a migrated Postgres");
  const userId = crypto.randomUUID();
  await pg.query("INSERT INTO users (id, provider, provider_subject, display_name) VALUES ($1, 'apple', $2, 'fixture')", [userId, userId]);
  const deps = (at: number): Deps => ({
    query: dbFor({ userId, companyId: null, plan: "PRO" }), now: () => new Date(at),
    stores: {
      verifyApple: async () => ({ productId: "ios.pro", originalTransactionId: "tx-" + userId, expiresAt: "2026-12-02T09:00:00.000Z", consumable: false }),
      verifyGoogle: async () => { throw new Error("google"); },
      decodeAppleNotification: async () => { throw new Error("apple"); },
      decodeGoogleNotification: async () => { throw new Error("google"); },
    },
  });
  const verify = () => new Request("https://core.example/api/v1/billing/iap/verify", {
    method: "POST",
    headers: { authorization: "Bearer t", "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify({ platform: "APP_STORE", productId: "ios.pro", signedTransaction: "jws" }),
  });
  for (const at of [START, START + 1000]) {
    resetLimits();
    assert.equal((await handle(verify(), env, deps(at))).status, 200);
  }
  for (const at of [START + 2000, START + 3000]) {
    resetLimits();
    assert.equal((await handle(new Request("https://core.example/api/v1/billing", { headers: { authorization: "Bearer t" } }), env, deps(at))).status, 200);
  }
  const rows = (await pg.query("SELECT reference_id, amount_micro_credits FROM billing_ledger WHERE user_id = $1 ORDER BY created_at", [userId])).rows;
  assert.deepEqual(rows.map((row) => [row.reference_id, Number(row.amount_micro_credits)]), [["tx-" + userId, 27_000_000], ["monthly:2026-11", 27_000_000]]);
});

// D18: a refunded top-up takes its credits back, never below 0, and keeps the plan.
const storeUser = async (t: TestContext): Promise<string | null> => {
  if (!pg) {
    t.skip("set BILLING_PG_URL to a migrated Postgres");
    return null;
  }
  const userId = crypto.randomUUID();
  await pg.query("INSERT INTO users (id, provider, provider_subject, display_name, plan, subscription_status) VALUES ($1, 'apple', $2, 'fixture', 'PRO', 'ACTIVE')", [userId, userId]);
  return userId;
};

const userLedgerOf = async (userId: string) => (await pg!.query(
  "SELECT type, reference_id, amount_micro_credits, balance_after FROM billing_ledger WHERE user_id = $1 ORDER BY created_at, id", [userId])).rows
  .map((row) => [row.type, row.reference_id, Number(row.amount_micro_credits), Number(row.balance_after)]);

const storeRefund = async (userId: string, tx: string, at: number, note: { platform: "APP_STORE" | "GOOGLE_PLAY"; type: string }, wrap: (q: Query) => Query = (q) => q) => {
  let clock = at;
  const deps: Deps = {
    query: wrap(dbFor({ userId, companyId: null, plan: "PRO" })), now: () => new Date(clock),
    transaction: (work) => pg!.transaction!((q) => work(wrap(q))),
    stores: {
      verifyApple: async () => ({ productId: "ios.topup", originalTransactionId: tx, expiresAt: null, consumable: true }),
      verifyGoogle: async () => ({ productId: "ios.topup", originalTransactionId: tx, expiresAt: null, consumable: true }),
      decodeAppleNotification: async () => ({ notificationType: note.type, originalTransactionId: tx, productId: "ios.topup", expiresAt: null }),
      decodeGoogleNotification: async () => ({ notificationType: note.type, purchaseToken: tx, productId: "", expiresAt: null }),
    },
  };
  const buy = new Request("https://core.example/api/v1/billing/iap/verify", {
    method: "POST",
    headers: { authorization: "Bearer t", "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify(note.platform === "APP_STORE"
      ? { platform: "APP_STORE", productId: "ios.topup", signedTransaction: "jws" }
      : { platform: "GOOGLE_PLAY", productId: "ios.topup", purchaseToken: tx }),
  });
  const hook = () => new Request("https://core.example/api/v1/billing/webhook/" + (note.platform === "APP_STORE" ? "app-store" : "google-play"), {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  });
  return { buy: async () => { resetLimits(); return (await handle(buy, env, deps)).status; }, refund: async () => {
    resetLimits();
    clock += DAY;
    // The top-up product id was renamed since the purchase: the stored row, not the config, says it was a top-up.
    return (await handle(hook(), { ...env, IAP_PRODUCT_TOPUP: "ios.topup.2027" }, deps)).status;
  } };
};

test("D18: a refunded App Store or Play top-up takes its pack back, keeps the plan even after a product rename, and a repeated notice takes nothing more", async (t) => {
  for (const platform of ["APP_STORE", "GOOGLE_PLAY"] as const) {
    const userId = await storeUser(t);
    if (!userId) return;
    const tx = "tx-" + rand();
    const flow = await storeRefund(userId, tx, START, { platform, type: "REFUND" });
    assert.equal(await flow.buy(), 200);
    const [[, , pack]] = await userLedgerOf(userId) as [[string, string, number, number]];
    assert.ok(pack > 0);
    assert.equal(await flow.refund(), 200);
    assert.equal(await flow.refund(), 200);
    assert.deepEqual(await userLedgerOf(userId), [["PURCHASE", tx, pack, pack], ["REFUND", tx, -pack, 0]], platform);
    assert.deepEqual(await userRow(userId), { plan: "PRO", subscription_status: "ACTIVE" });
    assert.equal((await pg!.query("SELECT status FROM iap_subscriptions WHERE original_transaction_id = $1", [tx])).rows[0]!.status, "REFUNDED");
  }
});

test("D18: a top-up refunded after part of it was spent takes back only what is left, so the balance stops at 0", async (t) => {
  const userId = await storeUser(t);
  if (!userId) return;
  const tx = "tx-" + rand();
  const flow = await storeRefund(userId, tx, START, { platform: "APP_STORE", type: "REFUND" });
  assert.equal(await flow.buy(), 200);
  const [[, , pack]] = await userLedgerOf(userId) as [[string, string, number, number]];
  const spent = Math.floor(pack / 3);
  await pg!.query("INSERT INTO ai_usage (id, user_id, provider, model, managed, input_tokens, output_tokens, cost_micro_credits, status) VALUES ($1, $2, 'openrouter', 'm', true, 1, 1, $3, 'SETTLED')",
    [crypto.randomUUID(), userId, spent]);
  assert.equal(await flow.refund(), 200);
  assert.deepEqual((await userLedgerOf(userId)).at(-1), ["REFUND", tx, spent - pack, spent]);
  const left = await pg!.query("SELECT (SELECT balance_after FROM billing_ledger WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1) - $2::bigint AS left", [userId, spent]);
  assert.equal(Number(left.rows[0]!.left), 0);
});

// A job enqueued while a top-up refund runs: the refund and the job's reservation both read the balance, so the user row lock must
// order them. `wrap` of each side sees its own statements.
const refundAndEnqueue = async (t: TestContext, monthGranted: boolean, hold: (side: "refund" | "enqueue", sql: string) => Promise<void> | undefined) => {
  const userId = await storeUser(t);
  if (!userId) return null;
  const tx = "tx-" + rand();
  const documentId = crypto.randomUUID();
  await pg!.query("INSERT INTO documents (id, user_id, title, kind, template) VALUES ($1, $2, 't', 'RESUME', 'basic')", [documentId, userId]);
  const hooked = (side: "refund" | "enqueue") => (q: Query): Query => async (sql, params) => {
    await hold(side, sql);
    return q(sql, params);
  };
  const flow = await storeRefund(userId, tx, START, { platform: "APP_STORE", type: "REFUND" });
  assert.equal(await flow.buy(), 200);
  if (monthGranted) {
    // This month's plan credits are granted and spent, so only the pack is left to spend.
    await pg!.query("INSERT INTO billing_ledger (id, user_id, type, amount_micro_credits, balance_after, reference_id, created_at) SELECT $1, $2, 'PURCHASE', 27000000, balance_after + 27000000, $3, now() FROM billing_ledger WHERE user_id = $2",
      [crypto.randomUUID(), userId, "monthly:" + new Date().toISOString().slice(0, 7)]);
    await pg!.query("INSERT INTO ai_usage (id, user_id, provider, model, managed, input_tokens, output_tokens, cost_micro_credits, status) VALUES ($1, $2, 'openrouter', 'm', true, 1, 1, 27000000, 'SETTLED')",
      [crypto.randomUUID(), userId]);
  }
  // The refund and the job's month grant stamp their rows with today, as in production.
  const refunding = await storeRefund(userId, tx, Date.now() - DAY, { platform: "APP_STORE", type: "REFUND" }, hooked("refund"));
  const enqueue = async () => {
    resetLimits();
    const deps: Deps = {
      query: hooked("enqueue")(dbFor({ userId, companyId: null, plan: "PRO" })), now: () => new Date(START + DAY),
      transaction: (work) => pg!.transaction!((q) => work(hooked("enqueue")(q))),
    };
    return (await handle(new Request(`https://core.example/api/v1/documents/${documentId}/generate`, {
      method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json", "idempotency-key": crypto.randomUUID() }, body: JSON.stringify({ expectedRevision: 1 }),
    }), env, deps)).status;
  };
  return { userId, refund: refunding.refund, enqueue };
};

const moneyOf = async (userId: string) => (await pg!.query(
  "SELECT (SELECT balance_after FROM billing_ledger WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1) AS last, (SELECT SUM(amount_micro_credits) FROM billing_ledger WHERE user_id = $1) AS total, (SELECT COALESCE(SUM(cost_micro_credits), 0) FROM ai_usage WHERE user_id = $1 AND status = 'SETTLED') AS settled, (SELECT COALESCE(SUM(amount_micro), 0) FROM credit_reservations WHERE user_id = $1 AND status = 'RESERVED') AS reserved",
  [userId])).rows.map((row) => ({ last: Number(row.last), total: Number(row.total), available: Number(row.last) - Number(row.settled) - Number(row.reserved) }))[0]!;

test("audit: a job enqueued after a top-up refund read the balance waits for the refund, so the available balance never goes below 0", async (t) => {
  let enqueued: Promise<number> | undefined;
  let job: () => Promise<number> = async () => 0;
  const race = await refundAndEnqueue(t, true, async (side, sql) => {
    // The refund has read what is left and is about to write it back: a job starts now and gets up to 300 ms to finish.
    if (side !== "refund" || enqueued || !sql.startsWith("INSERT INTO billing_ledger")) return;
    enqueued = job();
    await Promise.race([enqueued, sleep(300)]);
  });
  if (!race) return;
  job = race.enqueue;
  assert.equal(await race.refund(), 200);
  assert.ok(enqueued, "the refund reached its ledger write");
  const status = await enqueued;
  const money = await moneyOf(race.userId);
  assert.equal(money.available, 0);
  assert.equal(money.last, money.total);
  assert.equal(status, 402);
});

test("audit: a top-up refund and the month grant of a job enqueued at the same moment keep balance_after equal to the ledger sum", async (t) => {
  let lost = 0;
  for (let round = 0; round < 5; round++) {
    // Both sides send their ledger write at once; with the user row lock the job's grant waits for the refund instead.
    const arrived = new Set<string>();
    let meet!: () => void;
    const met = new Promise<void>((resolve) => { meet = resolve; });
    const race = await refundAndEnqueue(t, false, async (side, sql) => {
      if (arrived.has(side) || !sql.startsWith("INSERT INTO billing_ledger")) return;
      arrived.add(side);
      if (arrived.size === 2) meet();
      await Promise.race([met, sleep(300)]);
    });
    if (!race) return;
    const [refunded, enqueued] = await Promise.all([race.refund(), race.enqueue()]);
    assert.equal(refunded, 200);
    assert.equal(enqueued, 202);
    const money = await moneyOf(race.userId);
    if (money.last !== money.total) lost++;
    assert.ok(money.available >= 0, `round ${round}: available ${money.available}`);
  }
  assert.equal(lost, 0, `${lost} of 5 rounds lost a balance_after update`);
});

test("D18: a fully refunded Stripe top-up checkout takes its credits back once; a partial refund changes nothing", async (t) => {
  const co = await company(t);
  if (!co) return;
  const stripe = stripeWorld(co.customer);
  const micro = 2 * 1500 * MICRO;
  const topup = (intent: string) => {
    const session = {
      id: "cs_test_" + rand(), object: "checkout.session", mode: "payment", status: "complete", payment_status: "paid", amount_total: 4000,
      currency: "usd", customer: co.customer, payment_intent: intent, client_reference_id: co.id,
      metadata: { amountMicroCredits: String(micro), audience: "EMPLOYER", ownerId: co.id },
    };
    stripe.sessions.push(session);
    return { id: "evt_" + rand(), object: "event", type: "checkout.session.completed", data: { object: session } };
  };
  const refunded = (intent: string, full: boolean) => ({
    id: "evt_" + rand(), object: "event", type: "charge.refunded",
    data: { object: { id: "ch_" + rand(), object: "charge", payment_intent: intent, amount: 4000, amount_refunded: full ? 4000 : 1000, refunded: full } },
  });
  const [kept, gone] = ["pi_" + rand(), "pi_" + rand()];
  assert.equal(await deliver(stripe, topup(kept), START), 200);
  assert.equal(await deliver(stripe, topup(gone), START + 1000), 200);
  assert.equal(await deliver(stripe, refunded(kept, false), START + DAY), 200);
  const full = refunded(gone, true);
  assert.equal(await deliver(stripe, full, START + DAY + 1000), 200);
  assert.equal(await deliver(stripe, { ...full, id: "evt_" + rand() }, START + DAY + 2000), 200);
  const rows = (await pg!.query("SELECT type, amount_micro_credits, description FROM billing_ledger WHERE company_id = $1 ORDER BY created_at, id", [co.id])).rows
    .map((row) => [row.type, Number(row.amount_micro_credits), row.description]);
  assert.deepEqual(rows, [["PURCHASE", micro, "크레딧 구매"], ["PURCHASE", micro, "크레딧 구매"], ["REFUND", -micro, "크레딧 구매 환불"]]);
});
