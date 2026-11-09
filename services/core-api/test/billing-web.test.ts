import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { hmacSha256Hex } from "../src/crypto.ts";
import type { Query } from "../src/db.ts";
import { handle, type CoreEnv } from "../src/handler.ts";
import { resetLimits } from "../src/ratelimit.ts";

const USER = "12345678-1234-5678-1234-567812345678";
const COMPANY = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const NOW = new Date("2026-11-09T00:00:00.000Z");
const PRO_PRICE = "price_1UZkaI0iRL0sMmznnP3RfVxG";
const ULTRA_PRICE = "price_1UZkaJ0iRL0sMmznX1goyOQq";
const RECEIPT = "https://invoice.stripe.com/i/acct_1USKFA0iRL0sMmzn/test_receipt?s=ap";

type Row = Record<string, unknown>;
type Call = { sql: string; params: unknown[] };
type StripeCall = { method: string; url: string; body: string };

const envOf = (extra: Partial<CoreEnv> = {}): CoreEnv => ({
  APP_ENV: "production",
  STRIPE_SECRET_KEY: "sk_test",
  STRIPE_WEBHOOK_SECRET: "whsec_test",
  STRIPE_PRICE_EMPLOYER_BASIC: "price_1UZkaG0iRL0sMmznUELNqD4P",
  STRIPE_PRICE_EMPLOYER_PRO: PRO_PRICE,
  STRIPE_PRICE_EMPLOYER_ULTRA: ULTRA_PRICE,
  STRIPE_PRICE_TOPUP: "price_1UZl8R0iRL0sMmzn1MkSBY01",
  STRIPE_RETURN_ORIGINS: "https://push.example, http://localhost:5174/",
  ...extra,
});

beforeEach(() => resetLimits());

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const stripeFetch = (calls: StripeCall[], reply: (call: StripeCall) => Response = () => json({ url: "https://checkout.stripe.com/c/pay/cs_test" })): typeof fetch =>
  (async (input, init) => {
    const call = { method: init?.method ?? "GET", url: String(input), body: init?.body == null ? "" : String(init.body) };
    calls.push(call);
    return reply(call);
  }) as typeof fetch;

function world(reply: (sql: string, params: unknown[]) => Row[] | undefined = () => undefined) {
  const seen: Call[] = [];
  const events = new Set<string>();
  const query: Query = async (sql, params = []) => {
    seen.push({ sql, params });
    const rows = (r: Row[]) => ({ rows: r, rowCount: r.length });
    if (sql.includes("rate_limits")) return rows([{ hits: 1 }]);
    if (sql.includes("access_tokens")) {
      return rows([{
        id: USER, display_name: "이민아", locale: "ko", plan: "FREE", subscription_status: "NONE", stripe_customer_id: null,
        period_ends_at: null, created_at: NOW.toISOString(), token_expires_at: "2099-01-01T00:00:00Z",
        is_employer: true, company_id: COMPANY, company_role: "ADMIN",
      }]);
    }
    if (sql.includes("idempotency_keys") && sql.includes("INSERT")) return rows([{ id: "idem" }]);
    if (sql.includes("INSERT INTO stripe_events")) {
      const id = String(params[0]);
      if (events.has(id)) return rows([]);
      events.add(id);
      return rows([{ event_id: id }]);
    }
    if (sql.includes("DELETE FROM stripe_events")) events.delete(String(params[0]));
    return rows(reply(sql, params) ?? []);
  };
  const ledger = () => seen.filter((call) => call.sql.includes("INSERT INTO billing_ledger"));
  return { query, seen, ledger };
}

const post = (path: string, body: unknown, origin?: string): Request => new Request("https://core.example" + path, {
  method: "POST",
  headers: {
    authorization: "Bearer t",
    "content-type": "application/json",
    "idempotency-key": crypto.randomUUID(),
    ...(origin ? { origin } : {}),
  },
  body: JSON.stringify(body),
});

const signed = async (event: unknown): Promise<Request> => {
  const payload = JSON.stringify(event);
  const stamp = Math.floor(NOW.getTime() / 1000);
  const hex = await hmacSha256Hex("whsec_test", new TextEncoder().encode(`${stamp}.${payload}`));
  return new Request("https://core.example/api/v1/billing/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": `t=${stamp},v1=${hex}` },
    body: payload,
  });
};

const companyRow = (sql: string): Row[] | undefined =>
  sql.includes("FROM companies") ? [{ id: COMPANY, stripe_customer_id: "cus_VawTPdFMM1vGO3", plan: "PRO" }] : undefined;

const formOf = (call: StripeCall | undefined) => new URLSearchParams(call?.body);

test("plan checkout returns employers to the calling web origin when it is allowlisted", async () => {
  const w = world(companyRow);
  const calls: StripeCall[] = [];
  const res = await handle(post("/api/v1/billing/checkout", { planId: "ULTRA" }, "http://localhost:5174"), envOf(), { query: w.query, now: () => NOW, fetch: stripeFetch(calls) });
  assert.equal(res.status, 200);
  const form = formOf(calls[0]);
  assert.equal(form.get("success_url"), "http://localhost:5174/employer/plans?checkout=success&session_id={CHECKOUT_SESSION_ID}");
  assert.equal(form.get("cancel_url"), "http://localhost:5174/employer/plans?checkout=canceled");
});

test("an unlisted or missing origin falls back to the first allowlisted origin, never the caller's", async () => {
  for (const origin of ["https://evil.example", "https://push.example.evil.example", "push://billing", undefined]) {
    resetLimits();
    const w = world(companyRow);
    const calls: StripeCall[] = [];
    const res = await handle(post("/api/v1/billing/checkout", { planId: "PRO" }, origin), envOf(), { query: w.query, now: () => NOW, fetch: stripeFetch(calls) });
    assert.equal(res.status, 200, String(origin));
    assert.equal(formOf(calls[0]).get("success_url"), "https://push.example/employer/plans?checkout=success&session_id={CHECKOUT_SESSION_ID}");
    assert.equal(formOf(calls[0]).get("cancel_url"), "https://push.example/employer/plans?checkout=canceled");
  }
});

test("credit purchase returns to the plans page with checkout=credits", async () => {
  const w = world(companyRow);
  const calls: StripeCall[] = [];
  const res = await handle(post("/api/v1/billing/topup", { packs: 2 }, "https://push.example"), envOf(), { query: w.query, now: () => NOW, fetch: stripeFetch(calls) });
  assert.equal(res.status, 200);
  const form = formOf(calls[0]);
  assert.equal(form.get("mode"), "payment");
  assert.equal(form.get("line_items[0][quantity]"), "2");
  assert.equal(form.get("metadata[amountMicroCredits]"), String(2 * 1500 * 6000));
  assert.equal(form.get("success_url"), "https://push.example/employer/plans?checkout=credits&session_id={CHECKOUT_SESSION_ID}");
  assert.equal(form.get("cancel_url"), "https://push.example/employer/plans?checkout=canceled");
});

test("checkout without a valid return origin is not configured and never calls Stripe", async () => {
  for (const origins of [undefined, "", "push://billing/success", "https://push.example/employer", "javascript:alert(1)"]) {
    for (const path of ["/api/v1/billing/checkout", "/api/v1/billing/topup"]) {
      resetLimits();
      const w = world(companyRow);
      const calls: StripeCall[] = [];
      const res = await handle(post(path, { planId: "PRO", packs: 1 }, "https://push.example"), envOf({ STRIPE_RETURN_ORIGINS: origins }), { query: w.query, now: () => NOW, fetch: stripeFetch(calls) });
      assert.equal(res.status, 503, `${path} ${origins}`);
      assert.equal((await res.json() as { error: { code: string } }).error.code, "NOT_CONFIGURED");
      assert.equal(calls.length, 0);
    }
  }
});

const planCompleted = {
  id: "evt_plan_ultra",
  type: "checkout.session.completed",
  data: { object: {
    id: "cs_test_ultra",
    object: "checkout.session",
    mode: "subscription",
    payment_status: "paid",
    amount_total: 20000,
    currency: "usd",
    customer: "cus_VawTPdFMM1vGO3",
    subscription: "sub_1UZkat0iRL0sMmznsruv4T1R",
    invoice: "in_1UZkat0iRL0sMmznrJtHIQOA",
    payment_intent: null,
    client_reference_id: COMPANY,
    metadata: { audience: "EMPLOYER", plan: "ULTRA" },
  } },
};

test("a receipt lookup failure still records the plan payment with a null receipt", async () => {
  const w = world();
  const fetchImpl = stripeFetch([], (call) => call.url.includes("/v1/invoices/") ? json({ error: {} }, 500) : json({ id: "sub_1UZkat0iRL0sMmznsruv4T1R", status: "canceled" }));
  const res = await handle(await signed(planCompleted), envOf(), { query: w.query, now: () => NOW, fetch: fetchImpl });
  assert.equal(res.status, 200);
  assert.deepEqual(w.ledger()[0]?.params.slice(1), [COMPANY, 0, "cs_test_ultra", NOW.toISOString(), "Ultra 월 구독", 20000, null]);
});

test("a payment in another currency keeps its row but stores no USD amount", async () => {
  const w = world();
  const fetchImpl = stripeFetch([], () => json({ id: "sub_1UZkat0iRL0sMmznsruv4T1R", status: "canceled" }));
  const event = { ...planCompleted, id: "evt_krw", data: { object: { ...planCompleted.data.object, id: "cs_test_krw", currency: "krw", amount_total: 28000000, invoice: null } } };
  const res = await handle(await signed(event), envOf(), { query: w.query, now: () => NOW, fetch: fetchImpl });
  assert.equal(res.status, 200);
  assert.deepEqual(w.ledger()[0]?.params.slice(5), ["Ultra 월 구독", null, null]);
});

test("a credit purchase completion credits the company with 크레딧 구매, the paid amount, and the charge receipt", async () => {
  const w = world();
  const calls: StripeCall[] = [];
  const fetchImpl = stripeFetch(calls, () => json({ id: "pi_test", latest_charge: { id: "ch_test", receipt_url: "https://pay.stripe.com/receipts/payment/test_ch" } }));
  const event = {
    id: "evt_topup",
    type: "checkout.session.completed",
    data: { object: {
      id: "cs_test_topup", mode: "payment", payment_status: "paid", amount_total: 2000, currency: "usd", customer: "cus_VawTPdFMM1vGO3",
      payment_intent: "pi_test", invoice: null, client_reference_id: COMPANY,
      metadata: { amountMicroCredits: String(2 * 1500 * 6000), audience: "EMPLOYER", ownerId: COMPANY },
    } },
  };
  const res = await handle(await signed(event), envOf(), { query: w.query, now: () => NOW, fetch: fetchImpl });
  assert.equal(res.status, 200);
  assert.deepEqual(w.ledger()[0]?.params.slice(1), [COMPANY, 18_000_000, "cs_test_topup", NOW.toISOString(), "크레딧 구매", 2000, "https://pay.stripe.com/receipts/payment/test_ch"]);
  assert.equal(calls[0]?.url, "https://api.stripe.com/v1/payment_intents/pi_test?expand[]=latest_charge");
  assert.equal(w.seen.some((call) => call.sql.startsWith("UPDATE companies")), false);
});

const invoice = (extra: Row = {}) => ({
  id: "evt_renewal",
  type: "invoice.paid",
  data: { object: {
    id: "in_renewal",
    object: "invoice",
    billing_reason: "subscription_cycle",
    amount_paid: 10000,
    total: 10000,
    currency: "usd",
    customer: "cus_VawTPdFMM1vGO3",
    hosted_invoice_url: RECEIPT,
    lines: { data: [{ amount: 10000, pricing: { price_details: { price: PRO_PRICE }, type: "price_details" } }] },
    ...extra,
  } },
});

test("a renewal invoice adds a zero-credit payment row once", async () => {
  const w = world(companyRow);
  const first = await handle(await signed(invoice()), envOf(), { query: w.query, now: () => NOW });
  assert.equal(first.status, 200);
  assert.deepEqual(w.ledger()[0]?.params.slice(1), [COMPANY, 0, "in_renewal", NOW.toISOString(), "Pro 월 구독", 10000, RECEIPT]);
  await handle(await signed(invoice()), envOf(), { query: w.query, now: () => NOW });
  assert.equal(w.ledger().length, 1);
});

test("first invoices, fully covered invoices, and personal customers add no payment row", async () => {
  const cases: [Row, ((sql: string) => Row[] | undefined)][] = [
    [{ billing_reason: "subscription_create" }, companyRow],
    [{ amount_paid: 0, total: 0 }, companyRow],
    [{}, () => undefined],
  ];
  for (const [extra, reply] of cases) {
    resetLimits();
    const w = world(reply);
    const res = await handle(await signed({ ...invoice(extra), id: "evt_" + crypto.randomUUID() }), envOf(), { query: w.query, now: () => NOW });
    assert.equal(res.status, 200);
    assert.equal(w.ledger().length, 0, JSON.stringify(extra));
  }
});

test("deleting the subscription a plan change replaced leaves the company plan alone", async () => {
  const w = world((sql) => sql.startsWith("SELECT id FROM companies") ? [{ id: COMPANY }] : undefined);
  const res = await handle(await signed({
    id: "evt_old_deleted",
    type: "customer.subscription.deleted",
    data: { object: { id: "sub_1UZkaj0iRL0sMmznl3T10Y1Q", customer: "cus_VawTPdFMM1vGO3", status: "canceled", items: { data: [{ price: { id: PRO_PRICE } }] } } },
  }), envOf(), { query: w.query, now: () => NOW });
  assert.equal(res.status, 200);
  const update = w.seen.find((call) => call.sql.startsWith("UPDATE companies SET plan = NULL"));
  assert.match(update?.sql ?? "", /stripe_subscription_id IS NULL OR stripe_subscription_id = \$2/);
  assert.deepEqual(update?.params, ["cus_VawTPdFMM1vGO3", "sub_1UZkaj0iRL0sMmznl3T10Y1Q"]);
  assert.equal(w.seen.some((call) => call.sql.startsWith("UPDATE users")), false);
});

test("a replaced subscription's negative final invoice adds a 요금제 변경 환급 row with the refunded amount", async () => {
  const w = world(companyRow);
  const res = await handle(await signed({ ...invoice({
    id: "in_1UZkb80iRL0sMmznDmcpmzrV", status: "paid", amount_paid: 0, amount_due: 0, total: -10000, ending_balance: -10000,
    lines: { data: [{ amount: -10000, description: "Unused time on Push Employer Pro after 09 Nov 2026", pricing: { price_details: { price: PRO_PRICE }, type: "price_details" } }] },
  }), id: "evt_1UZl9Q0iRL0sMmznDqgeuoxv" }), envOf(), { query: w.query, now: () => NOW });
  assert.equal(res.status, 200);
  assert.deepEqual(w.ledger()[0]?.params.slice(1), [COMPANY, 0, "in_1UZkb80iRL0sMmznDmcpmzrV", NOW.toISOString(), "요금제 변경 환급", -10000, RECEIPT]);
});

test("credit packs outside 1 to 20, or the old amount field, are a 400 on packs and never reach Stripe", async () => {
  for (const body of [{ packs: 0 }, { packs: 21 }, { packs: 1.5 }, { packs: "3" }, { packs: null }, { amount: 50 }]) {
    resetLimits();
    const w = world(companyRow);
    const calls: StripeCall[] = [];
    const res = await handle(post("/api/v1/billing/topup", body, "https://push.example"), envOf(), { query: w.query, now: () => NOW, fetch: stripeFetch(calls) });
    assert.equal(res.status, 400, JSON.stringify(body));
    const error = (await res.json() as { error: { code: string; details?: { field?: string } } }).error;
    assert.equal(error.code, "VALIDATION_ERROR");
    assert.equal(error.details?.field, "packs");
    assert.equal(calls.length, 0);
  }
  resetLimits();
  const calls: StripeCall[] = [];
  const max = await handle(post("/api/v1/billing/topup", { packs: 20 }, "https://push.example"), envOf(), { query: world(companyRow).query, now: () => NOW, fetch: stripeFetch(calls) });
  assert.equal(max.status, 200);
  assert.equal(formOf(calls[0]).get("metadata[amountMicroCredits]"), String(20 * 1500 * 6000));
});

test("the ledger returns description, amountUsd, and receiptUrl", async () => {
  const w = world((sql) => sql.includes("FROM billing_ledger") ? [{
    id: "f1000000-0000-4000-8000-000000000001", type: "PURCHASE", amount_micro_credits: 0, balance_after: 90_000_000,
    reference_id: "in_renewal", created_at: "2026-10-01T00:00:00Z", description: "Pro 월 구독", amount_usd_cents: 10050, receipt_url: RECEIPT,
  }] : undefined);
  const res = await handle(new Request("https://core.example/api/v1/billing/ledger", { headers: { authorization: "Bearer t" } }), envOf(), { query: w.query, now: () => NOW });
  assert.equal(res.status, 200);
  const body = await res.json() as { data: Row[] };
  assert.deepEqual(body.data[0], {
    id: "f1000000-0000-4000-8000-000000000001", type: "PURCHASE", amountMicroCredits: 0, balanceAfter: 90_000_000,
    referenceId: "in_renewal", createdAt: "2026-10-01T00:00:00Z", description: "Pro 월 구독", amountUsd: 100.5, receiptUrl: RECEIPT,
  });
});
