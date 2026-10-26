import assert from "node:assert/strict";
import { test } from "node:test";

import { hmacSha256Hex } from "../src/crypto.ts";
import { handle, type CoreEnv, type Deps } from "../src/handler.ts";
import { resetLimits } from "../src/ratelimit.ts";

const USER = "12345678-1234-5678-1234-567812345678";
const COMPANY = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const NOW = new Date("2026-10-21T00:00:00.000Z");
const MONTH = "monthly:2026-10";

type Call = { sql: string; params: unknown[] };
type LedgerRow = { reference: string; amount: number; userId: string | null; companyId: string | null };
type Err = { error: { code: string; message: string; details: { field?: string } | null } };

const empty = { rows: [] as Record<string, unknown>[], rowCount: 0 };

const envOf = (extra: Partial<CoreEnv> = {}): CoreEnv => ({
  APP_ENV: "production",
  STRIPE_SECRET_KEY: "sk_test",
  STRIPE_WEBHOOK_SECRET: "whsec_test",
  STRIPE_PRICE_PRO: "price_pro",
  STRIPE_PRICE_ULTRA: "price_ultra",
  STRIPE_PRICE_EMPLOYER_BASIC: "price_employer_basic",
  STRIPE_PRICE_EMPLOYER_PRO: "price_employer_pro",
  STRIPE_PRICE_EMPLOYER_ULTRA: "price_employer_ultra",
  STRIPE_PRICE_TOPUP: "price_topup",
  IAP_PRODUCT_PRO: "ios.pro",
  IAP_PRODUCT_ULTRA: "ios.ultra",
  IAP_PRODUCT_TOPUP: "ios.topup",
  ...extra,
});

const tokenRow = (employer: boolean, role: string | null, plan = "FREE", subscription = "NONE") => ({
  id: USER,
  display_name: "Ada",
  locale: "ko",
  plan,
  subscription_status: subscription,
  stripe_customer_id: null,
  period_ends_at: null,
  created_at: NOW.toISOString(),
  token_expires_at: "2099-01-01T00:00:00Z",
  is_employer: employer,
  company_id: role ? COMPANY : null,
  company_role: role,
});

const authed = (
  seen: Call[],
  employer: boolean,
  role: string | null,
  extra: Deps["query"],
  plan = "FREE",
  subscription = "NONE",
): Deps["query"] => async (sql, params = []) => {
  seen.push({ sql, params });
  if (sql.includes("rate_limits")) return { rows: [{ hits: 1 }], rowCount: 1 };
  if (sql.includes("access_tokens")) return { rows: [tokenRow(employer, role, plan, subscription)], rowCount: 1 };
  if (sql.includes("idempotency_keys") && sql.includes("INSERT")) return { rows: [{ id: "idem-1" }], rowCount: 1 };
  if (sql.includes("idempotency_keys")) return empty;
  return extra(sql, params);
};

const duplicate = (): Error => {
  const err = new Error("duplicate key value violates unique constraint");
  (err as unknown as { code: string }).code = "23505";
  return err;
};

const takeLedger = (ledger: LedgerRow[]) => (sql: string, params: unknown[]) => {
  if (!sql.includes("INSERT INTO billing_ledger")) return null;
  const reference = params.find((item) => typeof item === "string" && (item.startsWith("monthly:") || item.startsWith("tx-") || item.startsWith("top-") || item.startsWith("cs_"))) as string | undefined;
  const amount = params.find((item) => typeof item === "number") as number | undefined;
  const userId = params.includes(USER) ? USER : null;
  const companyId = params.includes(COMPANY) ? COMPANY : null;
  if (reference && ledger.some((row) => row.reference === reference)) {
    if (!sql.includes("ON CONFLICT")) throw duplicate();
    return { rows: [] as Record<string, unknown>[], rowCount: 0 };
  }
  ledger.push({ reference: reference ?? "", amount: amount ?? 0, userId, companyId });
  return { rows: [{ id: "ledger-" + ledger.length }], rowCount: 1 };
};

const oneOwner = (row: LedgerRow): boolean => Number(row.userId != null) + Number(row.companyId != null) === 1;

const post = (path: string, body: unknown, key: string): Request => new Request("https://core.example" + path, {
  method: "POST",
  headers: {
    authorization: "Bearer secret-token",
    "content-type": "application/json",
    "idempotency-key": key,
  },
  body: JSON.stringify(body),
});

const get = (path: string): Request => new Request("https://core.example" + path, {
  headers: { authorization: "Bearer secret-token" },
});

const codeOf = async (res: Response): Promise<Err["error"]> => (await res.json() as Err).error;

const stripeFetch = (calls: { url: string; body: string }[]): typeof fetch => (async (input, init) => {
  calls.push({ url: String(input), body: init?.body == null ? "" : String(init.body) });
  return new Response(JSON.stringify({ url: "https://pay.example/basic", expires_at: 1761000000 }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}) as typeof fetch;

const signedStripe = async (payload: string): Promise<Request> => {
  const stamp = Math.floor(NOW.getTime() / 1000);
  const bytes = new TextEncoder().encode(payload);
  const prefix = new TextEncoder().encode(`${stamp}.`);
  const signed = new Uint8Array(prefix.length + bytes.length);
  signed.set(prefix);
  signed.set(bytes, prefix.length);
  const hex = await hmacSha256Hex("whsec_test", signed);
  return new Request("https://core.example/api/v1/billing/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": `t=${stamp},v1=${hex}` },
    body: payload,
  });
};

test("employer admin checkout uses the employer price and audience", async () => {
  resetLimits();
  const seen: Call[] = [];
  const calls: { url: string; body: string }[] = [];
  const query = authed(seen, true, "ADMIN", async (sql) => {
    if (sql.includes("FROM companies")) return { rows: [{ stripe_customer_id: "cus_co", plan: "BASIC" }], rowCount: 1 };
    return empty;
  });
  const res = await handle(
    post("/api/v1/billing/checkout", { planId: "BASIC" }, "11111111-1111-4111-8111-111111111111"),
    envOf(),
    { query, now: () => NOW, fetch: stripeFetch(calls) },
  );
  assert.equal(res.status, 200);
  assert.equal((await res.json() as { data: { url: string } }).data.url, "https://pay.example/basic");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "https://api.stripe.com/v1/checkout/sessions");
  const form = new URLSearchParams(calls[0]?.body);
  assert.equal(form.get("mode"), "subscription");
  assert.equal(form.get("line_items[0][price]"), "price_employer_basic");
  assert.equal(form.get("metadata[audience]"), "EMPLOYER");
  assert.equal(form.get("metadata[plan]"), "BASIC");
  assert.equal(form.get("client_reference_id"), COMPANY);
  assert.equal(form.get("customer"), "cus_co");
  assert.equal(seen.some((call) => call.sql.includes("access_tokens") && call.sql.includes("billing_ledger")), false);
});

test("employer member checkout is forbidden", async () => {
  resetLimits();
  const calls: { url: string; body: string }[] = [];
  const seen: Call[] = [];
  const query = authed(seen, true, "MEMBER", async () => empty);
  const res = await handle(
    post("/api/v1/billing/checkout", { planId: "PRO" }, "22222222-2222-4222-8222-222222222222"),
    envOf(),
    { query, now: () => NOW, fetch: stripeFetch(calls) },
  );
  assert.equal(res.status, 403);
  assert.equal((await codeOf(res)).code, "FORBIDDEN");
  assert.equal(calls.length, 0);
});

test("personal checkout of BASIC is a validation error", async () => {
  resetLimits();
  const calls: { url: string; body: string }[] = [];
  const seen: Call[] = [];
  const query = authed(seen, false, null, async () => empty);
  const res = await handle(
    post("/api/v1/billing/checkout", { planId: "BASIC" }, "33333333-3333-4333-8333-333333333333"),
    envOf(),
    { query, now: () => NOW, fetch: stripeFetch(calls) },
  );
  assert.equal(res.status, 400);
  const err = await codeOf(res);
  assert.equal(err.code, "VALIDATION_ERROR");
  assert.equal(err.details?.field, "planId");
  assert.equal(calls.length, 0);
});

test("iap verify while stripe is active returns 409", async () => {
  resetLimits();
  const seen: Call[] = [];
  let verified = 0;
  const query = authed(seen, false, null, async () => empty, "PRO", "ACTIVE");
  const res = await handle(
    post("/api/v1/billing/iap/verify", { platform: "APP_STORE", productId: "ios.pro", signedTransaction: "jws" }, "44444444-4444-4444-8444-444444444444"),
    envOf(),
    {
      query,
      now: () => NOW,
      stores: {
        verifyApple: async () => {
          verified += 1;
          return { productId: "ios.pro", originalTransactionId: "tx-pro", expiresAt: null, consumable: false };
        },
        verifyGoogle: async () => { throw new Error("google"); },
        decodeAppleNotification: async () => { throw new Error("apple"); },
        decodeGoogleNotification: async () => { throw new Error("google"); },
      },
    },
  );
  assert.equal(res.status, 409);
  assert.equal((await codeOf(res)).code, "ALREADY_SUBSCRIBED");
  assert.equal(verified, 0);
  assert.equal(seen.some((call) => call.sql.includes("INSERT INTO billing_ledger")), false);
  assert.equal(seen.some((call) => call.sql.includes("UPDATE users")), false);
});

test("iap top-up is allowed during an active stripe subscription and does not double insert", async () => {
  resetLimits();
  const seen: Call[] = [];
  const ledger: LedgerRow[] = [];
  const capture = takeLedger(ledger);
  const query = authed(seen, false, null, async (sql, params = []) => {
    const taken = capture(sql, params);
    if (taken) return taken;
    if (sql.includes("INSERT INTO iap_subscriptions")) return { rows: [{ user_id: USER }], rowCount: 1 };
    return empty;
  }, "PRO", "ACTIVE");
  const stores: NonNullable<Deps["stores"]> = {
    verifyApple: async (signed) => {
      assert.equal(signed, "jws-top");
      return { productId: "ios.topup", originalTransactionId: "top-1", expiresAt: null, consumable: true };
    },
    verifyGoogle: async () => { throw new Error("google"); },
    decodeAppleNotification: async () => { throw new Error("apple"); },
    decodeGoogleNotification: async () => { throw new Error("google"); },
  };
  const body = { platform: "APP_STORE", productId: "ios.topup", signedTransaction: "jws-top" };
  const first = await handle(post("/api/v1/billing/iap/verify", body, "55555555-5555-4555-8555-555555555555"), envOf(), { query, now: () => NOW, stores });
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { data: { plan: "PRO", periodEndsAt: null } });
  const second = await handle(post("/api/v1/billing/iap/verify", body, "55555555-5555-4555-8555-555555555556"), envOf(), { query, now: () => NOW, stores });
  assert.equal(second.status, 200);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0]?.amount, 1_800_000);
  assert.equal(ledger[0]?.reference, "top-1");
  assert.equal(oneOwner(ledger[0] as LedgerRow), true);
  assert.equal(ledger[0]?.userId, USER);
  assert.equal(seen.some((call) => call.sql.includes("UPDATE users")), false);
});

test("apple webhook inserts one ledger row and ignores the same transaction id", async () => {
  resetLimits();
  const ledger: LedgerRow[] = [];
  const capture = takeLedger(ledger);
  let decoded = 0;
  const query: Deps["query"] = async (sql, params = []) => {
    if (sql.includes("access_tokens")) return empty;
    if (sql.includes("rate_limits")) return { rows: [{ hits: 1 }], rowCount: 1 };
    const taken = capture(sql, params);
    if (taken) return taken;
    if (sql.includes("iap_subscriptions") && sql.toLowerCase().includes("select")) {
      return { rows: [{ user_id: USER }], rowCount: 1 };
    }
    if (sql.includes("UPDATE")) return { rows: [{ id: USER }], rowCount: 1 };
    return empty;
  };
  const stores: NonNullable<Deps["stores"]> = {
    verifyApple: async () => { throw new Error("verify"); },
    verifyGoogle: async () => { throw new Error("verify"); },
    decodeAppleNotification: async (body) => {
      decoded += 1;
      assert.equal(body, "signed-payload");
      return { notificationType: "PURCHASE", originalTransactionId: "tx-1", productId: "ios.pro", expiresAt: "2026-11-21T00:00:00.000Z" };
    },
    decodeGoogleNotification: async () => { throw new Error("google"); },
  };
  const req = (): Request => new Request("https://core.example/api/v1/billing/webhook/app-store", {
    method: "POST",
    body: "signed-payload",
  });
  const first = await handle(req(), envOf(), { query, now: () => NOW, stores });
  assert.equal(first.status, 200);
  const second = await handle(req(), envOf(), { query, now: () => NOW, stores });
  assert.equal(second.status, 200);
  assert.equal(decoded, 2);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0]?.amount, 30_000_000);
  assert.equal(ledger[0]?.reference, "tx-1");
  assert.equal(ledger[0]?.userId, USER);
  assert.equal(ledger[0]?.companyId, null);
  assert.equal(oneOwner(ledger[0] as LedgerRow), true);
});

test("employer checkout completion grants the company and does not change the user plan", async () => {
  resetLimits();
  const ledger: LedgerRow[] = [];
  const capture = takeLedger(ledger);
  const updates: string[] = [];
  let events = 0;
  const query: Deps["query"] = async (sql, params = []) => {
    if (sql.includes("rate_limits")) return { rows: [{ hits: 1 }], rowCount: 1 };
    if (sql.includes("INSERT INTO stripe_events")) {
      events += 1;
      if (events > 1) return empty;
      return { rows: [{ event_id: "evt_emp" }], rowCount: 1 };
    }
    const taken = capture(sql, params);
    if (taken) return taken;
    if (sql.includes("UPDATE companies")) {
      updates.push(sql + " " + JSON.stringify(params));
      return { rows: [{ id: COMPANY }], rowCount: 1 };
    }
    if (sql.includes("UPDATE users")) {
      updates.push("user");
      return { rows: [{ id: USER }], rowCount: 1 };
    }
    return empty;
  };
  const payload = JSON.stringify({
    id: "evt_emp",
    type: "checkout.session.completed",
    data: { object: {
      id: "cs_emp",
      customer: "cus_co",
      client_reference_id: COMPANY,
      metadata: { audience: "EMPLOYER", plan: "BASIC" },
    } },
  });
  const first = await handle(await signedStripe(payload), envOf(), { query, now: () => NOW });
  assert.equal(first.status, 200);
  const second = await handle(await signedStripe(payload), envOf(), { query, now: () => NOW });
  assert.equal(second.status, 200);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0]?.amount, 18_000_000);
  assert.equal(ledger[0]?.reference, "cs_emp");
  assert.equal(ledger[0]?.companyId, COMPANY);
  assert.equal(ledger[0]?.userId, null);
  assert.equal(updates.some((item) => item.includes("BASIC")), true);
  assert.equal(updates.includes("user"), false);
});

test("top-up completion inserts micro credits and does not change the plan", async () => {
  resetLimits();
  const ledger: LedgerRow[] = [];
  const capture = takeLedger(ledger);
  const seen: string[] = [];
  const query: Deps["query"] = async (sql, params = []) => {
    if (sql.includes("rate_limits")) return { rows: [{ hits: 1 }], rowCount: 1 };
    if (sql.includes("INSERT INTO stripe_events")) return { rows: [{ event_id: "evt_top" }], rowCount: 1 };
    const taken = capture(sql, params);
    if (taken) return taken;
    if (sql.includes("UPDATE users") || sql.includes("UPDATE companies")) {
      seen.push(sql);
      return { rows: [{ id: USER }], rowCount: 1 };
    }
    return empty;
  };
  const payload = JSON.stringify({
    id: "evt_top",
    type: "checkout.session.completed",
    data: { object: {
      id: "cs_top",
      client_reference_id: USER,
      metadata: { amountMicroCredits: "18000", audience: "PERSONAL", ownerId: USER },
    } },
  });
  const res = await handle(await signedStripe(payload), envOf(), { query, now: () => NOW });
  assert.equal(res.status, 200);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0]?.amount, 18000);
  assert.equal(ledger[0]?.reference, "cs_top");
  assert.equal(ledger[0]?.userId, USER);
  assert.equal(ledger[0]?.companyId, null);
  assert.equal(seen.length, 0);
});

test("a company stripe customer cancel does not 500 when no user matches", async () => {
  resetLimits();
  let companySql = "";
  const query: Deps["query"] = async (sql) => {
    if (sql.includes("rate_limits")) return { rows: [{ hits: 1 }], rowCount: 1 };
    if (sql.includes("INSERT INTO stripe_events")) return { rows: [{ event_id: "evt_del" }], rowCount: 1 };
    if (sql.includes("UPDATE companies")) {
      companySql = sql;
      return { rows: [{ id: COMPANY }], rowCount: 1 };
    }
    if (sql.includes("UPDATE users")) return empty;
    return empty;
  };
  const payload = JSON.stringify({
    id: "evt_del",
    type: "customer.subscription.deleted",
    data: { object: { id: "sub_1", customer: "cus_co", status: "canceled" } },
  });
  const res = await handle(await signedStripe(payload), envOf(), { query, now: () => NOW });
  assert.equal(res.status, 200);
  assert.match(companySql, /UPDATE companies SET plan = NULL/);
});

test("employer status grants this month once and leaves periodEndsAt null", async () => {
  resetLimits();
  const seen: Call[] = [];
  const ledger: LedgerRow[] = [];
  const capture = takeLedger(ledger);
  const query = authed(seen, true, "ADMIN", async (sql, params = []) => {
    const taken = capture(sql, params);
    if (taken) return taken;
    if (sql.includes("FROM companies")) return { rows: [{ plan: "BASIC" }], rowCount: 1 };
    if (sql.includes("balance_after")) return { rows: [{ balance_after: 18_000_000 }], rowCount: 1 };
    return empty;
  });
  const deps = { query, now: () => NOW };
  const first = await handle(get("/api/v1/billing"), envOf(), deps);
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), {
    data: {
      subscriptionStatus: "ACTIVE",
      plan: "BASIC",
      periodEndsAt: null,
      balanceMicroCredits: 18_000_000,
      reservedMicroCredits: 0,
      monthlyMicroCredits: 18_000_000,
      spentMicroCredits: 0,
      audience: "EMPLOYER",
      source: "STRIPE",
    },
  });
  const second = await handle(get("/api/v1/billing"), envOf(), deps);
  assert.equal(second.status, 200);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0]?.reference, MONTH);
  assert.equal(ledger[0]?.amount, 18_000_000);
  assert.equal(ledger[0]?.companyId, COMPANY);
  assert.equal(ledger[0]?.userId, null);
});

test("a null employer plan grants nothing and has no source", async () => {
  resetLimits();
  const seen: Call[] = [];
  const query = authed(seen, true, "MEMBER", async (sql) => {
    if (sql.includes("FROM companies")) return { rows: [{ plan: null }], rowCount: 1 };
    if (sql.includes("balance_after")) return { rows: [{ balance_after: 0 }], rowCount: 1 };
    return empty;
  });
  const res = await handle(get("/api/v1/billing"), envOf(), { query, now: () => NOW });
  assert.equal(res.status, 200);
  const body = await res.json() as { data: { plan: null; source: null; periodEndsAt: null; subscriptionStatus: string; audience: string } };
  assert.equal(body.data.audience, "EMPLOYER");
  assert.equal(body.data.plan, null);
  assert.equal(body.data.source, null);
  assert.equal(body.data.periodEndsAt, null);
  assert.equal(body.data.subscriptionStatus, "NONE");
  assert.equal(seen.some((call) => call.sql.includes("INSERT INTO billing_ledger")), false);
});

test("personal status keeps the pro monthly amount and prefers an active store", async () => {
  resetLimits();
  const seen: Call[] = [];
  const ledger: LedgerRow[] = [];
  const capture = takeLedger(ledger);
  const query = authed(seen, false, null, async (sql, params = []) => {
    const taken = capture(sql, params);
    if (taken) return taken;
    if (sql.includes("iap_subscriptions")) return { rows: [{ platform: "APP_STORE" }], rowCount: 1 };
    if (sql.includes("balance_after")) return { rows: [{ balance_after: 30_000_000 }], rowCount: 1 };
    return empty;
  }, "PRO", "ACTIVE");
  const res = await handle(get("/api/v1/billing"), envOf(), { query, now: () => NOW });
  assert.equal(res.status, 200);
  const body = await res.json() as { data: { audience: string; source: string; plan: string; balanceMicroCredits: number } };
  assert.equal(body.data.audience, "PERSONAL");
  assert.equal(body.data.source, "APP_STORE");
  assert.equal(body.data.plan, "PRO");
  assert.equal(body.data.balanceMicroCredits, 30_000_000);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0]?.amount, 30_000_000);
  assert.equal(ledger[0]?.reference, MONTH);
  assert.equal(ledger[0]?.userId, USER);
  assert.equal(ledger[0]?.companyId, null);
});

test("employer pro status reports the allowance and settled member spend", async () => {
  resetLimits();
  const seen: Call[] = [];
  const query = authed(seen, true, "ADMIN", async (sql) => {
    if (sql.includes("FROM companies")) return { rows: [{ plan: "PRO" }], rowCount: 1 };
    if (sql.includes("balance_after")) return { rows: [{ balance_after: 90_000_000 }], rowCount: 1 };
    if (sql.includes("ai_usage")) return { rows: [{ spent: 4_200 }], rowCount: 1 };
    return empty;
  });
  const res = await handle(get("/api/v1/billing"), envOf(), { query, now: () => NOW });
  assert.equal(res.status, 200);
  const body = await res.json() as { data: { monthlyMicroCredits: number; spentMicroCredits: number } };
  assert.equal(body.data.monthlyMicroCredits, 90_000_000);
  assert.equal(body.data.spentMicroCredits, 4_200);
  const spend = seen.find((call) => call.sql.includes("ai_usage"));
  assert.ok(spend);
  assert.equal(spend.sql.includes("SETTLED"), true);
  assert.equal(spend.sql.includes("company_members"), true);
  assert.equal(spend.sql.includes("FROM companies"), false);
  assert.equal(spend.sql.includes("balance_after"), false);
  assert.equal(spend.params.includes(COMPANY), true);
  assert.equal(spend.params.includes("2026-10-01T00:00:00.000Z"), true);
  assert.equal(spend.params.includes("2026-11-01T00:00:00.000Z"), true);
});

test("a null employer plan reports zero monthly credits", async () => {
  resetLimits();
  const seen: Call[] = [];
  const query = authed(seen, true, "MEMBER", async (sql) => {
    if (sql.includes("FROM companies")) return { rows: [{ plan: null }], rowCount: 1 };
    if (sql.includes("balance_after")) return { rows: [{ balance_after: 0 }], rowCount: 1 };
    return empty;
  });
  const res = await handle(get("/api/v1/billing"), envOf(), { query, now: () => NOW });
  assert.equal(res.status, 200);
  const body = await res.json() as { data: { monthlyMicroCredits: number; plan: null } };
  assert.equal(body.data.plan, null);
  assert.equal(body.data.monthlyMicroCredits, 0);
});

test("personal pro status reports the allowance and that user's settled spend", async () => {
  resetLimits();
  const seen: Call[] = [];
  const query = authed(seen, false, null, async (sql) => {
    if (sql.includes("iap_subscriptions")) return empty;
    if (sql.includes("balance_after")) return { rows: [{ balance_after: 30_000_000 }], rowCount: 1 };
    if (sql.includes("ai_usage")) return { rows: [{ spent: 9_000 }], rowCount: 1 };
    return empty;
  }, "PRO", "ACTIVE");
  const res = await handle(get("/api/v1/billing"), envOf(), { query, now: () => NOW });
  assert.equal(res.status, 200);
  const body = await res.json() as { data: { monthlyMicroCredits: number; spentMicroCredits: number } };
  assert.equal(body.data.monthlyMicroCredits, 30_000_000);
  assert.equal(body.data.spentMicroCredits, 9_000);
  const spend = seen.find((call) => call.sql.includes("ai_usage"));
  assert.ok(spend);
  assert.equal(spend.sql.includes("company_members"), false);
  assert.equal(spend.sql.includes("user_id"), true);
  assert.equal(spend.params.includes(USER), true);
});

test("a blank personal plan uses the free monthly allowance", async () => {
  resetLimits();
  const seen: Call[] = [];
  const query = authed(seen, false, null, async (sql) => {
    if (sql.includes("balance_after")) return { rows: [{ balance_after: 0 }], rowCount: 1 };
    return empty;
  }, "");
  const res = await handle(get("/api/v1/billing"), envOf(), { query, now: () => NOW });
  assert.equal(res.status, 200);
  const body = await res.json() as { data: { plan: string | null; monthlyMicroCredits: number; spentMicroCredits: number } };
  assert.equal(body.data.plan, null);
  assert.equal(body.data.monthlyMicroCredits, 1_800_000);
  assert.equal(body.data.spentMicroCredits, 0);
});

test("a missing ai_usage relation reports zero spend", async () => {
  resetLimits();
  const seen: Call[] = [];
  const missing = new Error('relation "ai_usage" does not exist');
  (missing as unknown as { code: string }).code = "42P01";
  const query = authed(seen, true, "ADMIN", async (sql) => {
    if (sql.includes("FROM companies")) return { rows: [{ plan: "BASIC" }], rowCount: 1 };
    if (sql.includes("balance_after")) return { rows: [{ balance_after: 18_000_000 }], rowCount: 1 };
    if (sql.includes("ai_usage")) throw missing;
    return empty;
  });
  const res = await handle(get("/api/v1/billing"), envOf(), { query, now: () => NOW });
  assert.equal(res.status, 200);
  const body = await res.json() as { data: { spentMicroCredits: number; monthlyMicroCredits: number } };
  assert.equal(body.data.monthlyMicroCredits, 18_000_000);
  assert.equal(body.data.spentMicroCredits, 0);
});

test("iap verify without a store port or key is not configured and does not fetch", async () => {
  resetLimits();
  let fetched = 0;
  const seen: Call[] = [];
  const query = authed(seen, false, null, async () => empty, "FREE", "NONE");
  const fetchImpl = (async () => {
    fetched += 1;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const res = await handle(
    post("/api/v1/billing/iap/verify", { platform: "APP_STORE", productId: "ios.pro", signedTransaction: "jws" }, "66666666-6666-4666-8666-666666666666"),
    envOf(),
    { query, now: () => NOW, fetch: fetchImpl },
  );
  assert.equal(res.status, 503);
  assert.equal((await codeOf(res)).code, "NOT_CONFIGURED");
  assert.equal(fetched, 0);
});

const bytesText = (bytes: Uint8Array): string => {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return bin;
};

const b64url = (bytes: Uint8Array): string => btoa(bytesText(bytes))
  .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

const b64std = (bytes: Uint8Array): string => btoa(bytesText(bytes));

const text64 = (value: string): string => b64url(new TextEncoder().encode(value));

const jws = async (payload: unknown, privateKey: CryptoKey, header: Record<string, unknown> = {}): Promise<string> => {
  const head = text64(JSON.stringify({ alg: "ES256", ...header }));
  const body = text64(JSON.stringify(payload));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, new TextEncoder().encode(`${head}.${body}`)));
  return `${head}.${body}.${b64url(sig)}`;
};

const flipSig = (token: string): string => {
  const parts = token.split(".");
  const packed = parts[2]!.replaceAll("-", "+").replaceAll("_", "/");
  const sig = Uint8Array.from(atob(packed + "=".repeat((4 - (packed.length % 4)) % 4)), (char) => char.charCodeAt(0));
  sig[0] ^= 255;
  return `${parts[0]}.${parts[1]}.${b64url(sig)}`;
};

const p256 = async () => {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
  const pem = `-----BEGIN PUBLIC KEY-----\n${b64std(spki)}\n-----END PUBLIC KEY-----`;
  const token = await jws({ notificationType: "DID_RENEW", originalTransactionId: "tx-1", productId: "ios.pro" }, pair.privateKey);
  return { pem, token, bad: flipSig(token), privateKey: pair.privateKey };
};

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

const derLen = (length: number): Uint8Array => {
  if (length < 128) return Uint8Array.from([length]);
  if (length < 256) return Uint8Array.from([0x81, length]);
  return Uint8Array.from([0x82, length >> 8, length & 0xff]);
};

const tag = (id: number, body: Uint8Array): Uint8Array => concat(Uint8Array.from([id]), derLen(body.length), body);

const encodeOid = (value: string): Uint8Array => {
  const parts = value.split(".").map(Number);
  const bytes = [parts[0]! * 40 + parts[1]!];
  for (const part of parts.slice(2)) {
    const stack = [part & 0x7f];
    let n = part >> 7;
    while (n > 0) {
      stack.unshift((n & 0x7f) | 0x80);
      n >>= 7;
    }
    bytes.push(...stack);
  }
  return Uint8Array.from(bytes);
};

const oid = (value: string): Uint8Array => tag(0x06, encodeOid(value));
const derInt = (bytes: Uint8Array): Uint8Array => {
  let i = 0;
  while (i < bytes.length - 1 && bytes[i] === 0 && (bytes[i + 1]! & 0x80) === 0) i += 1;
  const trimmed = bytes.subarray(i);
  const body = trimmed[0]! & 0x80 ? concat(Uint8Array.from([0x00]), trimmed) : trimmed;
  return tag(0x02, body);
};

const certDer = async (
  subjectKey: CryptoKey,
  issuerKey: CryptoKey,
  subject: string,
  issuer: string,
  serial: number,
): Promise<Uint8Array> => {
  const alg = tag(0x30, oid("1.2.840.10045.4.3.2"));
  const dn = (cn: string): Uint8Array => tag(0x30, tag(0x31, tag(0x30, concat(oid("2.5.4.3"), tag(0x0c, new TextEncoder().encode(cn))))));
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", subjectKey));
  const tbs = tag(0x30, concat(
    tag(0xa0, tag(0x02, Uint8Array.from([2]))),
    derInt(Uint8Array.from([serial])),
    alg,
    dn(issuer),
    tag(0x30, concat(tag(0x17, new TextEncoder().encode("260101000000Z")), tag(0x17, new TextEncoder().encode("361231235959Z")))),
    dn(subject),
    spki,
  ));
  const signed = new ArrayBuffer(tbs.byteLength);
  new Uint8Array(signed).set(tbs);
  const raw = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, issuerKey, signed));
  const signature = tag(0x30, concat(derInt(raw.subarray(0, 32)), derInt(raw.subarray(32))));
  return tag(0x30, concat(tbs, alg, tag(0x03, concat(Uint8Array.from([0x00]), signature))));
};

const appleChain = async () => {
  const root = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const mid = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const leaf = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const rootDer = await certDer(root.publicKey, root.privateKey, "root", "root", 1);
  const midDer = await certDer(mid.publicKey, root.privateKey, "mid", "root", 2);
  const leafDer = await certDer(leaf.publicKey, mid.privateKey, "leaf", "mid", 3);
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", leaf.publicKey));
  return {
    rootPem: `-----BEGIN CERTIFICATE-----\n${b64std(rootDer)}\n-----END CERTIFICATE-----`,
    leafPem: `-----BEGIN PUBLIC KEY-----\n${b64std(spki)}\n-----END PUBLIC KEY-----`,
    x5c: [b64std(leafDer), b64std(midDer)],
    privateKey: leaf.privateKey,
  };
};

test("a top-up charges one price unit per displayed credit", async () => {
  resetLimits();
  const calls: { url: string; body: string }[] = [];
  const seen: Call[] = [];
  const query = authed(seen, false, null, async () => empty);
  const res = await handle(
    post("/api/v1/billing/topup", { amount: 3 }, "77777777-7777-4777-8777-777777777777"),
    envOf(),
    { query, now: () => NOW, fetch: stripeFetch(calls) },
  );
  assert.equal(res.status, 200);
  const form = new URLSearchParams(calls[0]?.body);
  assert.equal(form.get("line_items[0][quantity]"), "3");
  assert.equal(form.get("metadata[amountMicroCredits]"), "18000");
});

const storeHook = (path: string, body: string, authorization?: string): Request => new Request("https://core.example" + path, {
  method: "POST",
  headers: authorization ? { authorization } : {},
  body,
});

const rejectQuery = (): Deps["query"] => async (sql) => {
  if (sql.includes("rate_limits")) return { rows: [{ hits: 1 }], rowCount: 1 };
  if (sql.includes("INSERT INTO billing_ledger")) throw new Error("ledger");
  return empty;
};

test("an unverified store webhook is rejected", async () => {
  resetLimits();
  const key = await p256();
  const chain = await appleChain();
  const other = await appleChain();
  const play = await p256();
  const oidc = await p256();
  const query = rejectQuery();
  const audience = "push-google-webhook";
  const inner = await jws({ originalTransactionId: "tx-1", productId: "ios.pro", expiresDate: 1792886400000 }, chain.privateKey);
  const appleBody = await jws({ notificationType: "DID_RENEW", data: { signedTransactionInfo: inner } }, chain.privateKey, { x5c: chain.x5c });
  const playNote = await jws({
    subscriptionNotification: { notificationType: 4, purchaseToken: "tok-1", subscriptionId: "ios.pro" },
  }, play.privateKey);
  const playBody = JSON.stringify({ signedPayload: playNote });
  const oidcJwt = await jws({ iss: "https://accounts.google.com", aud: audience, exp: NOW.getTime() / 1000 + 600 }, oidc.privateKey);
  const googleEnv = { GOOGLE_PLAY_KEY: play.pem, GOOGLE_OIDC_KEY: oidc.pem, GOOGLE_OIDC_AUDIENCE: audience };
  const forged = await handle(
    storeHook("/api/v1/billing/webhook/app-store", key.bad),
    envOf(),
    { query, now: () => NOW },
  );
  assert.equal(forged.status, 400);
  assert.equal((await codeOf(forged)).message, "invalid webhook signature");
  const unsigned = await handle(
    storeHook("/api/v1/billing/webhook/google-play", JSON.stringify({ message: { data: btoa(JSON.stringify({ subscriptionNotification: { notificationType: 2 } })) } })),
    envOf({ GOOGLE_PLAY_KEY: key.pem }),
    { query, now: () => NOW },
  );
  assert.equal(unsigned.status, 400);
  assert.equal((await codeOf(unsigned)).message, "invalid webhook signature");
  const nested = await handle(
    storeHook("/api/v1/billing/webhook/app-store", await jws({ notificationType: "DID_RENEW", data: { signedTransactionInfo: flipSig(inner) } }, chain.privateKey, { x5c: chain.x5c })),
    envOf({ APPLE_ROOT_PEM: chain.rootPem }),
    { query, now: () => NOW },
  );
  assert.equal(nested.status, 400);
  assert.equal((await codeOf(nested)).message, "invalid webhook signature");
  const bare = await handle(
    storeHook("/api/v1/billing/webhook/app-store", key.token),
    envOf({ APPLE_ROOT_PEM: chain.rootPem }),
    { query, now: () => NOW },
  );
  assert.equal(bare.status, 400);
  assert.equal((await codeOf(bare)).message, "invalid webhook signature");
  const rooted = await handle(
    storeHook("/api/v1/billing/webhook/app-store", appleBody),
    envOf({ APPLE_ROOT_PEM: chain.rootPem }),
    { query, now: () => NOW },
  );
  assert.equal(rooted.status, 200);
  const wrongRoot = await handle(
    storeHook("/api/v1/billing/webhook/app-store", appleBody),
    envOf({ APPLE_ROOT_PEM: other.rootPem }),
    { query, now: () => NOW },
  );
  assert.equal(wrongRoot.status, 400);
  assert.equal((await codeOf(wrongRoot)).message, "invalid webhook signature");
  const rawRoot = await handle(
    storeHook("/api/v1/billing/webhook/app-store", appleBody),
    envOf({ APPLE_ROOT_PEM: "not-a-cert" }),
    { query, now: () => NOW },
  );
  assert.equal(rawRoot.status, 503);
  assert.equal((await codeOf(rawRoot)).code, "NOT_CONFIGURED");
  const missingRoot = await handle(
    storeHook("/api/v1/billing/webhook/app-store", appleBody),
    envOf(),
    { query, now: () => NOW },
  );
  assert.equal(missingRoot.status, 503);
  assert.equal((await codeOf(missingRoot)).code, "NOT_CONFIGURED");
  const googleOk = await handle(
    storeHook("/api/v1/billing/webhook/google-play", playBody, "Bearer " + oidcJwt),
    envOf(googleEnv),
    { query, now: () => NOW },
  );
  assert.equal(googleOk.status, 200);
  const googleUnsigned = await handle(
    storeHook("/api/v1/billing/webhook/google-play", JSON.stringify({ message: { data: btoa(JSON.stringify({ subscriptionNotification: { notificationType: 2 } })) } }), "Bearer " + oidcJwt),
    envOf(googleEnv),
    { query, now: () => NOW },
  );
  assert.equal(googleUnsigned.status, 400);
  assert.equal((await codeOf(googleUnsigned)).message, "invalid webhook signature");
  const googleBare = await handle(
    storeHook("/api/v1/billing/webhook/google-play", playBody),
    envOf(googleEnv),
    { query, now: () => NOW },
  );
  assert.equal(googleBare.status, 400);
  assert.equal((await codeOf(googleBare)).message, "invalid webhook signature");
  const googleAud = await handle(
    storeHook("/api/v1/billing/webhook/google-play", playBody, "Bearer " + oidcJwt),
    envOf({ ...googleEnv, GOOGLE_OIDC_AUDIENCE: "other-audience" }),
    { query, now: () => NOW },
  );
  assert.equal(googleAud.status, 400);
  assert.equal((await codeOf(googleAud)).message, "invalid webhook signature");
  const googleIss = await handle(
    storeHook("/api/v1/billing/webhook/google-play", playBody, "Bearer " + await jws({ iss: "https://evil.example", aud: audience, exp: NOW.getTime() / 1000 + 600 }, oidc.privateKey)),
    envOf(googleEnv),
    { query, now: () => NOW },
  );
  assert.equal(googleIss.status, 400);
  assert.equal((await codeOf(googleIss)).message, "invalid webhook signature");
  const googleBadSig = await handle(
    storeHook("/api/v1/billing/webhook/google-play", playBody, "Bearer " + flipSig(oidcJwt)),
    envOf(googleEnv),
    { query, now: () => NOW },
  );
  assert.equal(googleBadSig.status, 400);
  assert.equal((await codeOf(googleBadSig)).message, "invalid webhook signature");
  const googleNoAud = await handle(
    storeHook("/api/v1/billing/webhook/google-play", playBody, "Bearer " + oidcJwt),
    envOf({ GOOGLE_PLAY_KEY: play.pem, GOOGLE_OIDC_KEY: oidc.pem }),
    { query, now: () => NOW },
  );
  assert.equal(googleNoAud.status, 503);
  assert.equal((await codeOf(googleNoAud)).code, "NOT_CONFIGURED");
  const googleRawKey = await handle(
    storeHook("/api/v1/billing/webhook/google-play", playBody, "Bearer " + oidcJwt),
    envOf({ GOOGLE_PLAY_KEY: play.pem, GOOGLE_OIDC_KEY: "not-a-key", GOOGLE_OIDC_AUDIENCE: audience }),
    { query, now: () => NOW },
  );
  assert.equal(googleRawKey.status, 503);
  assert.equal((await codeOf(googleRawKey)).code, "NOT_CONFIGURED");
});

const noStores = {
  verifyGoogle: async () => { throw new Error("google"); },
  decodeAppleNotification: async () => { throw new Error("apple"); },
  decodeGoogleNotification: async () => { throw new Error("google"); },
};

test("a store transaction already claimed by another account is refused", async () => {
  resetLimits();
  const seen: Call[] = [];
  const ledger: LedgerRow[] = [];
  const capture = takeLedger(ledger);
  const query = authed(seen, false, null, async (sql, params = []) => {
    const taken = capture(sql, params);
    if (taken) return taken;
    return empty;
  });
  const stores: NonNullable<Deps["stores"]> = {
    ...noStores,
    verifyApple: async () => ({ productId: "ios.pro", originalTransactionId: "tx-shared", expiresAt: null, consumable: false }),
  };
  const res = await handle(
    post("/api/v1/billing/iap/verify", { platform: "APP_STORE", productId: "ios.pro", signedTransaction: "jws" }, "88888888-8888-4888-8888-888888888881"),
    envOf(),
    { query, now: () => NOW, stores },
  );
  assert.equal(res.status, 409);
  assert.equal((await codeOf(res)).code, "CONFLICT");
  const claim = seen.find((call) => call.sql.includes("INSERT INTO iap_subscriptions"));
  assert.match(claim?.sql ?? "", /WHERE iap_subscriptions\.user_id = EXCLUDED\.user_id RETURNING user_id/);
  assert.equal(ledger.length, 0);
  assert.equal(seen.some((call) => call.sql.includes("UPDATE users")), false);
});

test("a consumed top-up transaction cannot be replayed from another account", async () => {
  resetLimits();
  const seen: Call[] = [];
  const ledger: LedgerRow[] = [];
  const capture = takeLedger(ledger);
  const query = authed(seen, false, null, async (sql, params = []) => capture(sql, params) ?? empty);
  const stores: NonNullable<Deps["stores"]> = {
    ...noStores,
    verifyApple: async () => ({ productId: "ios.topup", originalTransactionId: "top-shared", expiresAt: null, consumable: true }),
  };
  const res = await handle(
    post("/api/v1/billing/iap/verify", { platform: "APP_STORE", productId: "ios.topup", signedTransaction: "jws" }, "88888888-8888-4888-8888-888888888882"),
    envOf(),
    { query, now: () => NOW, stores },
  );
  assert.equal(res.status, 409);
  const claim = seen.find((call) => call.sql.includes("INSERT INTO iap_subscriptions"));
  assert.equal(claim?.params[6], "CONSUMED");
  assert.equal(ledger.length, 0);
});

test("an expired subscription receipt does not upgrade the plan", async () => {
  resetLimits();
  const seen: Call[] = [];
  const query = authed(seen, false, null, async () => empty);
  const stores: NonNullable<Deps["stores"]> = {
    ...noStores,
    verifyApple: async () => ({ productId: "ios.pro", originalTransactionId: "tx-old", expiresAt: "2026-09-01T00:00:00.000Z", consumable: false }),
  };
  const res = await handle(
    post("/api/v1/billing/iap/verify", { platform: "APP_STORE", productId: "ios.pro", signedTransaction: "jws" }, "88888888-8888-4888-8888-888888888883"),
    envOf(),
    { query, now: () => NOW, stores },
  );
  assert.equal(res.status, 400);
  assert.equal(seen.some((call) => call.sql.includes("iap_subscriptions") || call.sql.includes("UPDATE users")), false);
});

const claimQuery = (seen: Call[]): Deps["query"] => authed(seen, false, null, async (sql) => {
  if (sql.includes("INSERT INTO iap_subscriptions")) return { rows: [{ user_id: USER }], rowCount: 1 };
  return empty;
});

test("device apple verify checks the x5c chain and bundle id locally", async () => {
  resetLimits();
  const chain = await appleChain();
  const signed = (bundleId: string, extra: Record<string, unknown> = {}) => jws({
    bundleId, productId: "ios.pro", originalTransactionId: "tx-apple", expiresDate: Date.parse("2026-11-21T00:00:00Z"), type: "Auto-Renewable Subscription", ...extra,
  }, chain.privateKey, { x5c: chain.x5c });
  const env = envOf({ APPLE_ROOT_PEM: chain.rootPem, APPLE_BUNDLE_ID: "com.push.app" });
  let fetched = 0;
  const fetchImpl = (async () => { fetched += 1; return new Response("{}"); }) as typeof fetch;
  const verify = async (token: string, key: string) => handle(
    post("/api/v1/billing/iap/verify", { platform: "APP_STORE", productId: "ios.pro", signedTransaction: token }, key),
    env,
    { query: claimQuery([]), now: () => NOW, fetch: fetchImpl },
  );
  const ok = await verify(await signed("com.push.app"), "99999999-9999-4999-8999-999999999991");
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { data: { plan: "PRO", periodEndsAt: "2026-11-21T00:00:00Z" } });
  const otherApp = await verify(await signed("com.evil.app"), "99999999-9999-4999-8999-999999999992");
  assert.equal(otherApp.status, 400);
  const revoked = await verify(await signed("com.push.app", { revocationDate: 1 }), "99999999-9999-4999-8999-999999999993");
  assert.equal(revoked.status, 400);
  const forged = await verify(flipSig(await signed("com.push.app")), "99999999-9999-4999-8999-999999999994");
  assert.equal(forged.status, 400);
  assert.equal(fetched, 0);
});

test("google verify grants only a purchased product or a live subscription", async () => {
  resetLimits();
  const urls: string[] = [];
  const reply = (body: unknown): typeof fetch => (async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return Response.json(body);
  }) as typeof fetch;
  const env = envOf({ GOOGLE_PLAY_KEY: "play-token", GOOGLE_PLAY_PACKAGE: "com.push.app", IAP_PRODUCT_TOPUP: "top", IAP_PRODUCT_PRO: "pro" });
  const verify = (productId: string, fetchImpl: typeof fetch, key: string) => handle(
    post("/api/v1/billing/iap/verify", { platform: "GOOGLE_PLAY", productId, purchaseToken: "tok-1" }, key),
    env,
    { query: claimQuery([]), now: () => NOW, fetch: fetchImpl },
  );
  const pending = await verify("top", reply({ purchaseState: 2, orderId: "GPA.1" }), "99999999-9999-4999-8999-99999999999a");
  assert.equal(pending.status, 400);
  const paid = await verify("top", reply({ purchaseState: 0, orderId: "GPA.1" }), "99999999-9999-4999-8999-99999999999b");
  assert.equal(paid.status, 200);
  assert.match(urls[1] ?? "", /\/purchases\/products\/top\/tokens\/tok-1$/);
  const lapsed = await verify("pro", reply({ subscriptionState: "SUBSCRIPTION_STATE_EXPIRED", lineItems: [{ productId: "pro" }] }), "99999999-9999-4999-8999-99999999999c");
  assert.equal(lapsed.status, 400);
  const live = await verify("pro", reply({ subscriptionState: "SUBSCRIPTION_STATE_ACTIVE", lineItems: [{ productId: "pro", expiryTime: "2026-11-21T00:00:00Z" }] }), "99999999-9999-4999-8999-99999999999d");
  assert.equal(live.status, 200);
  assert.match(urls[3] ?? "", /\/purchases\/subscriptionsv2\/tokens\/tok-1$/);
});

test("an expired google oidc bearer is rejected", async () => {
  resetLimits();
  const play = await p256();
  const oidc = await p256();
  const audience = "push-google-webhook";
  const note = await jws({ subscriptionNotification: { notificationType: 4, purchaseToken: "tok-1", subscriptionId: "ios.pro" } }, play.privateKey);
  const env = envOf({ GOOGLE_PLAY_KEY: play.pem, GOOGLE_OIDC_KEY: oidc.pem, GOOGLE_OIDC_AUDIENCE: audience });
  const hook = async (claims: Record<string, unknown>) => handle(
    storeHook("/api/v1/billing/webhook/google-play", JSON.stringify({ signedPayload: note }), "Bearer " + await jws({ iss: "https://accounts.google.com", aud: audience, ...claims }, oidc.privateKey)),
    env,
    { query: rejectQuery(), now: () => NOW },
  );
  assert.equal((await hook({ exp: NOW.getTime() / 1000 - 1 })).status, 400);
  assert.equal((await hook({})).status, 400);
  assert.equal((await hook({ exp: NOW.getTime() / 1000 + 60 })).status, 200);
});

test("an unpaid checkout grants nothing until the async payment succeeds", async () => {
  resetLimits();
  const ledger: LedgerRow[] = [];
  const capture = takeLedger(ledger);
  const query: Deps["query"] = async (sql, params = []) => {
    if (sql.includes("rate_limits")) return { rows: [{ hits: 1 }], rowCount: 1 };
    if (sql.includes("INSERT INTO stripe_events")) return { rows: [{ event_id: params[0] }], rowCount: 1 };
    return capture(sql, params) ?? empty;
  };
  const session = (paymentStatus: string) => ({
    id: "cs_async", client_reference_id: USER, payment_status: paymentStatus,
    metadata: { amountMicroCredits: "60000", audience: "PERSONAL", ownerId: USER },
  });
  const unpaid = await handle(await signedStripe(JSON.stringify({ id: "evt_1", type: "checkout.session.completed", data: { object: session("unpaid") } })), envOf(), { query, now: () => NOW });
  assert.equal(unpaid.status, 200);
  assert.equal(ledger.length, 0);
  const paid = await handle(await signedStripe(JSON.stringify({ id: "evt_2", type: "checkout.session.async_payment_succeeded", data: { object: session("paid") } })), envOf(), { query, now: () => NOW });
  assert.equal(paid.status, 200);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0]?.reference, "cs_async");
});

test("an unpaid stripe subscription drops the user to FREE", async () => {
  resetLimits();
  const seen: Call[] = [];
  const query: Deps["query"] = async (sql, params = []) => {
    seen.push({ sql, params });
    if (sql.includes("rate_limits")) return { rows: [{ hits: 1 }], rowCount: 1 };
    if (sql.includes("INSERT INTO stripe_events")) return { rows: [{ event_id: params[0] }], rowCount: 1 };
    if (sql.includes("UPDATE users")) return { rows: [{ id: USER }], rowCount: 1 };
    return empty;
  };
  const event = { id: "evt_3", type: "customer.subscription.updated", data: { object: { customer: "cus_1", status: "unpaid", items: { data: [{ price: { id: "price_pro" } }] } } } };
  const res = await handle(await signedStripe(JSON.stringify(event)), envOf(), { query, now: () => NOW });
  assert.equal(res.status, 200);
  const update = seen.find((call) => call.sql.includes("UPDATE users"));
  assert.equal(update?.params[1], "CANCELED");
  assert.equal(update?.params[3], "FREE");
});

test("a top-up above the cap is rejected before stripe is called", async () => {
  resetLimits();
  const calls: { url: string; body: string }[] = [];
  const res = await handle(
    post("/api/v1/billing/topup", { amount: 100_001 }, "77777777-7777-4777-8777-777777777778"),
    envOf(),
    { query: authed([], false, null, async () => empty), now: () => NOW, fetch: stripeFetch(calls) },
  );
  assert.equal(res.status, 400);
  assert.equal(calls.length, 0);
});
