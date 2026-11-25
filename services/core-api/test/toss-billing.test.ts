import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { handle } from '../src/handler.ts';
import type { CoreEnv, Deps } from '../src/handler.ts';
import { resetLimits } from "../src/ratelimit.ts";

const USER = "12345678-1234-5678-1234-567812345678";
const COMPANY = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OTHER_COMPANY = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const NOW = new Date("2026-11-19T00:00:00.000Z");
const JOB_TOKEN = "job-token";
type Row = Awaited<ReturnType<Deps["query"]>>["rows"][number];

const noRows: Array<Row> = [];
const empty = { rows: noRows, rowCount: 0 };

const isRow = (value: unknown): value is Row => typeof value === "object" && value !== null && !Array.isArray(value);
const textOrNull = (value: unknown): string | null => (typeof value === "string" ? value : null);
const numberOrNull = (value: unknown): number | null => (typeof value === "number" ? value : null);

type Bill = {
  customer_key: string; billing_key_enc: string | null; plan: string | null; period_start: string | null;
  period_end: string | null; next_charge_at: string | null; canceled_at: string | null; failures: number;
};
type Order = { company: string; kind: string; packs: number | null; amount: number; status: string; receipt: string | null };
type Ledger = { reference: string; amount: number; krw: number | null; description: string | null };
type Fetched = { url: string; headers: Record<string, string>; body: Row };

const world = {
  bill: null as Bill | null,
  orders: new Map<string, Order>(),
  ledger: [] as Array<Ledger>,
  companyPlan: null as string | null,
  companyPeriod: null as string | null,
  fetched: [] as Array<Fetched>,
  chargeStatus: "DONE",
  confirmStatus: "DONE",
};

beforeEach(() => {
  resetLimits();
  world.bill = null;
  world.orders.clear();
  world.ledger.length = 0;
  world.companyPlan = null;
  world.companyPeriod = null;
  world.fetched.length = 0;
  world.chargeStatus = "DONE";
  world.confirmStatus = "DONE";
});

const env: CoreEnv = { APP_ENV: "production", PAYMENTS_ENABLED: "1", TOSS_SECRET_KEY: "test_sk_secret", TOKEN_ENCRYPTION_KEY: "test-master", INTERNAL_JOB_TOKEN: JOB_TOKEN };

const rowOf = (rows: Array<Row>) => ({ rows, rowCount: rows.length });

const database = (employer: boolean, role: string | null): Deps["query"] => async (sql, params = []) => {
  if (sql.includes("rate_limits")) {return rowOf([{ hits: 1 }]);}
  if (sql.includes("access_tokens")) {
    return rowOf([{
      id: USER, display_name: "Ada", locale: "ko", plan: "FREE", subscription_status: "NONE", stripe_customer_id: null,
      period_ends_at: null, created_at: NOW.toISOString(), token_expires_at: "2099-01-01T00:00:00Z",
      is_employer: employer, company_id: role ? COMPANY : null, company_role: role,
    }]);
  }
  if (sql.includes("idempotency_keys") && sql.includes("INSERT")) {return rowOf([{ id: crypto.randomUUID() }]);}
  if (sql.includes("idempotency_keys")) {return empty;}
  if (sql.includes("FOR NO KEY UPDATE")) {return rowOf([{ id: COMPANY }]);}
  if (sql.startsWith("SELECT 1 FROM companies")) {return rowOf([{ one: 1 }]);}
  if (sql.startsWith("SELECT plan, credit_period_start FROM companies")) {return rowOf([{ plan: world.companyPlan, credit_period_start: world.companyPeriod }]);}
  if (sql.startsWith("UPDATE companies SET plan = NULL")) {
    world.companyPlan = null;
    world.companyPeriod = null;
    return empty;
  }
  if (sql.startsWith("UPDATE companies SET plan = $2")) {
    world.companyPlan = String(params[1]);
    world.companyPeriod = String(params[2]);
    return empty;
  }
  if (sql.startsWith("INSERT INTO toss_billing")) {
    world.bill ??= { customer_key: String(params[1]), billing_key_enc: null, plan: null, period_start: null, period_end: null, next_charge_at: null, canceled_at: null, failures: 0 };
    return empty;
  }
  if (sql.includes("FROM toss_billing WHERE next_charge_at")) {
    const due = world.bill?.plan && world.bill.next_charge_at && world.bill.next_charge_at <= String(params[0]);
    return rowOf(due ? [{ company_id: COMPANY, ...world.bill }] : []);
  }
  if (sql.includes("FROM toss_billing")) {return rowOf(world.bill ? [world.bill] : []);}
  if (sql.startsWith("UPDATE toss_billing SET billing_key_enc = COALESCE") && world.bill) {
    Object.assign(world.bill, {
      billing_key_enc: textOrNull(params[1]) ?? world.bill.billing_key_enc, plan: params[2], period_start: params[3],
      period_end: params[4], next_charge_at: params[4], canceled_at: null, failures: 0,
    });
    return empty;
  }
  if (sql.startsWith("UPDATE toss_billing SET canceled_at") && world.bill) {
    world.bill.canceled_at ??= String(params[1]);
    return empty;
  }
  if (sql.startsWith("UPDATE toss_billing SET failures") && world.bill) {
    world.bill.failures = Number(params[1]);
    return empty;
  }
  if (sql.startsWith("UPDATE toss_billing SET plan = NULL") && world.bill) {
    Object.assign(world.bill, { plan: null, billing_key_enc: null, next_charge_at: null, failures: 0 });
    return empty;
  }
  if (sql.startsWith("INSERT INTO toss_orders")) {
    if (!world.orders.has(String(params[0]))) {
      world.orders.set(String(params[0]), { company: String(params[1]), kind: String(params[2]), packs: numberOrNull(params[4]), amount: Number(params[5]), status: "PENDING", receipt: null });
    }
    return empty;
  }
  if (sql.includes("FROM toss_orders")) {
    const order = world.orders.get(String(params[0]));
    return rowOf(order && order.company === params[1] ? [{ kind: order.kind, packs: order.packs, amount: order.amount, status: order.status, receipt_url: order.receipt }] : []);
  }
  if (sql.startsWith("UPDATE toss_orders SET status = 'FAILED'")) {
    const order = world.orders.get(String(params[0]));
    if (order?.status === "PENDING") {order.status = "FAILED";}
    return empty;
  }
  if (sql.startsWith("UPDATE toss_orders SET status = 'DONE'")) {
    const order = world.orders.get(String(params[0]));
    if (order) {Object.assign(order, { status: "DONE", receipt: params[2] });}
    return empty;
  }
  if (sql.includes("INSERT INTO billing_ledger")) {
    const reference = String(params[3]);
    if (world.ledger.some((row) => row.reference === reference)) {return empty;}
    world.ledger.push({ reference, amount: Number(params[2]), krw: sql.includes("amount_krw") ? numberOrNull(params[9]) : null, description: sql.includes("amount_krw") ? textOrNull(params[5]) : null });
    return rowOf([{ id: "ledger" }]);
  }
  if (sql.includes("balance_after")) {return rowOf([{ balance_after: 0 }]);}
  return empty;
};

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

const tossFetch = (): typeof fetch => (async (input, init) => {
  const url = String(input);
  const parsed: unknown = JSON.parse(String(init?.body ?? "{}"));
  const body: Row = isRow(parsed) ? parsed : {};
  world.fetched.push({ url, headers: Object.fromEntries(new Headers(init?.headers)), body });
  if (url.endsWith("/v1/billing/authorizations/issue")) {return json({ billingKey: "bk_plain_secret" });}
  if (url.includes("/v1/billing/")) {
    if (world.chargeStatus === "DECLINED") {return json({ code: "REJECT_CARD_PAYMENT", message: "no" }, 400);}
    return json({ status: world.chargeStatus, paymentKey: "pk_charge", receipt: { url: "https://dashboard.tosspayments.com/receipt/1" } });
  }
  if (world.confirmStatus === "DECLINED") {return json({ code: "REJECT_CARD_PAYMENT" }, 400);}
  return json({ status: world.confirmStatus, paymentKey: body.paymentKey, receipt: { url: "https://dashboard.tosspayments.com/receipt/2" } });
});

const call = async (path: string, body: unknown, options: { employer?: boolean; role?: string | null; key?: string; env?: CoreEnv } = {}): Promise<Response> => {
  const employer = options.employer ?? true;
  const role = options.role === undefined ? "ADMIN" : options.role;
  return handle(new Request("https://core.example" + path, {
    method: "POST",
    headers: { authorization: "Bearer secret-token", "content-type": "application/json", "idempotency-key": options.key ?? crypto.randomUUID() },
    body: JSON.stringify(body),
  }), options.env ?? env, { query: database(employer, role), now: () => NOW, fetch: tossFetch() });
};

const dataOf = async (res: Response): Promise<Row> => {
  const body: { data: Row } = await res.json();
  return body.data;
};
const codeOf = async (res: Response): Promise<string> => {
  const body: { error: { code: string } } = await res.json();
  return body.error.code;
};

const readStatus = async () => dataOf(await handle(new Request("https://core.example/api/v1/billing", { headers: { authorization: "Bearer secret-token" } }),
  env, { query: database(true, "ADMIN"), now: () => NOW }));

const subscribe = async (planId = "PRO"): Promise<string> => {
  const auth = await dataOf(await call("/api/v1/billing/toss/billing-auth", { planId }));
  const customerKey = String(auth.customerKey);
  const res = await call("/api/v1/billing/toss/billing-confirm", { authKey: "auth_1", customerKey, planId });
  assert.equal(res.status, 200);
  return customerKey;
};

const renew = (at: Date, token = JOB_TOKEN): Promise<Response> => handle(new Request("https://core.example/api/v1/internal/billing/toss-renew", {
  method: "POST", headers: { authorization: `Bearer ${token}` },
}), env, { query: database(true, "ADMIN"), now: () => at, fetch: tossFetch() });

test("billing-auth returns a stable customerKey and the plan price without charging", async () => {
  const first = await dataOf(await call("/api/v1/billing/toss/billing-auth", { planId: "PRO" }));
  const second = await dataOf(await call("/api/v1/billing/toss/billing-auth", { planId: "ULTRA" }));
  assert.equal(first.amount, 140_000);
  assert.equal(first.orderName, "Pro 월 구독");
  assert.equal(second.amount, 280_000);
  assert.equal(first.customerKey, second.customerKey);
  assert.equal(world.fetched.length, 0);
});

test("toss endpoints refuse members, personal accounts and closed payments", async () => {
  assert.equal((await call("/api/v1/billing/toss/billing-auth", { planId: "PRO" }, { role: "MEMBER" })).status, 403);
  assert.equal((await call("/api/v1/billing/toss/billing-auth", { planId: "PRO" }, { employer: false, role: null })).status, 403);
  assert.equal((await call("/api/v1/billing/toss/topup", { packs: 1 }, { role: "MEMBER" })).status, 403);
  assert.equal((await call("/api/v1/billing/toss/cancel", {}, { role: "MEMBER" })).status, 403);
  const closed = await call("/api/v1/billing/toss/billing-auth", { planId: "PRO" }, { env: { ...env, PAYMENTS_ENABLED: "0" } });
  assert.equal(closed.status, 503);
  assert.equal(await codeOf(closed), "PAYMENTS_DISABLED");
  assert.equal((await call("/api/v1/billing/toss/billing-auth", { planId: "FREE" })).status, 400);
});

test("billing-confirm issues the key, charges the first month, grants credits and encrypts the key", async () => {
  const customerKey = await subscribe("PRO");
  assert.equal(world.fetched[0]?.url, "https://api.tosspayments.com/v1/billing/authorizations/issue");
  assert.equal(world.fetched[0]?.headers.authorization, "Basic " + btoa("test_sk_secret:"));
  const charge = world.fetched[1];
  assert.equal(charge?.url, "https://api.tosspayments.com/v1/billing/bk_plain_secret");
  assert.equal(charge?.body.amount, 140_000);
  assert.equal(charge?.body.customerKey, customerKey);
  assert.match(String(charge?.headers["idempotency-key"]), /^toss-first-/);
  assert.equal(world.bill?.plan, "PRO");
  assert.equal(world.bill?.period_end, "2026-12-19T00:00:00.000Z");
  assert.equal(world.bill?.next_charge_at, "2026-12-19T00:00:00.000Z");
  assert.ok(world.bill?.billing_key_enc);
  assert.ok(!world.bill?.billing_key_enc?.includes("bk_plain_secret"));
  assert.equal(world.companyPlan, "PRO");
  const payment = world.ledger.find((row) => row.krw === 140_000);
  assert.equal(payment?.description, "Pro 월 구독");
  assert.equal(payment?.amount, 0);
  const grants = world.ledger.filter((row) => row.reference.startsWith("period:toss-" + COMPANY));
  assert.equal(grants.reduce((sum, row) => sum + row.amount, 0), 90_000_000);
});

test("billing-confirm returns plan, amount and receipt", async () => {
  const auth = await dataOf(await call("/api/v1/billing/toss/billing-auth", { planId: "BASIC" }));
  const res = await call("/api/v1/billing/toss/billing-confirm", { authKey: "a", customerKey: auth.customerKey, planId: "BASIC" });
  assert.deepEqual(await dataOf(res), { plan: "BASIC", amount: 29_000, receiptUrl: "https://dashboard.tosspayments.com/receipt/1" });
});

test("billing-confirm rejects another company's customerKey before calling Toss", async () => {
  await call("/api/v1/billing/toss/billing-auth", { planId: "PRO" });
  const res = await call("/api/v1/billing/toss/billing-confirm", { authKey: "a", customerKey: OTHER_COMPANY, planId: "PRO" });
  assert.equal(res.status, 403);
  assert.equal(world.fetched.length, 0);
  assert.equal(world.bill?.plan, null);
});

test("billing-confirm before billing-auth is a conflict", async () => {
  const res = await call("/api/v1/billing/toss/billing-confirm", { authKey: "a", customerKey: OTHER_COMPANY, planId: "PRO" });
  assert.equal(res.status, 409);
});

test("a declined first charge sets no plan and grants nothing", async () => {
  const auth = await dataOf(await call("/api/v1/billing/toss/billing-auth", { planId: "PRO" }));
  world.chargeStatus = "DECLINED";
  const res = await call("/api/v1/billing/toss/billing-confirm", { authKey: "a", customerKey: auth.customerKey, planId: "PRO" });
  assert.equal(res.status, 402);
  assert.equal(await codeOf(res), "PAYMENT_FAILED");
  assert.equal(world.bill?.plan, null);
  assert.equal(world.companyPlan, null);
  assert.equal(world.ledger.length, 0);
  assert.deepEqual([...world.orders.values()].map((order) => order.status), ["FAILED"]);
});

test("changing plan charges the new plan at once and restarts the period", async () => {
  await subscribe("BASIC");
  await subscribe("ULTRA");
  assert.equal(world.bill?.plan, "ULTRA");
  const charges = world.fetched.filter((item) => item.url.includes("/v1/billing/bk_"));
  assert.deepEqual(charges.map((item) => item.body.amount), [29_000, 280_000]);
});

test("topup creates a pending order priced by the server", async () => {
  const res = await call("/api/v1/billing/toss/topup", { packs: 3 });
  const body = await dataOf(res);
  assert.equal(body.amount, 42_000);
  assert.equal(body.orderName, "크레딧 3팩");
  assert.ok(body.customerKey);
  assert.equal(world.orders.get(String(body.orderId))?.status, "PENDING");
  for (const packs of [0, 21, 1.5, "2"]) {assert.equal((await call("/api/v1/billing/toss/topup", { packs })).status, 400);}
});

const order = async (packs = 2): Promise<{ orderId: string; amount: number }> => {
  const body = await dataOf(await call("/api/v1/billing/toss/topup", { packs }));
  return { orderId: String(body.orderId), amount: Number(body.amount) };
};

test("topup-confirm confirms with Toss and grants the pack credits once per order", async () => {
  const { orderId, amount } = await order(2);
  const first = await call("/api/v1/billing/toss/topup-confirm", { paymentKey: "pk_1", orderId, amount });
  assert.deepEqual(await dataOf(first), { creditsAdded: 3000, receiptUrl: "https://dashboard.tosspayments.com/receipt/2" });
  const confirmCall = world.fetched.find((item) => item.url.endsWith("/v1/payments/confirm"));
  assert.deepEqual(confirmCall?.body, { paymentKey: "pk_1", orderId, amount: 28_000 });
  const second = await call("/api/v1/billing/toss/topup-confirm", { paymentKey: "pk_1", orderId, amount });
  assert.deepEqual(await dataOf(second), { creditsAdded: 3000, receiptUrl: "https://dashboard.tosspayments.com/receipt/2" });
  assert.equal(world.fetched.filter((item) => item.url.endsWith("/v1/payments/confirm")).length, 1);
  const rows = world.ledger.filter((row) => row.reference === orderId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.amount, 3000 * 6000);
  assert.equal(rows[0]?.krw, 28_000);
  assert.equal(rows[0]?.description, "크레딧 구매");
});

test("topup-confirm refuses a wrong amount, a foreign order and a declined payment", async () => {
  const { orderId, amount } = await order(1);
  const mismatch = await call("/api/v1/billing/toss/topup-confirm", { paymentKey: "pk", orderId, amount: amount - 1 });
  assert.equal(mismatch.status, 400);
  assert.equal(world.fetched.length, 0);
  const foreign = await call("/api/v1/billing/toss/topup-confirm", { paymentKey: "pk", orderId: crypto.randomUUID(), amount });
  assert.equal(foreign.status, 404);
  world.confirmStatus = "DECLINED";
  const declined = await call("/api/v1/billing/toss/topup-confirm", { paymentKey: "pk", orderId, amount });
  assert.equal(declined.status, 402);
  assert.equal(world.ledger.length, 0);
});

test("cancel marks the subscription canceled and keeps the plan", async () => {
  assert.equal((await call("/api/v1/billing/toss/cancel", {})).status, 409);
  await subscribe("PRO");
  const res = await call("/api/v1/billing/toss/cancel", {});
  assert.equal(res.status, 204);
  assert.equal(world.bill?.canceled_at, NOW.toISOString());
  assert.equal(world.companyPlan, "PRO");
});

test("status shows the toss provider, prices, renewal date and cancel flag", async () => {
  await subscribe("PRO");
  const active = await readStatus();
  assert.equal(active.provider, "toss");
  assert.equal(active.currency, "KRW");
  assert.deepEqual(active.prices, { BASIC: 29_000, PRO: 140_000, ULTRA: 280_000, pack: 14_000 });
  assert.equal(active.renewsAt, "2026-12-19T00:00:00Z");
  assert.equal(active.canceled, false);
  assert.equal(active.source, "TOSS");
  await call("/api/v1/billing/toss/cancel", {});
  const canceled = await readStatus();
  assert.equal(canceled.renewsAt, null);
  assert.equal(canceled.canceled, true);
});

const LATER = new Date("2026-12-19T00:30:00.000Z");

test("renewal charges a due company, extends the period and grants the monthly credits", async () => {
  await subscribe("PRO");
  const before = world.ledger.length;
  const res = await renew(LATER);
  assert.deepEqual(await dataOf(res), { renewed: 1, failed: 0, dropped: 0 });
  const charges = world.fetched.filter((item) => item.url.includes("/v1/billing/bk_"));
  assert.equal(charges.length, 2);
  assert.match(String(charges[1]?.headers["idempotency-key"]), new RegExp(`^toss-renew:${COMPANY}:`));
  assert.equal(world.bill?.period_start, "2026-12-19T00:00:00.000Z");
  assert.equal(world.bill?.period_end, "2027-01-19T00:00:00.000Z");
  assert.equal(world.bill?.next_charge_at, "2027-01-19T00:00:00.000Z");
  assert.ok(world.ledger.length > before);
  const renewalGrants = world.ledger.filter((row) => row.reference.startsWith(`period:toss-${COMPANY}:${Date.parse("2026-12-19T00:00:00Z") / 1000}`));
  assert.equal(renewalGrants.reduce((sum, row) => sum + row.amount, 0), 90_000_000);
  const again = await renew(LATER);
  assert.deepEqual(await dataOf(again), { renewed: 0, failed: 0, dropped: 0 });
});

test("renewal does nothing before the period ends", async () => {
  await subscribe("PRO");
  const res = await renew(new Date("2026-12-18T00:00:00.000Z"));
  assert.deepEqual(await dataOf(res), { renewed: 0, failed: 0, dropped: 0 });
});

test("a failed renewal retries on the next run and drops the plan after three failures", async () => {
  await subscribe("PRO");
  world.chargeStatus = "DECLINED";
  assert.deepEqual(await dataOf(await renew(LATER)), { renewed: 0, failed: 1, dropped: 0 });
  assert.equal(world.bill?.failures, 1);
  assert.equal(world.companyPlan, "PRO");
  assert.deepEqual(await dataOf(await renew(LATER)), { renewed: 0, failed: 1, dropped: 0 });
  assert.equal(world.bill?.failures, 2);
  const keys = world.fetched.filter((item) => item.url.includes("/v1/billing/bk_")).map((item) => item.headers["idempotency-key"]);
  assert.equal(new Set(keys).size, keys.length);
  assert.deepEqual(await dataOf(await renew(LATER)), { renewed: 0, failed: 0, dropped: 1 });
  assert.equal(world.companyPlan, null);
  assert.equal(world.bill?.plan, null);
  assert.equal(world.bill?.billing_key_enc, null);
});

test("a canceled subscription loses its plan at the period end without a charge", async () => {
  await subscribe("PRO");
  await call("/api/v1/billing/toss/cancel", {});
  const chargesBefore = world.fetched.length;
  assert.deepEqual(await dataOf(await renew(LATER)), { renewed: 0, failed: 0, dropped: 1 });
  assert.equal(world.fetched.length, chargesBefore);
  assert.equal(world.companyPlan, null);
  assert.equal(world.bill?.next_charge_at, null);
});

test("the renewal job needs the internal token", async () => {
  assert.equal((await renew(LATER, "wrong")).status, 401);
});
