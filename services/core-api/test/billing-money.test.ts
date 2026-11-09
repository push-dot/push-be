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
const START = Date.parse("2026-11-02T09:00:00.000Z");

type Plan = keyof typeof PRICE;
type Row = Record<string, unknown>;
type Sub = { id: string; object: "subscription"; customer: string; status: string; created: number; currency: "usd"; items: { object: "list"; data: { price: { id: string } }[] }; metadata: Record<string, string> };

const env: CoreEnv = {
  APP_ENV: "production",
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
  const fail = { get: 0, delete: 0 };
  const subscribe = (plan: Plan, at: number): Sub => {
    const sub: Sub = {
      id: "sub_" + rand(), object: "subscription", customer, status: "active", created: Math.floor(at / 1000), currency: "usd",
      items: { object: "list", data: [{ price: { id: PRICE[plan] } }] }, metadata: { audience: "EMPLOYER", plan },
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
      ended.push(`DELETE ${url.pathname}${url.search}`);
      return json(sub);
    }
    if (url.pathname === "/v1/subscriptions") {
      const owner = url.searchParams.get("customer");
      return json({ object: "list", data: [...subs.values()].filter((sub) => sub.customer === owner && sub.status !== "canceled"), has_more: false });
    }
    if (url.pathname.startsWith("/v1/invoices/")) return json({ id: url.pathname.split("/").at(-1), object: "invoice", hosted_invoice_url: RECEIPT });
    return json({ error: { code: "resource_missing" } }, 404);
  }) as typeof fetch;
  return { subs, calls, fail, subscribe, fetchImpl, deletes: () => [...ended] };
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

const deliver = async (stripe: World, event: Row, at: number): Promise<number> => {
  resetLimits();
  const deps: Deps = { query: dbFor({ userId: crypto.randomUUID(), companyId: null }), now: () => new Date(at), fetch: stripe.fetchImpl };
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

const subscriptionEvent = (type: string, sub: Sub) => ({ id: "evt_" + rand(), object: "event", type, data: { object: { ...sub } } });

const refundInvoice = (sub: Sub, cents: number) => ({
  id: "evt_" + rand(),
  object: "event",
  type: "invoice.paid",
  data: { object: {
    id: "in_" + rand(), object: "invoice", billing_reason: "subscription_cycle", status: "paid", currency: "usd", customer: sub.customer,
    amount_paid: 0, total: -cents, hosted_invoice_url: RECEIPT,
    lines: { object: "list", data: [{ amount: -cents, pricing: { price_details: { price: sub.items.data[0]!.price.id }, type: "price_details" } }] },
  } },
});

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
  reference: String(row.reference_id).replace(/_test_[0-9a-f]+|_[0-9a-f]{14}$/, "_…"),
  credits: Number(row.amount_micro_credits) / MICRO,
  description: row.description,
  usd: row.amount_usd_cents == null ? null : Number(row.amount_usd_cents) / 100,
}));

const planCredits = (rows: { reference: string; credits: number }[]) =>
  rows.filter((row) => row.reference.startsWith("monthly:")).reduce((sum, row) => sum + row.credits, 0);

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
    `DELETE /v1/subscriptions/${pro.id}?prorate=true&invoice_now=true`,
    `DELETE /v1/subscriptions/${u1.id}?prorate=true&invoice_now=true`,
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
    ["Pro 월 구독", 100], ["Ultra 월 구독", 200], ["Ultra 월 구독", 200], ["요금제 변경 환급", -96.67], ["요금제 변경 환급", -200],
  ]);
  assert.equal((await billingRead(co.id, START + 4 * DAY)).balanceMicroCredits, 30_000 * MICRO);
});

test("a replayed checkout whose subscription is still live but older than the company's is ended with a refund, not adopted", async (t) => {
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
  assert.equal(await deliver(stripe, s1, START + DAY), 200);
  assert.deepEqual(stripe.deletes(), [`DELETE /v1/subscriptions/${u1.id}?prorate=true&invoice_now=true`]);
  assert.equal(await deliver(stripe, s2, START + DAY + 60_000), 200);
  assert.equal(stripe.deletes().length, 1);
  assert.deepEqual(await companyRow(co.id), { plan: "ULTRA", stripe_subscription_id: u2.id });
  assert.equal(planCredits(await ledgerOf(co.id)), 30_000);
});

test("a replaced subscription that will not cancel leaves a 이전 구독 해지 실패 row and fails the event so Stripe retries it", async (t) => {
  const co = await company(t);
  if (!co) return;
  const stripe = stripeWorld(co.customer);
  const basic = stripe.subscribe("BASIC", START);
  assert.equal(await deliver(stripe, checkout(co.id, basic, "BASIC", START), START), 200);
  const pro = stripe.subscribe("PRO", START + DAY);
  const event = checkout(co.id, pro, "PRO", START + DAY);
  stripe.fail.delete = 1;
  assert.equal(await deliver(stripe, event, START + DAY), 500);
  assert.equal(await deliver(stripe, event, START + DAY + 60_000), 200);
  assert.equal(stripe.subs.get(basic.id)!.status, "canceled");
  const rows = await ledgerOf(co.id);
  show(t, rows);
  assert.deepEqual(rows.filter((row) => row.reference.startsWith("cancel_failed:")).map((row) => [row.description, row.credits, row.usd]), [["이전 구독 해지 실패", 0, null]]);
  assert.equal(planCredits(rows), 15_000);
});

test("Basic → Ultra → Basic → Ultra in one month grants Ultra's 30,000 credits once and refunds only the upgrades", async (t) => {
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
    `DELETE /v1/subscriptions/${subs[0]!.id}?prorate=true&invoice_now=true`,
    `DELETE /v1/subscriptions/${subs[1]!.id}`,
    `DELETE /v1/subscriptions/${subs[2]!.id}?prorate=true&invoice_now=true`,
  ]);
  assert.equal(await deliver(stripe, refundInvoice(subs[0]!, 1933), START + DAY + 2000), 200);
  assert.equal(await deliver(stripe, refundInvoice(subs[2]!, 1867), START + 3 * DAY + 2000), 200);
  const rows = await ledgerOf(co.id);
  show(t, rows);
  assert.deepEqual(rows.filter((row) => row.reference.startsWith("monthly:")).map((row) => [row.reference, row.credits]), [
    ["monthly:2026-11:BASIC", 3000], ["monthly:2026-11:PRO", 12000], ["monthly:2026-11:ULTRA", 15000],
  ]);
  assert.equal(planCredits(rows), 30_000);
  assert.deepEqual(await companyRow(co.id), { plan: "ULTRA", stripe_subscription_id: subs[3]!.id });
});

test("the monthly grant and a mid-month upgrade give the difference only, also over a pre-tier monthly row", async (t) => {
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
  assert.deepEqual(rows.filter((row) => row.reference.startsWith("monthly:")).map((row) => [row.reference, row.credits]), [
    ["monthly:2026-11", 15000], ["monthly:2026-11:ULTRA", 15000],
  ]);
  const december = await billingRead(co.id, Date.parse("2026-12-01T00:00:00.000Z"));
  assert.equal(december.balanceMicroCredits, 60_000 * MICRO);
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

test("a checkout whose subscription is not the paid plan's price changes nothing but the payment row", async (t) => {
  const co = await company(t);
  if (!co) return;
  const stripe = stripeWorld(co.customer);
  const basic = stripe.subscribe("BASIC", START);
  assert.equal(await deliver(stripe, checkout(co.id, basic, "ULTRA", START), START), 200);
  assert.deepEqual(await companyRow(co.id), { plan: null, stripe_subscription_id: null });
  assert.equal(planCredits(await ledgerOf(co.id)), 0);
  assert.deepEqual(stripe.deletes(), []);
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
