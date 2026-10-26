import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { hmacSha256Hex } from "../src/crypto.ts";
import type { Query } from "../src/db.ts";
import { handle, type CoreEnv } from "../src/handler.ts";
import { resetLimits } from "../src/ratelimit.ts";

const USER = "12345678-1234-5678-1234-567812345678";
const COMPANY = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const NOW = new Date("2026-10-21T00:00:00.000Z");

type Row = Record<string, unknown>;
type Call = { sql: string; params: unknown[] };
type Body = { data: Row & Row[]; page?: { nextCursor: string | null; hasMore: boolean }; error?: { code: string; details: unknown } };

const envOf = (extra: Partial<CoreEnv> = {}): CoreEnv => ({
  APP_ENV: "production", STRIPE_SECRET_KEY: "sk_test", STRIPE_WEBHOOK_SECRET: "whsec_test", STRIPE_PRICE_PRO: "price_pro",
  STRIPE_PRICE_ULTRA: "price_ultra", STRIPE_PRICE_TOPUP: "price_topup", STRIPE_PORTAL_RETURN_URL: "https://app.example/billing", ...extra,
});

type Who = { employer?: boolean; role?: string | null; customer?: string | null };

function world(who: Who = {}, reply: (sql: string, params: unknown[]) => Row[] | undefined = () => undefined) {
  const seen: Call[] = [];
  const query: Query = async (sql, params = []) => {
    seen.push({ sql, params });
    const rows = (r: Row[]) => ({ rows: r, rowCount: r.length });
    if (sql.includes("rate_limits")) return rows([{ hits: 1 }]);
    if (sql.includes("access_tokens")) {
      return rows([{ id: USER, display_name: "Ada", locale: "ko", plan: "PRO", subscription_status: "ACTIVE", stripe_customer_id: who.customer ?? null,
        period_ends_at: null, created_at: NOW.toISOString(), token_expires_at: "2099-01-01T00:00:00Z", is_employer: who.employer ?? false,
        company_id: who.role === undefined || who.role === null ? null : COMPANY, company_role: who.role ?? null }]);
    }
    if (sql.startsWith("INSERT INTO idempotency_keys")) return rows([{ id: "idem" }]);
    return rows(reply(sql, params) ?? []);
  };
  return { seen, query };
}

const stripeFetch = (calls: { url: string; method: string; body: string }[], reply: () => Response): typeof fetch =>
  (async (input, init) => {
    calls.push({ url: String(input), method: String(init?.method), body: init?.body == null ? "" : String(init.body) });
    return reply();
  }) as typeof fetch;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

const request = (method: string, path: string, body?: unknown) => new Request(`https://core.example${path}`, {
  method,
  headers: { authorization: "Bearer t", "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const read = async (res: Response) => ({ status: res.status, body: await res.json() as Body });

beforeEach(() => resetLimits());

test("billing portal: returns the stripe portal url for the caller's customer", async () => {
  const w = world({ customer: "cus_1" });
  const calls: { url: string; method: string; body: string }[] = [];
  const res = await read(await handle(request("POST", "/api/v1/billing/portal", {}), envOf(),
    { query: w.query, now: () => NOW, fetch: stripeFetch(calls, () => json({ url: "https://billing.stripe.com/p/1" })) }));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data, { url: "https://billing.stripe.com/p/1" });
  assert.equal(calls[0].url, "https://api.stripe.com/v1/billing_portal/sessions");
  assert.equal(calls[0].method, "POST");
  assert.deepEqual(Object.fromEntries(new URLSearchParams(calls[0].body)), { customer: "cus_1", return_url: "https://app.example/billing" });
});

test("billing portal: not configured, no customer, and stripe failures map to 503/409/502", async () => {
  const noFetch = (() => { throw new Error("must not call stripe"); }) as unknown as typeof fetch;
  const off = await read(await handle(request("POST", "/api/v1/billing/portal", {}), envOf({ STRIPE_SECRET_KEY: "" }), { query: world({ customer: "cus_1" }).query, now: () => NOW, fetch: noFetch }));
  assert.equal(off.status, 503);
  assert.equal(off.body.error?.code, "NOT_CONFIGURED");
  resetLimits();
  const none = await read(await handle(request("POST", "/api/v1/billing/portal", {}), envOf(), { query: world().query, now: () => NOW, fetch: noFetch }));
  assert.equal(none.status, 409);
  assert.equal(none.body.error?.code, "INVALID_TRANSITION");
  for (const reply of [() => json({ error: "nope" }, 500), () => json({ url: "" })]) {
    resetLimits();
    const bad = await read(await handle(request("POST", "/api/v1/billing/portal", {}), envOf(), { query: world({ customer: "cus_1" }).query, now: () => NOW, fetch: stripeFetch([], reply) }));
    assert.equal(bad.status, 502);
    assert.equal(bad.body.error?.code, "PROVIDER_ERROR");
  }
});

const ledgerRows = [
  { id: "f1000000-0000-4000-8000-000000000003", type: "PURCHASE", amount_micro_credits: "5000", balance_after: "9000", reference_id: "cs_1", created_at: "2026-10-03T00:00:00Z" },
  { id: "f1000000-0000-4000-8000-000000000002", type: "USAGE", amount_micro_credits: -100, balance_after: 4000, reference_id: null, created_at: "2026-10-02T00:00:00Z" },
  { id: "f1000000-0000-4000-8000-000000000001", type: "GRANT", amount_micro_credits: 4100, balance_after: 4100, reference_id: "monthly:2026-10", created_at: "2026-10-01T00:00:00Z" },
];

test("billing ledger: personal ledger is scoped to the caller and paginated", async () => {
  const w = world({}, (sql, params) => sql.includes("FROM billing_ledger") ? ledgerRows.slice(0, Number(params.at(-1))) : undefined);
  const first = await read(await handle(request("GET", "/api/v1/billing/ledger?limit=2"), envOf(), { query: w.query, now: () => NOW }));
  assert.equal(first.status, 200);
  assert.deepEqual(first.body.data, [
    { id: "f1000000-0000-4000-8000-000000000003", type: "PURCHASE", amountMicroCredits: 5000, balanceAfter: 9000, referenceId: "cs_1", createdAt: "2026-10-03T00:00:00Z" },
    { id: "f1000000-0000-4000-8000-000000000002", type: "USAGE", amountMicroCredits: -100, balanceAfter: 4000, referenceId: null, createdAt: "2026-10-02T00:00:00Z" },
  ]);
  assert.equal(first.body.page?.hasMore, true);
  const sql = w.seen.at(-1)!;
  assert.match(sql.sql, /WHERE user_id = \$1 ORDER BY created_at DESC, id DESC LIMIT \$2$/);
  assert.deepEqual(sql.params, [USER, 3]);

  await handle(request("GET", `/api/v1/billing/ledger?cursor=${first.body.page!.nextCursor}`), envOf(), { query: w.query, now: () => NOW });
  assert.match(w.seen.at(-1)!.sql, /WHERE user_id = \$1 AND \(created_at, id\) < \(\$2, \$3\)/);
  assert.deepEqual(w.seen.at(-1)!.params, [USER, "2026-10-02T00:00:00Z", "f1000000-0000-4000-8000-000000000002", 51]);
});

test("billing ledger: employer ledger reads the company rows only; no company is 404", async () => {
  const w = world({ employer: true, role: "MEMBER" });
  const res = await read(await handle(request("GET", "/api/v1/billing/ledger"), envOf(), { query: w.query, now: () => NOW }));
  assert.equal(res.status, 200);
  assert.match(w.seen.at(-1)!.sql, /WHERE company_id = \$1 AND user_id IS NULL ORDER BY/);
  assert.equal(w.seen.at(-1)!.params[0], COMPANY);
  resetLimits();
  const lost = await read(await handle(request("GET", "/api/v1/billing/ledger"), envOf(), { query: world({ employer: true, role: null }).query, now: () => NOW }));
  assert.equal(lost.status, 404);
});

test("billing topup: employer admin buys for the company using the company's stripe customer", async () => {
  const w = world({ employer: true, role: "ADMIN" }, (sql) => sql.startsWith("SELECT stripe_customer_id FROM companies") ? [{ stripe_customer_id: "cus_co" }] : undefined);
  const calls: { url: string; method: string; body: string }[] = [];
  const res = await read(await handle(request("POST", "/api/v1/billing/topup", { amount: 3 }), envOf(),
    { query: w.query, now: () => NOW, fetch: stripeFetch(calls, () => json({ url: "https://pay.example/topup" })) }));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data, { url: "https://pay.example/topup" });
  const form = Object.fromEntries(new URLSearchParams(calls[0].body));
  assert.equal(form.customer, "cus_co");
  assert.equal(form.client_reference_id, COMPANY);
  assert.equal(form["metadata[audience]"], "EMPLOYER");
  assert.equal(form["metadata[ownerId]"], COMPANY);
  assert.equal(form["line_items[0][quantity]"], "3");
});

test("billing topup: employer member is forbidden and a vanished company is 404", async () => {
  const noFetch = (() => { throw new Error("must not call stripe"); }) as unknown as typeof fetch;
  const member = await read(await handle(request("POST", "/api/v1/billing/topup", { amount: 1 }), envOf(), { query: world({ employer: true, role: "MEMBER" }).query, now: () => NOW, fetch: noFetch }));
  assert.equal(member.status, 403);
  assert.equal(member.body.error?.code, "FORBIDDEN");
  resetLimits();
  const orphan = await read(await handle(request("POST", "/api/v1/billing/topup", { amount: 1 }), envOf(), { query: world({ employer: true, role: null }).query, now: () => NOW, fetch: noFetch }));
  assert.equal(orphan.status, 404);
  resetLimits();
  const gone = await read(await handle(request("POST", "/api/v1/billing/topup", { amount: 1 }), envOf(), { query: world({ employer: true, role: "ADMIN" }).query, now: () => NOW, fetch: noFetch }));
  assert.equal(gone.status, 404);
});

const signed = async (event: unknown): Promise<Request> => {
  const payload = JSON.stringify(event);
  const stamp = Math.floor(NOW.getTime() / 1000);
  const hex = await hmacSha256Hex("whsec_test", new TextEncoder().encode(`${stamp}.${payload}`));
  return new Request("https://core.example/api/v1/billing/webhook", {
    method: "POST", headers: { "content-type": "application/json", "stripe-signature": `t=${stamp},v1=${hex}` }, body: payload,
  });
};

for (const [price, plan] of [["price_pro", "PRO"], ["price_ultra", "ULTRA"], ["price_other", null]] as const) {
  test(`billing webhook: a personal subscription update on ${price} sets plan ${plan}`, async () => {
    const w = world({}, (sql) => {
      if (sql.startsWith("INSERT INTO stripe_events")) return [{ event_id: "evt_1" }];
      if (sql.startsWith("UPDATE users")) return [{ id: USER }];
      return undefined;
    });
    const res = await handle(await signed({
      id: "evt_1", type: "customer.subscription.updated",
      data: { object: { customer: "cus_1", status: "active", current_period_end: 1767225600, items: { data: [{ price: { id: price } }] } } },
    }), envOf(), { query: w.query, now: () => NOW });
    assert.equal(res.status, 200);
    const update = w.seen.find((c) => c.sql.startsWith("UPDATE users"))!;
    assert.deepEqual(update.params, ["cus_1", "ACTIVE", "2026-01-01T00:00:00.000Z", plan]);
  });
}

test("billing webhook: an update for an unknown customer fails and forgets the event so Stripe retries", async () => {
  const w = world({}, (sql) => sql.startsWith("INSERT INTO stripe_events") ? [{ event_id: "evt_2" }] : undefined);
  const res = await read(await handle(await signed({
    id: "evt_2", type: "customer.subscription.updated", data: { object: { customer: "cus_ghost", status: "active" } },
  }), envOf(), { query: w.query, now: () => NOW }));
  assert.equal(res.status, 500);
  const forget = w.seen.find((c) => c.sql.startsWith("DELETE FROM stripe_events"));
  assert.deepEqual(forget?.params, ["evt_2"]);
});
