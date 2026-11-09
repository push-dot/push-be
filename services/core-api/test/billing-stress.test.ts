// Employer billing under concurrency, on a real Postgres (BILLING_PG_URL, as in billing-money.test.ts).
// Each seed writes one company's Stripe history (checkouts that upgrade, downgrade or swap, renewals, failed renewals,
// late payments, cancels) into a fake Stripe that answers after a random delay, fires the real webhook handlers for every
// event concurrently with duplicate deliveries, Stripe retries, billing reads and the enqueue grant, then checks the money.
// BILLING_STRESS_SEEDS (default 20) and BILLING_STRESS_SEED (first seed, default 1) pick the runs; BILLING_STRESS_SERIAL=1
// handles one delivery at a time, which separates rule bugs from interleaving bugs.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { ensureMonthlyGrant } from "../src/billing/credits.ts";
import { hmacSha256Hex } from "../src/crypto.ts";
import type { Query } from "../src/db.ts";
import { handle, type CoreEnv } from "../src/handler.ts";
import { resetLimits } from "../src/ratelimit.ts";
import { livePg, type LivePg } from "./parity/pg.ts";

const URL_ = process.env.BILLING_PG_URL;
const SEEDS = Number(process.env.BILLING_STRESS_SEEDS ?? 20);
const FIRST = Number(process.env.BILLING_STRESS_SEED ?? 1);
const PRICE = { BASIC: "price_basic", PRO: "price_pro", ULTRA: "price_ultra" } as const;
const CENTS = { BASIC: 2000, PRO: 10000, ULTRA: 20000 } as const;
const CREDITS = { BASIC: 3000, PRO: 15000, ULTRA: 30000 } as const;
const MICRO = 6000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const PERIOD = 30 * DAY;
const START = Date.parse("2026-11-02T09:00:00.000Z");

type Plan = keyof typeof PRICE;
type Row = Record<string, unknown>;
type Sub = { id: string; plan: Plan; status: "active" | "past_due" | "canceled"; created: number; start: number; end: number; comment: string | null };
type Invoice = { id: string; sub: string; plan: Plan; start: number; status: "open" | "paid" | "void"; reason: "subscription_create" | "subscription_cycle" };
type Refund = { sub: string; plan: Plan; start: number; paid: boolean; newerLive: number };

const env: CoreEnv = {
  APP_ENV: "production",
  STRIPE_SECRET_KEY: "sk_test",
  STRIPE_WEBHOOK_SECRET: "whsec_test",
  STRIPE_PRICE_EMPLOYER_BASIC: PRICE.BASIC,
  STRIPE_PRICE_EMPLOYER_PRO: PRICE.PRO,
  STRIPE_PRICE_EMPLOYER_ULTRA: PRICE.ULTRA,
  STRIPE_RETURN_ORIGINS: "http://localhost:5174",
};

let pg: LivePg | undefined;
before(async () => { if (URL_) pg = await livePg(URL_, 40); });
after(async () => { await pg?.close(); });

const mulberry = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const unix = (ms: number) => Math.floor(ms / 1000);

function stripeWorld(customer: string, latency: () => number, clock: () => number) {
  let serial = 0;
  const subs = new Map<string, Sub>();
  const invoices = new Map<string, Invoice>();
  const refunds: Refund[] = [];
  const events: Row[] = [];
  const next = (prefix: string) => `${prefix}_${String(++serial).padStart(4, "0")}${crypto.randomUUID().slice(0, 6)}`;
  const view = (sub: Sub) => ({
    id: sub.id, object: "subscription", customer, status: sub.status, created: unix(sub.created), currency: "usd",
    items: { object: "list", data: [{ price: { id: PRICE[sub.plan] }, current_period_start: unix(sub.start), current_period_end: unix(sub.end) }] },
    metadata: { audience: "EMPLOYER", plan: sub.plan }, cancellation_details: { comment: sub.comment },
  });
  const event = (type: string, object: Row, at: number) => {
    events.push({ id: next("evt"), object: "event", type, created: unix(at), livemode: false, data: { object }, at });
  };
  const invoiceEvent = (invoice: Invoice, total: number, at: number) => event("invoice.paid", {
    id: invoice.id, object: "invoice", billing_reason: invoice.reason, status: "paid", currency: "usd", customer,
    amount_paid: Math.max(total, 0), total, hosted_invoice_url: "https://invoice.stripe.com/i/" + invoice.id,
    parent: { type: "subscription_details", subscription_details: { subscription: invoice.sub } },
    lines: { object: "list", data: [{ amount: total, period: { start: unix(invoice.start), end: unix(invoice.start + PERIOD) }, pricing: { price_details: { price: PRICE[invoice.plan] }, type: "price_details" } }] },
  }, at);
  const bill = (sub: Sub, reason: Invoice["reason"], paid: boolean, at: number): Invoice => {
    const invoice: Invoice = { id: next("in"), sub: sub.id, plan: sub.plan, start: sub.start, status: paid ? "paid" : "open", reason };
    invoices.set(invoice.id, invoice);
    if (paid) invoiceEvent(invoice, CENTS[sub.plan], at);
    return invoice;
  };
  const end = (sub: Sub, at: number) => {
    sub.status = "canceled";
    event("customer.subscription.deleted", view(sub), at);
  };

  const fetchImpl = (async (input, init) => {
    await sleep(latency());
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const one = /^\/v1\/subscriptions\/([^/]+)$/.exec(url.pathname)?.[1];
    const sub = one ? subs.get(decodeURIComponent(one)) : undefined;
    if (one && !sub) return json({ error: { code: "resource_missing" } }, 404);
    if (sub && method === "GET") return json(view(sub));
    if (sub && method === "DELETE") {
      if (sub.status === "canceled") return json({ error: { type: "invalid_request_error" } }, 400);
      const prorate = url.searchParams.get("prorate") === "true";
      sub.comment = url.searchParams.get("cancellation_details[comment]");
      if (prorate) {
        const paid = [...invoices.values()].some((inv) => inv.sub === sub.id && inv.start === sub.start && inv.status === "paid");
        const newerLive = Math.max(0, ...[...subs.values()].filter((other) => other.created > sub.created && other.status === "active").map((other) => CREDITS[other.plan]));
        refunds.push({ sub: sub.id, plan: sub.plan, start: sub.start, paid, newerLive });
      }
      end(sub, clock());
      return json(view(sub));
    }
    if (url.pathname === "/v1/subscriptions") return json({ object: "list", has_more: false, data: [...subs.values()].filter((s) => s.status !== "canceled").map(view) });
    if (url.pathname === "/v1/invoices" && method === "GET") {
      const of = url.searchParams.get("subscription");
      const status = url.searchParams.get("status");
      return json({ object: "list", has_more: false, data: [...invoices.values()].filter((inv) => inv.sub === of && (!status || inv.status === status)).map((inv) => ({ id: inv.id, object: "invoice", status: inv.status })) });
    }
    const voided = /^\/v1\/invoices\/([^/]+)\/void$/.exec(url.pathname)?.[1];
    if (voided && method === "POST") {
      const invoice = invoices.get(voided);
      if (!invoice || invoice.status !== "open") return json({ error: { type: "invalid_request_error" } }, 400);
      invoice.status = "void";
      return json({ id: invoice.id, object: "invoice", status: "void" });
    }
    if (url.pathname.startsWith("/v1/invoices/")) return json({ id: url.pathname.split("/").at(-1), object: "invoice", hosted_invoice_url: "https://invoice.stripe.com/i/x" });
    return json({ error: { code: "resource_missing" } }, 404);
  }) as typeof fetch;

  return {
    subs, invoices, refunds, events, fetchImpl,
    checkout(companyId: string, plan: Plan, at: number): Sub {
      const sub: Sub = { id: next("sub"), plan, status: "active", created: at, start: at, end: at + PERIOD, comment: null };
      subs.set(sub.id, sub);
      const invoice = bill(sub, "subscription_create", true, at);
      event("checkout.session.completed", {
        id: next("cs_test"), object: "checkout.session", mode: "subscription", status: "complete", payment_status: "paid",
        amount_total: CENTS[plan], currency: "usd", customer, subscription: sub.id, invoice: invoice.id, payment_intent: null,
        client_reference_id: companyId, metadata: { audience: "EMPLOYER", plan },
      }, at);
      event("customer.subscription.updated", view(sub), at);
      return sub;
    },
    renew(sub: Sub, paid: boolean, at: number) {
      sub.start = sub.end;
      sub.end += PERIOD;
      sub.status = paid ? "active" : "past_due";
      bill(sub, "subscription_cycle", paid, at);
      event("customer.subscription.updated", view(sub), at);
    },
    pay(invoice: Invoice, at: number) {
      invoice.status = "paid";
      invoiceEvent(invoice, CENTS[invoice.plan], at);
      const sub = subs.get(invoice.sub)!;
      if (sub.status === "past_due" && sub.start === invoice.start) {
        sub.status = "active";
        event("customer.subscription.updated", view(sub), at);
      }
    },
    end,
  };
}

type World = ReturnType<typeof stripeWorld>;

const signed = async (event: Row, at: number): Promise<Request> => {
  const { at: _, ...body } = event;
  const payload = JSON.stringify(body);
  const hex = await hmacSha256Hex("whsec_test", new TextEncoder().encode(`${unix(at)}.${payload}`));
  return new Request("https://core.example/api/v1/billing/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": `t=${unix(at)},v1=${hex}` },
    body: payload,
  });
};

// Every statement waits a random moment first, so two handlers interleave at statement granularity.
const jittered = (query: Query, jitter: () => number): Query => async (sql, params) => {
  await sleep(jitter());
  return query(sql, params);
};

const dbFor = (query: Query, who: { companyId: string | null }): Query => async (sql, params = []) => {
  if (sql.includes("rate_limits")) return { rows: [{ hits: 1 }], rowCount: 1 };
  if (sql.includes("idempotency_keys")) return sql.includes("INSERT") ? { rows: [{ id: "idem" }], rowCount: 1 } : { rows: [], rowCount: 0 };
  if (sql.includes("access_tokens")) {
    return { rows: [{
      id: crypto.randomUUID(), display_name: "이민아", locale: "ko", plan: "FREE", subscription_status: "NONE", stripe_customer_id: null,
      period_ends_at: null, created_at: new Date(START).toISOString(), token_expires_at: "2099-01-01T00:00:00Z",
      is_employer: true, company_id: who.companyId, company_role: "ADMIN",
    }], rowCount: 1 };
  }
  return query(sql, params);
};

type Run = { violations: string[]; stats: { actions: string[]; deliveries: number; retries: number } };

async function runSeed(seed: number): Promise<Run> {
  const script = mulberry(seed);
  const timing = mulberry(seed * 7919 + 13);
  const pick = <T,>(items: readonly T[]): T => items[Math.floor(script() * items.length)]!;
  const companyId = crypto.randomUUID();
  const customer = "cus_stress_" + seed + "_" + companyId.slice(0, 8);
  await pg!.query("INSERT INTO companies (id, name) VALUES ($1, 'push-be stress company')", [companyId]);
  let clock = START;
  const stripe: World = stripeWorld(customer, () => timing() * 12, () => clock);
  const query = jittered(pg!.query, () => timing() * 3);
  const transaction = pg!.transaction
    ? <T,>(work: (q: Query) => Promise<T>) => pg!.transaction!((q) => work(jittered(q, () => timing() * 3)))
    : undefined;
  const stats: Run["stats"] = { actions: [], deliveries: 0, retries: 0 };
  const violations: string[] = [];
  const inflight = new Set<Promise<void>>();
  let delivered = 0;

  let turn: Promise<unknown> = Promise.resolve();
  const serial = <T,>(work: () => Promise<T>): Promise<T> => {
    if (!process.env.BILLING_STRESS_SERIAL) return work();
    const mine = turn.then(work);
    turn = mine.catch(() => undefined);
    return mine;
  };
  const deliver = async (event: Row, at: number) => {
    await sleep(timing() * 25);
    // Stripe retries a failed delivery for days; a subscription event can come before its checkout made the customer known.
    for (let attempt = 0; attempt < 30; attempt++) {
      resetLimits();
      stats.deliveries++;
      const now = at + attempt * 60_000;
      const request = await signed(event, now);
      const res = await serial(() => handle(request, env, {
        query: dbFor(query, { companyId: null }), now: () => new Date(now), fetch: stripe.fetchImpl, ...(transaction ? { transaction } : {}),
      }));
      if (res.status === 200) return;
      if (process.env.BILLING_STRESS_VERBOSE && attempt === 29) violations.push(`${String(event.type)} ${JSON.stringify((event.data as Row).object).slice(0, 200)} -> ${res.status} ${await res.text()}`);
      stats.retries++;
      await sleep(5 + attempt * 5 + timing() * 20);
    }
    violations.push(`event ${String(event.type)} never accepted`);
  };
  const track = (work: Promise<void>) => {
    const done = work.catch((err: unknown) => { violations.push("harness: " + String(err)); }).finally(() => inflight.delete(done));
    inflight.add(done);
  };
  const flushEvents = () => {
    while (delivered < stripe.events.length) {
      const event = stripe.events[delivered++]!;
      track(deliver(event, Number(event.at)));
      if (timing() < 0.2) track(deliver(event, Number(event.at) + 1000));
    }
  };
  const settle = async () => {
    while (inflight.size > 0 || delivered < stripe.events.length) {
      flushEvents();
      await Promise.all([...inflight]);
    }
  };
  const reads = (at: number) => {
    track((async () => {
      resetLimits();
      const res = await handle(new Request("https://core.example/api/v1/billing", { headers: { authorization: "Bearer t" } }), env,
        { query: dbFor(query, { companyId }), now: () => new Date(at) });
      if (res.status !== 200) violations.push("billing read " + res.status);
    })());
    track((async () => {
      const row = (await pg!.query("SELECT plan FROM companies WHERE id = $1", [companyId])).rows[0];
      await ensureMonthlyGrant(query, { audience: "EMPLOYER", plan: row?.plan == null ? null : String(row.plan), ownerId: companyId, now: new Date(at) });
    })());
  };

  const live = () => [...stripe.subs.values()].filter((sub) => sub.status !== "canceled");
  const newest = () => live().sort((a, b) => b.created - a.created)[0];
  stats.actions.push("checkout");
  stripe.checkout(companyId, pick(["BASIC", "PRO", "ULTRA"] as const), clock);
  const steps = 3 + Math.floor(script() * 5);
  const soon = () => (1 + Math.floor(script() * 10)) * 60_000;
  for (let step = 0; step < steps; step++) {
    flushEvents();
    reads(clock);
    await sleep(timing() * 30);
    const sub = newest();
    const open = [...stripe.invoices.values()].filter((inv) => inv.status === "open");
    const choices = [
      ...(sub ? ["change", "change", "renew", "renew"] : ["change"]),
      ...(sub?.status === "active" ? ["renewFail", "cancel"] : []),
      ...(sub?.status === "past_due" ? ["dunningEnd"] : []),
      ...(open.length ? ["payOpen", "payOpen"] : []),
    ];
    const action = pick(choices);
    stats.actions.push(action);
    const at = action === "renew" || action === "renewFail" ? Math.max(sub!.end, clock + 60_000)
      : action === "cancel" || action === "dunningEnd" ? clock + HOUR + Math.floor(script() * 10 * DAY)
      : script() < 0.5 ? clock + soon()
      : action === "change" && sub ? Math.max(clock + HOUR, sub.start + Math.floor(script() * (sub.end - sub.start)))
      : clock + HOUR + Math.floor(script() * 5 * DAY);
    // Webhooks overlap the next Stripe change only when it comes within the hour; Stripe delivers within seconds.
    if (at - clock > HOUR) await settle();
    clock = at;
    if (action === "change") stripe.checkout(companyId, pick(["BASIC", "PRO", "ULTRA"] as const), at);
    else if (action === "renew" || action === "renewFail") stripe.renew(sub!, action === "renew", at);
    else if (action === "payOpen") stripe.pay(pick(open), at);
    else stripe.end(sub!, at);
  }
  await settle();
  reads(clock + DAY);
  await settle();
  return { violations: [...violations, ...await check(companyId, stripe)], stats };
}

async function check(companyId: string, stripe: World): Promise<string[]> {
  const out: string[] = [];
  const ledger = (await pg!.query(
    "SELECT reference_id, amount_micro_credits FROM billing_ledger WHERE company_id = $1 AND user_id IS NULL AND type = 'PURCHASE' AND (reference_id LIKE 'period:%' OR reference_id LIKE 'monthly:%')",
    [companyId])).rows.map((row) => ({ ref: String(row.reference_id), credits: Number(row.amount_micro_credits) / MICRO }));
  const alerted = new Set((await pg!.query("SELECT reference_id FROM billing_alerts WHERE company_id = $1 AND kind = 'NOT_GRANTED'", [companyId])).rows.map((row) => String(row.reference_id)));
  const company = (await pg!.query("SELECT plan, stripe_subscription_id FROM companies WHERE id = $1", [companyId])).rows[0]!;

  // Money: every paid invoice is worth its plan's credits, a prorated cancel takes back the refunded period's plan credits
  // (the successor carried them), and a payment the code could not credit must be on the operator's NOT_GRANTED list.
  let expected = 0;
  for (const invoice of stripe.invoices.values()) {
    if (invoice.status === "paid" && !alerted.has(invoice.id)) expected += CREDITS[invoice.plan];
  }
  for (const refund of stripe.refunds) {
    if (refund.paid) expected -= CREDITS[refund.plan];
    else out.push(`refund of the unpaid period ${refund.sub}@${refund.start}`);
    const level = Math.max(0, ...ledger.filter((row) => row.ref.startsWith(`period:${refund.sub}:${unix(refund.start)}:`)).map((row) => CREDITS[row.ref.split(":")[3] as Plan]));
    if (level > refund.newerLive) out.push(`refund of ${refund.sub}, whose period granted ${level}, for a lower plan (${refund.newerLive})`);
  }
  const granted = ledger.reduce((sum, row) => sum + row.credits, 0);
  if (granted !== expected) out.push(`granted ${granted} credits, paid for ${expected}`);
  if (out.length && process.env.BILLING_STRESS_VERBOSE) {
    out.push(JSON.stringify({ ledger, invoices: [...stripe.invoices.values()], refunds: stripe.refunds, alerted: [...alerted], subs: [...stripe.subs.values()] }));
  }

  // No grant without a paid period.
  for (const row of ledger) {
    if (row.credits <= 0) continue;
    const [kind, sub, start] = row.ref.split(":");
    const paid = kind === "period" && [...stripe.invoices.values()].some((inv) => inv.sub === sub && unix(inv.start) === Number(start) && inv.status === "paid");
    if (!paid) out.push(`grant ${row.ref} (${row.credits}) has no paid period`);
  }

  // Plan state follows the newest subscription Stripe still bills, and Stripe bills at most one.
  const billing = [...stripe.subs.values()].filter((sub) => sub.status !== "canceled");
  if (billing.length > 1) out.push(`${billing.length} subscriptions still billing`);
  const latest = billing.sort((a, b) => b.created - a.created || (a.id < b.id ? 1 : -1))[0];
  if (latest) {
    if (company.stripe_subscription_id !== latest.id || company.plan !== latest.plan) {
      out.push(`company on ${String(company.stripe_subscription_id)}/${String(company.plan)}, Stripe bills ${latest.id}/${latest.plan}`);
    }
  }
  else if (company.plan != null) out.push(`company keeps plan ${String(company.plan)} with no subscription billing`);
  return out;
}

test("billing stress: concurrent webhooks, retries, reads and enqueue keep the money invariants on every seed", { timeout: 600_000 }, async (t) => {
  if (!pg) return t.skip("set BILLING_PG_URL to a migrated Postgres");
  const failed: string[] = [];
  let deliveries = 0;
  let retries = 0;
  for (let seed = FIRST; seed < FIRST + SEEDS; seed++) {
    const run = await runSeed(seed);
    deliveries += run.stats.deliveries;
    retries += run.stats.retries;
    if (run.violations.length) {
      failed.push(seed + "");
      t.diagnostic(`seed ${seed} [${run.stats.actions.join(" ")}]: ${run.violations.join("; ")}`);
    }
  }
  t.diagnostic(`${SEEDS} seeds from ${FIRST}, ${deliveries} deliveries, ${retries} retried, ${pg.transaction ? "with" : "without"} transactions`);
  assert.deepEqual(failed, [], `seeds with violations: ${failed.join(",")}`);
});
