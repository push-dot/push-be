import assert from "node:assert/strict";
import { test } from "node:test";

import { createStoreReceipts } from "../src/billing/stores.ts";
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
  APP_ENV: "production", PAYMENTS_ENABLED: "1",
  STRIPE_SECRET_KEY: "sk_test",
  STRIPE_WEBHOOK_SECRET: "whsec_test",
  STRIPE_PRICE_PRO: "price_pro",
  STRIPE_PRICE_ULTRA: "price_ultra",
  STRIPE_PRICE_EMPLOYER_BASIC: "price_employer_basic",
  STRIPE_PRICE_EMPLOYER_PRO: "price_employer_pro",
  STRIPE_PRICE_EMPLOYER_ULTRA: "price_employer_ultra",
  STRIPE_PRICE_TOPUP: "price_topup",
  STRIPE_RETURN_ORIGINS: "https://web.example,http://localhost:5174",
  IAP_PRODUCT_PRO: "ios.pro",
  IAP_PRODUCT_ULTRA: "ios.ultra",
  IAP_PRODUCT_TOPUP: "ios.topup",
  ...extra,
});

const tokenRow = (employer: boolean, role: string | null, plan = "FREE", subscription = "NONE", stripeCustomerId: string | null = null) => ({
  id: USER,
  display_name: "Ada",
  locale: "ko",
  plan,
  subscription_status: subscription,
  stripe_customer_id: stripeCustomerId,
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
  stripeCustomerId: string | null = null,
): Deps["query"] => async (sql, params = []) => {
  seen.push({ sql, params });
  if (sql.includes("rate_limits")) return { rows: [{ hits: 1 }], rowCount: 1 };
  if (sql.includes("access_tokens")) return { rows: [tokenRow(employer, role, plan, subscription, stripeCustomerId)], rowCount: 1 };
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

test("personal checkout is forbidden", async () => {
  resetLimits();
  const calls: { url: string; body: string }[] = [];
  const seen: Call[] = [];
  const query = authed(seen, false, null, async () => empty);
  for (const planId of ["BASIC", "PRO", "ULTRA"]) {
    resetLimits();
    const res = await handle(
      post("/api/v1/billing/checkout", { planId }, "33333333-3333-4333-8333-333333333333"),
      envOf(),
      { query, now: () => NOW, fetch: stripeFetch(calls) },
    );
    assert.equal(res.status, 403, planId);
    assert.equal((await codeOf(res)).code, "FORBIDDEN");
  }
  assert.equal(calls.length, 0);
});

test("iap verify while stripe is active returns 409", async () => {
  resetLimits();
  const seen: Call[] = [];
  let verified = 0;
  const query = authed(seen, false, null, async () => empty, "PRO", "ACTIVE", "cus_live");
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
    if (sql.includes("SELECT original_transaction_id FROM iap_subscriptions WHERE user_id")) {
      return { rows: [{ original_transaction_id: "tx-1" }], rowCount: 1 };
    }
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
  assert.equal(ledger[0]?.amount, 27_000_000);
  assert.equal(ledger[0]?.reference, "tx-1");
  assert.equal(ledger[0]?.userId, USER);
  assert.equal(ledger[0]?.companyId, null);
  assert.equal(oneOwner(ledger[0] as LedgerRow), true);
});

test("employer checkout with no subscription records the payment once and changes no plan", async () => {
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
  assert.equal(ledger[0]?.amount, 0);
  assert.equal(ledger[0]?.reference, "cs_emp");
  assert.equal(ledger[0]?.companyId, COMPANY);
  assert.equal(ledger[0]?.userId, null);
  assert.deepEqual(updates, []);
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
    if (sql.startsWith("SELECT id, stripe_subscription_id FROM companies")) return { rows: [{ id: COMPANY, stripe_subscription_id: "sub_1" }], rowCount: 1 };
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
    if (sql.startsWith("SELECT 1 FROM companies")) return empty; // monthGranted: the fake ledger is not queried
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
      paymentsEnabled: true,
      creditsRefillAt: "2026-11-01T00:00:00.000Z",
    },
  });
  const second = await handle(get("/api/v1/billing"), envOf(), deps);
  assert.equal(second.status, 200);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0]?.reference, MONTH + ":BASIC");
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
  assert.equal("creditsRefillAt" in body.data, false);
  assert.equal(seen.some((call) => call.sql.includes("INSERT INTO billing_ledger")), false);
});

test("personal status names the first instant of the next UTC month as the credits refill time", async () => {
  const cases = [
    ["2026-11-12T10:00:00.000Z", "2026-12-01T00:00:00.000Z"],
    ["2026-12-31T23:59:59.000Z", "2027-01-01T00:00:00.000Z"],
    ["2026-11-30T23:59:59.999Z", "2026-12-01T00:00:00.000Z"],
    ["2026-12-01T00:00:00.000Z", "2027-01-01T00:00:00.000Z"],
    ["2027-01-01T00:00:00.000Z", "2027-02-01T00:00:00.000Z"],
    ["2028-02-29T12:00:00.000Z", "2028-03-01T00:00:00.000Z"],
  ] as const;
  for (const [now, refill] of cases) {
    resetLimits();
    const query = authed([], false, null, async (sql) => sql.includes("balance_after") ? { rows: [{ balance_after: 0 }], rowCount: 1 } : empty);
    const res = await handle(get("/api/v1/billing"), envOf(), { query, now: () => new Date(now) });
    assert.equal(res.status, 200);
    assert.equal((await res.json() as { data: { creditsRefillAt?: string } }).data.creditsRefillAt, refill, now);
  }
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
  assert.equal(ledger[0]?.amount, 27_000_000);
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
  assert.equal(body.data.monthlyMicroCredits, 27_000_000);
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

const GOOGLE_CERTS = "https://www.googleapis.com/oauth2/v3/certs";
const OAUTH_TOKEN = "https://oauth2.googleapis.com/token";

const rsaOidc = async (kid: string) => {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const exported = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const jwk = { kty: "RSA", alg: "RS256", use: "sig", kid, n: exported.n, e: exported.e };
  const sign = async (payload: Record<string, unknown>) => {
    const head = text64(JSON.stringify({ alg: "RS256", kid, typ: "JWT" }));
    const body = text64(JSON.stringify(payload));
    const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(`${head}.${body}`)));
    return `${head}.${body}.${b64url(sig)}`;
  };
  return { jwk, sign };
};

const certsFetch = (keys: Record<string, unknown>[], hits?: { n: number }, maxAge = 3600): typeof fetch => (async (input: RequestInfo | URL) => {
  if (hits) hits.n += 1;
  if (String(input) !== GOOGLE_CERTS) return new Response("no", { status: 500 });
  return new Response(JSON.stringify({ keys }), {
    status: 200,
    headers: { "cache-control": `public, max-age=${maxAge}` },
  });
}) as typeof fetch;

const serviceAccount = async (email: string): Promise<string> => {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const pem = `-----BEGIN PRIVATE KEY-----\n${b64std(pkcs8)}\n-----END PRIVATE KEY-----`;
  return JSON.stringify({ client_email: email, private_key: pem });
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

test("personal top-up is forbidden", async () => {
  resetLimits();
  const calls: { url: string; body: string }[] = [];
  const res = await handle(
    post("/api/v1/billing/topup", { packs: 3 }, "77777777-7777-4777-8777-777777777777"),
    envOf(),
    { query: authed([], false, null, async () => empty), now: () => NOW, fetch: stripeFetch(calls) },
  );
  assert.equal(res.status, 403);
  assert.equal((await codeOf(res)).code, "FORBIDDEN");
  assert.equal(calls.length, 0);
});

test("employer top-up charges one $10 price unit per 1,500-credit pack", async () => {
  resetLimits();
  const calls: { url: string; body: string }[] = [];
  const seen: Call[] = [];
  const query = authed(seen, true, "ADMIN", async (sql) => {
    if (sql.includes("FROM companies")) return { rows: [{ stripe_customer_id: "cus_co" }], rowCount: 1 };
    return empty;
  });
  const res = await handle(
    post("/api/v1/billing/topup", { packs: 3 }, "77777777-7777-4777-8777-777777777779"),
    envOf(),
    { query, now: () => NOW, fetch: stripeFetch(calls) },
  );
  assert.equal(res.status, 200);
  const form = new URLSearchParams(calls[0]?.body);
  assert.equal(form.get("line_items[0][quantity]"), "3");
  assert.equal(form.get("metadata[amountMicroCredits]"), String(3 * 1500 * 6000));
  assert.equal(form.get("metadata[audience]"), "EMPLOYER");
  assert.equal(form.get("customer"), "cus_co");
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
  const oidc = await rsaOidc("oidc-webhook");
  const query = rejectQuery();
  const audience = "push-google-webhook";
  const inner = await jws({ originalTransactionId: "tx-1", productId: "ios.pro", expiresDate: 1792886400000 }, chain.privateKey);
  const appleBody = await jws({ notificationType: "DID_RENEW", data: { signedTransactionInfo: inner } }, chain.privateKey, { x5c: chain.x5c });
  const playBody = JSON.stringify({ signedPayload: "not.a.pubsub" });
  const oidcJwt = await oidc.sign({ iss: "https://accounts.google.com", aud: audience, exp: NOW.getTime() / 1000 + 600 });
  const googleEnv = { GOOGLE_OIDC_AUDIENCE: audience };
  const certs = certsFetch([oidc.jwk]);
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
  assert.equal(missingRoot.status, 400);
  assert.equal((await codeOf(missingRoot)).message, "invalid webhook signature");
  const googleOk = await handle(
    storeHook("/api/v1/billing/webhook/google-play", playBody, "Bearer " + oidcJwt),
    envOf(googleEnv),
    { query, now: () => NOW, fetch: certs },
  );
  assert.equal(googleOk.status, 400);
  assert.equal((await codeOf(googleOk)).message, "invalid webhook signature");
  const googlePush = await handle(
    storeHook("/api/v1/billing/webhook/google-play", JSON.stringify({ message: { data: btoa(JSON.stringify({ subscriptionNotification: { notificationType: 2 } })) } }), "Bearer " + oidcJwt),
    envOf(googleEnv),
    { query, now: () => NOW, fetch: certs },
  );
  assert.equal(googlePush.status, 200);
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
    { query, now: () => NOW, fetch: certs },
  );
  assert.equal(googleAud.status, 400);
  assert.equal((await codeOf(googleAud)).message, "invalid webhook signature");
  const googleIss = await handle(
    storeHook("/api/v1/billing/webhook/google-play", playBody, "Bearer " + await oidc.sign({ iss: "https://evil.example", aud: audience, exp: NOW.getTime() / 1000 + 600 })),
    envOf(googleEnv),
    { query, now: () => NOW, fetch: certs },
  );
  assert.equal(googleIss.status, 400);
  assert.equal((await codeOf(googleIss)).message, "invalid webhook signature");
  const googleBadSig = await handle(
    storeHook("/api/v1/billing/webhook/google-play", playBody, "Bearer " + flipSig(oidcJwt)),
    envOf(googleEnv),
    { query, now: () => NOW, fetch: certs },
  );
  assert.equal(googleBadSig.status, 400);
  assert.equal((await codeOf(googleBadSig)).message, "invalid webhook signature");
  const googleNoAud = await handle(
    storeHook("/api/v1/billing/webhook/google-play", playBody, "Bearer " + oidcJwt),
    envOf(),
    { query, now: () => NOW },
  );
  assert.equal(googleNoAud.status, 503);
  assert.equal((await codeOf(googleNoAud)).code, "NOT_CONFIGURED");
  const otherKey = await rsaOidc("oidc-webhook-other");
  const googleWrongKey = await handle(
    storeHook("/api/v1/billing/webhook/google-play", playBody, "Bearer " + await otherKey.sign({ iss: "https://accounts.google.com", aud: audience, exp: NOW.getTime() / 1000 + 600 })),
    envOf(googleEnv),
    { query, now: () => NOW, fetch: certsFetch([{ ...oidc.jwk, kid: "oidc-webhook-other" }]) },
  );
  assert.equal(googleWrongKey.status, 400);
  assert.equal((await codeOf(googleWrongKey)).message, "invalid webhook signature");
});

const noStores = {
  verifyApple: async () => { throw new Error("apple"); },
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
  assert.equal(claim?.params[7], false);
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

const partJson = (part: string): Record<string, unknown> => {
  const pad = part.replaceAll("-", "+").replaceAll("_", "/");
  const padded = pad + "=".repeat((4 - (pad.length % 4)) % 4);
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(padded), (char) => char.charCodeAt(0)))) as Record<string, unknown>;
};

test("device apple verify checks the x5c chain then the App Store Server API", async () => {
  resetLimits();
  const chain = await appleChain();
  const signing = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", signing.privateKey));
  const apiKey = `-----BEGIN PRIVATE KEY-----\n${b64std(pkcs8)}\n-----END PRIVATE KEY-----`;
  const signed = (bundleId: string, extra: Record<string, unknown> = {}) => jws({
    bundleId, productId: "ios.pro", originalTransactionId: "tx-apple", transactionId: "tx-apple", expiresDate: Date.parse("2026-11-21T00:00:00Z"), type: "Auto-Renewable Subscription", ...extra,
  }, chain.privateKey, { x5c: chain.x5c });
  const env = envOf({
    APPLE_ROOT_PEM: chain.rootPem,
    APPLE_BUNDLE_ID: "com.push.app",
    APPLE_IAP_KEY: apiKey,
    APPLE_IAP_KEY_ID: "key-1",
    APPLE_ISSUER_ID: "issuer-1",
  });
  let fetched = 0;
  let echo = "";
  let mode: "echo" | "other" = "echo";
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    fetched += 1;
    assert.match(String(input), /https:\/\/api\.storekit\.itunes\.apple\.com\/inApps\/v1\/transactions\/tx-apple$/);
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    const [head, body] = auth.slice("Bearer ".length).split(".");
    assert.equal(partJson(head ?? "").kid, "key-1");
    const claims = partJson(body ?? "");
    assert.equal(claims.iss, "issuer-1");
    assert.equal(claims.aud, "appstoreconnect-v1");
    assert.equal(claims.bid, "com.push.app");
    const signedInfo = mode === "echo"
      ? echo
      : await jws({ bundleId: "com.push.app", productId: "ios.other", originalTransactionId: "tx-apple", expiresDate: Date.parse("2026-11-21T00:00:00Z") }, chain.privateKey, { x5c: chain.x5c });
    return Response.json({ signedTransactionInfo: signedInfo });
  }) as typeof fetch;
  const verify = async (token: string, key: string, use: CoreEnv = env, seen: Call[] = []) => handle(
    post("/api/v1/billing/iap/verify", { platform: "APP_STORE", productId: "ios.pro", signedTransaction: token }, key),
    use,
    { query: claimQuery(seen), now: () => NOW, fetch: fetchImpl },
  );
  echo = await signed("com.push.app");
  const seen: Call[] = [];
  const ok = await verify(echo, "99999999-9999-4999-8999-999999999991", env, seen);
  assert.equal(ok.status, 200);
  assert.equal(seen.find((call) => call.sql.includes("INSERT INTO iap_subscriptions"))?.params[7], false);
  assert.equal(fetched, 1);
  assert.deepEqual(await ok.json(), { data: { plan: "PRO", periodEndsAt: "2026-11-21T00:00:00Z" } });
  const beforeRejects = fetched;
  const otherApp = await verify(await signed("com.evil.app"), "99999999-9999-4999-8999-999999999992");
  assert.equal(otherApp.status, 400);
  const revoked = await verify(await signed("com.push.app", { revocationDate: 1 }), "99999999-9999-4999-8999-999999999993");
  assert.equal(revoked.status, 400);
  const forged = await verify(flipSig(await signed("com.push.app")), "99999999-9999-4999-8999-999999999994");
  assert.equal(forged.status, 400);
  assert.equal(fetched, beforeRejects);
  mode = "other";
  const mismatch = await verify(echo, "99999999-9999-4999-8999-999999999995");
  assert.equal(mismatch.status, 400);
  const beforeMissing = fetched;
  const unconfigured = await verify(echo, "99999999-9999-4999-8999-999999999996", envOf({ APPLE_ROOT_PEM: chain.rootPem, APPLE_BUNDLE_ID: "com.push.app" }));
  assert.equal(unconfigured.status, 503);
  assert.equal((await codeOf(unconfigured)).code, "NOT_CONFIGURED");
  assert.equal(fetched, beforeMissing);
});

test("apple verify follows the signed environment and marks sandbox", async () => {
  resetLimits();
  const chain = await appleChain();
  const signing = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", signing.privateKey));
  const apiKey = `-----BEGIN PRIVATE KEY-----\n${b64std(pkcs8)}\n-----END PRIVATE KEY-----`;
  const env = envOf({
    APPLE_ROOT_PEM: chain.rootPem,
    APPLE_BUNDLE_ID: "com.push.app",
    APPLE_IAP_KEY: apiKey,
    APPLE_IAP_KEY_ID: "key-1",
    APPLE_ISSUER_ID: "issuer-1",
  });
  const tx = (environment: "Sandbox" | "Production", id: string) => jws({
    bundleId: "com.push.app",
    productId: "ios.pro",
    originalTransactionId: id,
    transactionId: id,
    environment,
    expiresDate: Date.parse("2026-11-21T00:00:00Z"),
    type: "Auto-Renewable Subscription",
  }, chain.privateKey, { x5c: chain.x5c });
  const hosts: string[] = [];
  let echoed = "";
  let swap = false;
  const fetchImpl = (async (input: RequestInfo | URL) => {
    hosts.push(String(input));
    const info = swap
      ? await tx("Production", "tx-sand")
      : echoed;
    return Response.json({ signedTransactionInfo: info });
  }) as typeof fetch;
  const run = async (token: string, id: string, key: string) => {
    const seen: Call[] = [];
    const res = await handle(
      post("/api/v1/billing/iap/verify", { platform: "APP_STORE", productId: "ios.pro", signedTransaction: token }, key),
      env,
      { query: claimQuery(seen), now: () => NOW, fetch: fetchImpl },
    );
    return { res, seen };
  };
  echoed = await tx("Production", "tx-live");
  const live = await run(echoed, "tx-live", "99999999-9999-4999-8999-999999999981");
  assert.equal(live.res.status, 200);
  assert.match(hosts[0] ?? "", /^https:\/\/api\.storekit\.itunes\.apple\.com\/inApps\/v1\/transactions\/tx-live$/);
  assert.equal(live.seen.find((call) => call.sql.includes("INSERT INTO iap_subscriptions"))?.params[7], false);
  echoed = await tx("Sandbox", "tx-sand");
  const sand = await run(echoed, "tx-sand", "99999999-9999-4999-8999-999999999982");
  assert.equal(sand.res.status, 200);
  assert.match(hosts[1] ?? "", /^https:\/\/api\.storekit-sandbox\.itunes\.apple\.com\/inApps\/v1\/transactions\/tx-sand$/);
  assert.equal(sand.seen.find((call) => call.sql.includes("INSERT INTO iap_subscriptions"))?.params[7], true);
  assert.deepEqual(await sand.res.json(), { data: { plan: "PRO", periodEndsAt: "2026-11-21T00:00:00Z" } });
  swap = true;
  const mismatch = await run(echoed, "tx-sand", "99999999-9999-4999-8999-999999999983");
  assert.equal(mismatch.res.status, 400);
  assert.match(hosts[2] ?? "", /api\.storekit-sandbox\.itunes\.apple\.com/);
  assert.equal(mismatch.seen.some((call) => call.sql.includes("INSERT INTO iap_subscriptions")), false);
});

test("a sandbox app store notification is marked sandbox", async () => {
  resetLimits();
  const chain = await appleChain();
  const seen: Call[] = [];
  const query: Deps["query"] = async (sql, params = []) => {
    seen.push({ sql, params });
    if (sql.includes("rate_limits")) return { rows: [{ hits: 1 }], rowCount: 1 };
    if (sql.includes("SELECT user_id FROM iap_subscriptions")) return { rows: [{ user_id: USER }], rowCount: 1 };
    if (sql.includes("UPDATE")) return { rows: [{ id: USER }], rowCount: 1 };
    if (sql.includes("INSERT INTO billing_ledger")) return empty;
    return empty;
  };
  const note = async (environment: "Sandbox" | "Production", id: string) => {
    const inner = await jws({
      originalTransactionId: id,
      productId: "ios.pro",
      environment,
      expiresDate: Date.parse("2026-12-01T00:00:00Z"),
    }, chain.privateKey);
    return jws({ notificationType: "DID_RENEW", data: { environment, signedTransactionInfo: inner } }, chain.privateKey, { x5c: chain.x5c });
  };
  const env = envOf({ APPLE_ROOT_PEM: chain.rootPem });
  const sand = await handle(storeHook("/api/v1/billing/webhook/app-store", await note("Sandbox", "tx-note-sand")), env, { query, now: () => NOW });
  assert.equal(sand.status, 200);
  const sandUpdate = seen.find((call) => call.sql.includes("UPDATE iap_subscriptions") && call.params[0] === "tx-note-sand");
  assert.equal(sandUpdate?.params[3], true);
  const live = await handle(storeHook("/api/v1/billing/webhook/app-store", await note("Production", "tx-note-live")), env, { query, now: () => NOW });
  assert.equal(live.status, 200);
  const liveUpdate = seen.find((call) => call.sql.includes("UPDATE iap_subscriptions") && call.params[0] === "tx-note-live");
  assert.equal(liveUpdate?.params[3], false);
});

test("a non-json google play key is not sent as a bearer", async () => {
  resetLimits();
  let fetched = 0;
  const fetchImpl = (async () => {
    fetched += 1;
    return Response.json({});
  }) as typeof fetch;
  const res = await handle(
    post("/api/v1/billing/iap/verify", { platform: "GOOGLE_PLAY", productId: "top", purchaseToken: "tok-1" }, "99999999-9999-4999-8999-99999999997a"),
    envOf({ GOOGLE_PLAY_KEY: "play-token", GOOGLE_PLAY_PACKAGE: "com.push.app", IAP_PRODUCT_TOPUP: "top" }),
    { query: claimQuery([]), now: () => NOW, fetch: fetchImpl },
  );
  assert.equal(res.status, 503);
  assert.equal((await codeOf(res)).code, "NOT_CONFIGURED");
  assert.equal(fetched, 0);
});

test("google verify grants only a purchased product or a live subscription", async () => {
  resetLimits();
  const urls: string[] = [];
  const reply = (body: unknown): typeof fetch => (async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    if (url === OAUTH_TOKEN) return Response.json({ access_token: "ya29.play", expires_in: 3600 });
    return Response.json(body);
  }) as typeof fetch;
  const env = envOf({
    GOOGLE_PLAY_KEY: await serviceAccount("play-state@push.iam.gserviceaccount.com"),
    GOOGLE_PLAY_PACKAGE: "com.push.app",
    IAP_PRODUCT_TOPUP: "top",
    IAP_PRODUCT_PRO: "pro",
  });
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
  assert.equal(urls.filter((url) => url === OAUTH_TOKEN).length, 1);
});

test("google verify exchanges a service account for an access token", async () => {
  resetLimits();
  const key = await serviceAccount("play-exchange@push.iam.gserviceaccount.com");
  const calls: { url: string; auth: string }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, auth: new Headers(init?.headers).get("authorization") ?? "" });
    if (url === OAUTH_TOKEN) return Response.json({ access_token: "ya29.test", expires_in: 3600 });
    return Response.json({ purchaseState: 0, orderId: "GPA.1" });
  }) as typeof fetch;
  const env = envOf({ GOOGLE_PLAY_KEY: key, GOOGLE_PLAY_PACKAGE: "app.push.mobile", IAP_PRODUCT_TOPUP: "push.credits.topup" });
  const verify = (id: string, now: Date) => handle(
    post("/api/v1/billing/iap/verify", { platform: "GOOGLE_PLAY", productId: "push.credits.topup", purchaseToken: "tok-1" }, id),
    env,
    { query: claimQuery([]), now: () => now, fetch: fetchImpl },
  );
  const res = await verify("99999999-9999-4999-8999-9999999999a1", NOW);
  assert.equal(res.status, 200);
  assert.equal(calls[0]?.url, OAUTH_TOKEN);
  assert.equal(calls[1]?.auth, "Bearer ya29.test");
  assert.equal(calls[1]?.url?.endsWith("/purchases/products/push.credits.topup/tokens/tok-1"), true);
  const again = await verify("99999999-9999-4999-8999-9999999999a2", NOW);
  assert.equal(again.status, 200);
  assert.equal(calls.filter((call) => call.url === OAUTH_TOKEN).length, 1);
  const later = await verify("99999999-9999-4999-8999-9999999999a3", new Date(NOW.getTime() + 3600 * 1000));
  assert.equal(later.status, 200);
  assert.equal(calls.filter((call) => call.url === OAUTH_TOKEN).length, 2);
  assert.equal(calls.at(-2)?.url, OAUTH_TOKEN);
  assert.equal(calls.at(-1)?.auth, "Bearer ya29.test");
});

test("an active in-app plan can change without a second grant for the same transaction", async () => {
  resetLimits();
  const seen: Call[] = [];
  const ledger: LedgerRow[] = [];
  const capture = takeLedger(ledger);
  const query = authed(seen, false, null, async (sql, params = []) => {
    const taken = capture(sql, params);
    if (taken) return taken;
    if (sql.includes("INSERT INTO iap_subscriptions")) return { rows: [{ user_id: USER }], rowCount: 1 };
    if (sql.includes("UPDATE")) return { rows: [{ id: USER }], rowCount: 1 };
    return empty;
  }, "PRO", "ACTIVE");
  const stores: NonNullable<Deps["stores"]> = {
    ...noStores,
    verifyApple: async () => ({ productId: "ios.ultra", originalTransactionId: "tx-up", expiresAt: "2026-11-21T00:00:00.000Z", consumable: false }),
  };
  const body = { platform: "APP_STORE", productId: "ios.ultra", signedTransaction: "jws" };
  const first = await handle(post("/api/v1/billing/iap/verify", body, "99999999-9999-4999-8999-9999999999b1"), envOf(), { query, now: () => NOW, stores });
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { data: { plan: "ULTRA", periodEndsAt: "2026-11-21T00:00:00Z" } });
  const second = await handle(post("/api/v1/billing/iap/verify", body, "99999999-9999-4999-8999-9999999999b2"), envOf(), { query, now: () => NOW, stores });
  assert.equal(second.status, 200);
  assert.equal(ledger.filter((row) => row.reference === "tx-up").length, 1);
});

test("a store expiration drops the personal plan", async () => {
  resetLimits();
  const seen: Call[] = [];
  const query: Deps["query"] = async (sql, params = []) => {
    seen.push({ sql, params });
    if (sql.includes("rate_limits")) return { rows: [{ hits: 1 }], rowCount: 1 };
    if (sql.includes("SELECT user_id, status IN ('CONSUMED', 'REFUNDED') AS topup FROM iap_subscriptions")) return { rows: [{ user_id: USER, topup: false }], rowCount: 1 };
    if (sql.includes("SELECT original_transaction_id FROM iap_subscriptions WHERE user_id")) {
      return { rows: [{ original_transaction_id: "tx-1" }], rowCount: 1 };
    }
    if (sql.includes("UPDATE")) return { rows: [{ id: USER }], rowCount: 1 };
    return empty;
  };
  const stores: NonNullable<Deps["stores"]> = {
    ...noStores,
    decodeAppleNotification: async () => ({ notificationType: "EXPIRED", originalTransactionId: "tx-1", productId: "ios.pro", expiresAt: "2026-10-01T00:00:00.000Z" }),
  };
  const req = () => storeHook("/api/v1/billing/webhook/app-store", "signed");
  const first = await handle(req(), envOf(), { query, now: () => NOW, stores });
  assert.equal(first.status, 200);
  const update = seen.find((call) => call.sql.includes("UPDATE users"));
  assert.match(update?.sql ?? "", /plan = 'FREE'/);
  assert.match(update?.sql ?? "", /subscription_status = 'CANCELED'/);
  assert.equal(update?.params[0], USER);
  const second = await handle(req(), envOf(), { query, now: () => NOW, stores });
  assert.equal(second.status, 200);
});

test("a google pubsub renewal updates the plan once", async () => {
  resetLimits();
  const oidc = await rsaOidc("oidc-renew");
  const audience = "push-google-webhook";
  const ledger: LedgerRow[] = [];
  const capture = takeLedger(ledger);
  const seen: Call[] = [];
  const query: Deps["query"] = async (sql, params = []) => {
    seen.push({ sql, params });
    if (sql.includes("rate_limits")) return { rows: [{ hits: 1 }], rowCount: 1 };
    const taken = capture(sql, params);
    if (taken) return taken;
    if (sql.includes("SELECT original_transaction_id FROM iap_subscriptions WHERE user_id")) {
      return { rows: [{ original_transaction_id: "tx-renew" }], rowCount: 1 };
    }
    if (sql.includes("iap_subscriptions") && sql.toLowerCase().includes("select")) return { rows: [{ user_id: USER }], rowCount: 1 };
    if (sql.includes("UPDATE")) return { rows: [{ id: USER }], rowCount: 1 };
    return empty;
  };
  const note = {
    packageName: "app.push.mobile",
    subscriptionNotification: { notificationType: 2, purchaseToken: "tx-renew", subscriptionId: "ios.pro" },
  };
  const body = JSON.stringify({ message: { data: btoa(JSON.stringify(note)), messageId: "1" }, subscription: "projects/p/subscriptions/play" });
  const jwt = await oidc.sign({ iss: "https://accounts.google.com", aud: audience, exp: NOW.getTime() / 1000 + 600 });
  const env = envOf({ GOOGLE_OIDC_AUDIENCE: audience, GOOGLE_PLAY_PACKAGE: "app.push.mobile" });
  const certs = certsFetch([oidc.jwk]);
  const renewedAt = "2027-06-01T00:00:00.000Z";
  const playEnv = envOf({
    GOOGLE_OIDC_AUDIENCE: audience,
    GOOGLE_PLAY_PACKAGE: "app.push.mobile",
    GOOGLE_PLAY_KEY: JSON.stringify({ client_email: "svc@test", private_key: "unused" }),
  });
  const port = createStoreReceipts(playEnv, certs, NOW);
  const stores: NonNullable<Deps["stores"]> = {
    ...port,
    verifyGoogle: async (purchaseToken, productId, subscription) => {
      assert.equal(purchaseToken, "tx-renew");
      assert.equal(productId, "ios.pro");
      assert.equal(subscription, true);
      return { productId: "ios.pro", originalTransactionId: "tx-renew", expiresAt: renewedAt, consumable: false };
    },
  };
  const req = () => storeHook("/api/v1/billing/webhook/google-play", body, "Bearer " + jwt);
  const first = await handle(req(), playEnv, { query, now: () => NOW, fetch: certs, stores });
  assert.equal(first.status, 200);
  const second = await handle(req(), playEnv, { query, now: () => NOW, fetch: certs, stores });
  assert.equal(second.status, 200);
  assert.equal(ledger.filter((row) => row.reference === "tx-renew").length, 1);
  const update = seen.find((call) => call.sql.includes("UPDATE users") && call.params.includes("PRO"));
  assert.equal(update?.params[1], "PRO");
  assert.equal(update?.params[2], renewedAt);
  const iap = seen.find((call) => call.sql.includes("UPDATE iap_subscriptions") && call.params[0] === "tx-renew");
  assert.equal(iap?.params[2], renewedAt);
  const wrong = {
    packageName: "com.evil.app",
    subscriptionNotification: { notificationType: 2, purchaseToken: "tx-renew", subscriptionId: "ios.pro" },
  };
  const rejected = await handle(
    storeHook("/api/v1/billing/webhook/google-play", JSON.stringify({ message: { data: btoa(JSON.stringify(wrong)) } }), "Bearer " + jwt),
    env,
    { query, now: () => NOW, fetch: certs },
  );
  assert.equal(rejected.status, 400);
});

test("a stale store expiration does not downgrade a newer subscription", async () => {
  resetLimits();
  const seen: Call[] = [];
  const query: Deps["query"] = async (sql, params = []) => {
    seen.push({ sql, params });
    if (sql.includes("rate_limits")) return { rows: [{ hits: 1 }], rowCount: 1 };
    if (sql.includes("SELECT user_id, status IN ('CONSUMED', 'REFUNDED') AS topup FROM iap_subscriptions")) {
      return { rows: [{ user_id: USER, topup: false }], rowCount: 1 };
    }
    if (sql.includes("SELECT original_transaction_id FROM iap_subscriptions WHERE user_id")) {
      return { rows: [{ original_transaction_id: "tx-new" }], rowCount: 1 };
    }
    if (sql.includes("UPDATE")) return { rows: [{ id: USER }], rowCount: 1 };
    return empty;
  };
  const stores: NonNullable<Deps["stores"]> = {
    ...noStores,
    decodeAppleNotification: async () => ({
      notificationType: "EXPIRED",
      originalTransactionId: "tx-old",
      productId: "ios.pro",
      expiresAt: "2026-10-01T00:00:00.000Z",
    }),
  };
  const res = await handle(storeHook("/api/v1/billing/webhook/app-store", "signed"), envOf(), { query, now: () => NOW, stores });
  assert.equal(res.status, 200);
  assert.equal(seen.some((call) => call.sql.includes("UPDATE users") && call.sql.includes("plan = 'FREE'")), false);
});

test("a stale store renewal does not overwrite the current plan", async () => {
  resetLimits();
  const seen: Call[] = [];
  const ledger: LedgerRow[] = [];
  const capture = takeLedger(ledger);
  const query: Deps["query"] = async (sql, params = []) => {
    seen.push({ sql, params });
    if (sql.includes("rate_limits")) return { rows: [{ hits: 1 }], rowCount: 1 };
    const taken = capture(sql, params);
    if (taken) return taken;
    if (sql.includes("SELECT user_id FROM iap_subscriptions WHERE original_transaction_id")) {
      return { rows: [{ user_id: USER }], rowCount: 1 };
    }
    if (sql.includes("SELECT original_transaction_id FROM iap_subscriptions WHERE user_id")) {
      return { rows: [{ original_transaction_id: "tx-new" }], rowCount: 1 };
    }
    if (sql.includes("UPDATE")) return { rows: [{ id: USER }], rowCount: 1 };
    return empty;
  };
  const stores: NonNullable<Deps["stores"]> = {
    ...noStores,
    decodeAppleNotification: async () => ({
      notificationType: "DID_RENEW",
      originalTransactionId: "tx-old",
      productId: "ios.pro",
      expiresAt: "2026-11-21T00:00:00.000Z",
    }),
  };
  const res = await handle(storeHook("/api/v1/billing/webhook/app-store", "signed"), envOf(), { query, now: () => NOW, stores });
  assert.equal(res.status, 200);
  assert.equal(seen.some((call) => call.sql.includes("UPDATE users") && call.params[1] === "PRO"), false);
  assert.equal(ledger.filter((row) => row.reference === "tx-old").length, 0);
});

test("google oidc keys are cached until a new kid or the max-age", async () => {
  resetLimits();
  const firstKey = await rsaOidc("oidc-cache-a");
  const secondKey = await rsaOidc("oidc-cache-b");
  const audience = "push-google-webhook";
  let calls = 0;
  let keys: Record<string, unknown>[] = [firstKey.jwk];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    calls += 1;
    if (String(input) !== GOOGLE_CERTS) return new Response("no", { status: 500 });
    return new Response(JSON.stringify({ keys }), {
      status: 200,
      headers: { "cache-control": "public, max-age=60" },
    });
  }) as typeof fetch;
  const env = envOf({ GOOGLE_OIDC_AUDIENCE: audience });
  const postNote = (token: string, stamp: Date) => handle(
    storeHook("/api/v1/billing/webhook/google-play", JSON.stringify({ message: { data: btoa("{}") } }), "Bearer " + token),
    env,
    { query: rejectQuery(), now: () => stamp, fetch: fetchImpl },
  );
  const claims = (stamp: Date) => ({ iss: "https://accounts.google.com", aud: audience, exp: stamp.getTime() / 1000 + 600 });
  const tokenA = await firstKey.sign(claims(NOW));
  assert.equal((await postNote(tokenA, NOW)).status, 200);
  assert.equal((await postNote(tokenA, NOW)).status, 200);
  assert.equal(calls, 1);
  keys = [firstKey.jwk, secondKey.jwk];
  const tokenB = await secondKey.sign(claims(NOW));
  assert.equal((await postNote(tokenB, NOW)).status, 200);
  assert.equal(calls, 2);
  assert.equal((await postNote(tokenA, NOW)).status, 200);
  assert.equal(calls, 2);
  const later = new Date(NOW.getTime() + 61_000);
  assert.equal((await postNote(await firstKey.sign(claims(later)), later)).status, 200);
  assert.equal(calls, 3);
});

test("an expired google oidc bearer is rejected", async () => {
  resetLimits();
  const oidc = await rsaOidc("oidc-expired");
  const audience = "push-google-webhook";
  const env = envOf({ GOOGLE_OIDC_AUDIENCE: audience });
  const body = JSON.stringify({ message: { data: btoa(JSON.stringify({ subscriptionNotification: { notificationType: 2 } })) } });
  const hook = async (claims: Record<string, unknown>) => handle(
    storeHook("/api/v1/billing/webhook/google-play", body, "Bearer " + await oidc.sign({ iss: "https://accounts.google.com", aud: audience, ...claims })),
    env,
    { query: rejectQuery(), now: () => NOW, fetch: certsFetch([oidc.jwk]) },
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
    if (sql.startsWith("SELECT id FROM users")) return { rows: [{ id: USER }], rowCount: 1 };
    return empty;
  };
  const sub = { id: "sub_1", customer: "cus_1", status: "unpaid", items: { data: [{ price: { id: "price_pro" } }] } };
  const event = { id: "evt_3", type: "customer.subscription.updated", data: { object: { ...sub, status: "active" } } };
  const fetchSub = (async () => new Response(JSON.stringify(sub), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
  const res = await handle(await signedStripe(JSON.stringify(event)), envOf(), { query, now: () => NOW, fetch: fetchSub });
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

test("a refunded credit top-up keeps the plan; a refunded subscription still ends it", async () => {
  const chain = await appleChain();
  const env = envOf({ APPLE_ROOT_PEM: chain.rootPem, IAP_PRODUCT_PRO: "ios.pro", IAP_PRODUCT_TOPUP: "ios.topup" });
  const refund = async (id: string, productId: string) => {
    const inner = await jws({ originalTransactionId: id, productId, environment: "Production" }, chain.privateKey);
    return jws({ notificationType: "REFUND", data: { environment: "Production", signedTransactionInfo: inner } }, chain.privateKey, { x5c: chain.x5c });
  };
  for (const [id, productId, downgrades] of [["tx-topup", "ios.topup", false], ["tx-pro", "ios.pro", true]] as const) {
    resetLimits();
    const seen: Call[] = [];
    const query: Deps["query"] = async (sql, params = []) => {
      seen.push({ sql, params });
      if (sql.includes("rate_limits")) return { rows: [{ hits: 1 }], rowCount: 1 };
      if (sql.includes("SELECT user_id, status IN ('CONSUMED', 'REFUNDED') AS topup FROM iap_subscriptions")) {
        return { rows: [{ user_id: USER, topup: productId === "ios.topup" }], rowCount: 1 };
      }
      if (downgrades && sql.includes("SELECT original_transaction_id FROM iap_subscriptions WHERE user_id")) {
        return { rows: [{ original_transaction_id: id }], rowCount: 1 };
      }
      return empty;
    };
    const res = await handle(storeHook("/api/v1/billing/webhook/app-store", await refund(id, productId)), env, { query, now: () => NOW });
    assert.equal(res.status, 200);
    assert.ok(seen.some((call) => call.sql.includes("UPDATE iap_subscriptions SET status = CASE") && call.params[0] === id), id);
    assert.equal(seen.some((call) => call.sql.includes("UPDATE users SET plan = 'FREE'")), downgrades, id);
  }
});

test("google play: a voided one-time purchase is a refund; a canceled pending purchase and a voided subscription order are not", async () => {
  const oidc = await rsaOidc("oidc-voided");
  const audience = "push-google-webhook";
  const env = envOf({ GOOGLE_OIDC_AUDIENCE: audience, GOOGLE_PLAY_PACKAGE: "app.push.mobile", IAP_PRODUCT_TOPUP: "play.topup" });
  const jwt = await oidc.sign({ iss: "https://accounts.google.com", aud: audience, exp: NOW.getTime() / 1000 + 600 });
  const cases = [
    [{ voidedPurchaseNotification: { purchaseToken: "tok-void", orderId: "GPA.1", productType: 2, refundType: 1 } }, true],
    [{ oneTimeProductNotification: { version: "1.0", notificationType: 2, purchaseToken: "tok-void", sku: "play.topup" } }, false],
    [{ voidedPurchaseNotification: { purchaseToken: "tok-void", orderId: "GPA.2", productType: 1, refundType: 1 } }, false],
  ] as const;
  for (const [note, refunds] of cases) {
    resetLimits();
    const seen: Call[] = [];
    const query: Deps["query"] = async (sql, params = []) => {
      seen.push({ sql, params });
      if (sql.includes("rate_limits")) return { rows: [{ hits: 1 }], rowCount: 1 };
      if (sql.includes("FROM iap_subscriptions")) return { rows: [{ user_id: USER, topup: true }], rowCount: 1 };
      return empty;
    };
    const body = JSON.stringify({ message: { data: btoa(JSON.stringify({ packageName: "app.push.mobile", ...note })) } });
    const res = await handle(storeHook("/api/v1/billing/webhook/google-play", body, "Bearer " + jwt), env, { query, now: () => NOW, fetch: certsFetch([oidc.jwk]) });
    assert.equal(res.status, 200);
    const name = JSON.stringify(note);
    assert.equal(seen.some((call) => call.sql.includes("UPDATE iap_subscriptions") && call.params[0] === "tok-void"), refunds, name);
    assert.equal(seen.some((call) => call.sql.includes("INSERT INTO billing_ledger") && call.params.includes("REFUND")), refunds, name);
    assert.equal(seen.some((call) => call.sql.includes("plan = 'FREE'")), false, name);
  }
});
