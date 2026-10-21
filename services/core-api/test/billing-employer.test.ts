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

const b64url = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes))
  .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

const text64 = (value: string): string => b64url(new TextEncoder().encode(value));

const jws = async (payload: unknown, privateKey: CryptoKey): Promise<string> => {
  const header = text64(JSON.stringify({ alg: "ES256" }));
  const body = text64(JSON.stringify(payload));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, new TextEncoder().encode(`${header}.${body}`)));
  return `${header}.${body}.${b64url(sig)}`;
};

const p256 = async () => {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
  const pem = `-----BEGIN PUBLIC KEY-----\n${btoa(String.fromCharCode(...spki))}\n-----END PUBLIC KEY-----`;
  const token = await jws({ notificationType: "DID_RENEW", originalTransactionId: "tx-1", productId: "ios.pro" }, pair.privateKey);
  const parts = token.split(".");
  const packed = parts[2]!.replaceAll("-", "+").replaceAll("_", "/");
  const sig = Uint8Array.from(atob(packed + "=".repeat((4 - (packed.length % 4)) % 4)), (char) => char.charCodeAt(0));
  sig[0] ^= 255;
  return { pem, token, bad: `${parts[0]}.${parts[1]}.${b64url(sig)}`, privateKey: pair.privateKey };
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

test("an unverified store webhook is rejected", async () => {
  resetLimits();
  const key = await p256();
  const query: Deps["query"] = async (sql) => {
    if (sql.includes("rate_limits")) return { rows: [{ hits: 1 }], rowCount: 1 };
    if (sql.includes("INSERT INTO billing_ledger")) throw new Error("ledger");
    return empty;
  };
  const forged = await handle(
    new Request("https://core.example/api/v1/billing/webhook/app-store", { method: "POST", body: key.bad }),
    envOf({ APPLE_IAP_KEY: key.pem }),
    { query, now: () => NOW },
  );
  assert.equal(forged.status, 400);
  assert.equal((await codeOf(forged)).message, "invalid webhook signature");
  const unsigned = await handle(
    new Request("https://core.example/api/v1/billing/webhook/google-play", {
      method: "POST",
      body: JSON.stringify({ message: { data: btoa(JSON.stringify({ subscriptionNotification: { notificationType: 2 } })) } }),
    }),
    envOf({ GOOGLE_PLAY_KEY: key.pem }),
    { query, now: () => NOW },
  );
  assert.equal(unsigned.status, 400);
  assert.equal((await codeOf(unsigned)).message, "invalid webhook signature");
  const nested = await handle(
    new Request("https://core.example/api/v1/billing/webhook/app-store", {
      method: "POST",
      body: await jws({ notificationType: "DID_RENEW", data: { signedTransactionInfo: key.bad } }, key.privateKey),
    }),
    envOf({ APPLE_IAP_KEY: key.pem }),
    { query, now: () => NOW },
  );
  assert.equal(nested.status, 400);
  assert.equal((await codeOf(nested)).message, "invalid webhook signature");
  const accepted = await handle(
    new Request("https://core.example/api/v1/billing/webhook/app-store", { method: "POST", body: key.token }),
    envOf({ APPLE_IAP_KEY: key.pem }),
    { query, now: () => NOW },
  );
  assert.equal(accepted.status, 200);
  const rawKey = await handle(
    new Request("https://core.example/api/v1/billing/webhook/app-store", { method: "POST", body: key.token }),
    envOf({ APPLE_IAP_KEY: "sk_live_not_a_public_key" }),
    { query, now: () => NOW },
  );
  assert.equal(rawKey.status, 503);
  assert.equal((await codeOf(rawKey)).code, "NOT_CONFIGURED");
});
