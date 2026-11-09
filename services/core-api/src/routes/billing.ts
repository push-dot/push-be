import { DISPLAY_MICRO, carryInto, companyKey, ensureMonthlyGrant, grantMicro, grantPeriod, iapTopupMicro, keyLevel, periodKey, subscriptionLevel } from "../billing/credits.ts";
import { availableMicro, reservedMicro } from "../jobs/credits.ts";
import { createStoreReceipts, type StoreReceipts } from "../billing/stores.ts";
import { hmacSha256Hex } from "../crypto.ts";
import { isMissingRelation, one, query } from "../db.ts";
import { HttpError, data, pageBody } from "../http.ts";
import { pageOf, pageResult, ts } from "../page.ts";
import type { CoreEnv, Ctx } from "../types.ts";

const PLANS = new Set(["FREE", "PRO", "ULTRA"]);
const EMPLOYER_PLANS = new Set(["BASIC", "PRO", "ULTRA"]);
const TOLERANCE = 300;
const PACK_MICRO = 1500 * DISPLAY_MICRO;
const MAX_PACKS = 20;
const LIVE = new Set(["active", "trialing"]);
const CANCELLABLE = new Set(["active", "trialing", "past_due", "unpaid", "incomplete", "paused"]);
const ENDED = new Set(["canceled", "unpaid", "incomplete_expired"]);
const UUID = /^[0-9a-f-]{36}$/i;

async function readObject(request: Request): Promise<Record<string, unknown>> {
  const raw = await request.text();
  if (!raw) throw new HttpError(400, "VALIDATION_ERROR", "request body required");
  try {
    const body = JSON.parse(raw) as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("shape");
    return body as Record<string, unknown>;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, "VALIDATION_ERROR", "invalid request body");
  }
}

function configured(ctx: Ctx): boolean {
  return Boolean(ctx.env.STRIPE_SECRET_KEY);
}

const utcMonth = (now: Date): { monthStart: string; monthEnd: string } => {
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
  return { monthStart, monthEnd };
};

const monthlyMicro = (audience: "PERSONAL" | "EMPLOYER", plan: string | null): number => {
  const named = plan?.trim() ?? "";
  if (audience === "PERSONAL" && named === "") return grantMicro("PERSONAL", "FREE");
  return grantMicro(audience, named);
};

const EMPLOYER_SPEND = "SELECT COALESCE(SUM(ai_usage.cost_micro_credits), 0) AS spent FROM ai_usage WHERE status = 'SETTLED' AND created_at >= $1 AND created_at < $2 AND user_id IN (SELECT user_id FROM company_members WHERE company_id = $3)";
const PERSONAL_SPEND = "SELECT COALESCE(SUM(ai_usage.cost_micro_credits), 0) AS spent FROM ai_usage WHERE status = 'SETTLED' AND created_at >= $1 AND created_at < $2 AND user_id = $3";

const spentInMonth = async (ctx: Ctx, sql: string, params: unknown[]): Promise<number> => {
  try {
    const row = await one(ctx.deps.query, sql, params);
    return Number(row?.spent ?? 0);
  } catch (err) {
    if (isMissingRelation(err)) return 0;
    throw err;
  }
};

const employerPlanOf = (value: unknown): "BASIC" | "PRO" | "ULTRA" | null => {
  const plan = value == null ? "" : String(value);
  if (plan === "BASIC" || plan === "PRO" || plan === "ULTRA") return plan;
  return null;
};

const userLedger = async (ctx: Ctx, userId: string, amount: number, referenceId: string): Promise<void> => {
  await query(ctx.deps.query,
    "INSERT INTO billing_ledger (id, user_id, type, amount_micro_credits, balance_after, reference_id, created_at) SELECT $1, $2, 'PURCHASE', $3, COALESCE((SELECT balance_after FROM billing_ledger WHERE user_id = $2 ORDER BY created_at DESC, id DESC LIMIT 1), 0) + $3, $4, $5 ON CONFLICT (user_id, type, reference_id) DO NOTHING",
    [crypto.randomUUID(), userId, amount, referenceId, ctx.now.toISOString()]);
};

type Payment = { description: string | null; amountUsdCents: number | null; receiptUrl: string | null };

const companyLedger = async (ctx: Ctx, companyId: string, amount: number, referenceId: string, payment: Payment): Promise<void> => {
  await query(ctx.deps.query,
    "INSERT INTO billing_ledger (id, user_id, company_id, type, amount_micro_credits, balance_after, reference_id, created_at, description, amount_usd_cents, receipt_url) SELECT $1, NULL, $2, 'PURCHASE', $3::bigint, (SELECT COALESCE(SUM(amount_micro_credits), 0)::bigint FROM billing_ledger WHERE company_id = $2 AND user_id IS NULL) + $3::bigint, $4, $5, $6::text, $7::integer, $8::text ON CONFLICT (company_id, type, reference_id) WHERE company_id IS NOT NULL DO NOTHING",
    [crypto.randomUUID(), companyId, amount, referenceId, ctx.now.toISOString(), payment.description, payment.amountUsdCents, payment.receiptUrl]);
};

const PLAN_LABEL = { BASIC: "Basic", PRO: "Pro", ULTRA: "Ultra" } as const;
const planDescription = (plan: "BASIC" | "PRO" | "ULTRA"): string => PLAN_LABEL[plan] + " 월 구독";
const TOPUP_DESCRIPTION = "크레딧 구매";
const REFUND_DESCRIPTION = "요금제 변경 환급";

// Operator-only: the dispatcher alerts (Discord, else email) while a billing_alerts row is open.
const raiseAlert = async (ctx: Ctx, companyId: string, kind: "CANCEL_FAILED" | "NOT_ADOPTED" | "NOT_GRANTED", referenceId: string, detail: string): Promise<void> => {
  console.error(JSON.stringify({ billingAlert: kind, companyId, referenceId, detail }));
  await query(ctx.deps.query,
    "INSERT INTO billing_alerts (id, company_id, kind, reference_id, detail, created_at) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (kind, reference_id) DO UPDATE SET detail = EXCLUDED.detail, resolved_at = NULL",
    [crypto.randomUUID(), companyId, kind, referenceId, detail, ctx.now.toISOString()]);
};

const resolveCancelAlert = (ctx: Ctx, subscriptionId: string): Promise<unknown> => query(ctx.deps.query,
  "UPDATE billing_alerts SET resolved_at = $2 WHERE kind = 'CANCEL_FAILED' AND reference_id = $1 AND resolved_at IS NULL",
  [subscriptionId, ctx.now.toISOString()]);

// Allowlist, never echo the Origin header: success_url must not carry an attacker-chosen origin.
const returnOrigin = (ctx: Ctx): string => {
  const allowed = (ctx.env.STRIPE_RETURN_ORIGINS ?? "").split(",").map((item) => item.trim().replace(/\/+$/, "")).filter((item) => {
    try {
      const url = new URL(item);
      return (url.protocol === "https:" || url.protocol === "http:") && url.origin === item;
    } catch {
      return false;
    }
  });
  const origin = ctx.request.headers.get("origin") ?? "";
  if (allowed.includes(origin)) return origin;
  if (!allowed[0]) throw new HttpError(503, "NOT_CONFIGURED", "billing return origin is not configured");
  return allowed[0];
};

const returnUrls = (ctx: Ctx, success: "success" | "credits"): Record<string, string> => {
  const plans = returnOrigin(ctx) + "/employer/plans?checkout=";
  return { success_url: plans + success + "&session_id={CHECKOUT_SESSION_ID}", cancel_url: plans + "canceled" };
};

const grantMonthly = async (ctx: Ctx, audience: "PERSONAL" | "EMPLOYER", plan: string | null, ownerId: string): Promise<void> => {
  if (!plan) return;
  await ensureMonthlyGrant(ctx.deps.query, { audience, plan, ownerId, now: ctx.now });
};

export async function billingStatus(ctx: Ctx): Promise<Response> {
  if (ctx.user.accountType === "EMPLOYER") {
    if (!ctx.user.companyId) throw new HttpError(404, "NOT_FOUND", "resource not found");
    const company = await one(ctx.deps.query, "SELECT plan FROM companies WHERE id = $1", [ctx.user.companyId]);
    if (!company) throw new HttpError(404, "NOT_FOUND", "resource not found");
    const plan = employerPlanOf(company.plan);
    await grantMonthly(ctx, "EMPLOYER", plan, ctx.user.companyId);
    const { monthStart, monthEnd } = utcMonth(ctx.now);
    const [spentMicroCredits, available, reserved] = await Promise.all([
      spentInMonth(ctx, EMPLOYER_SPEND, [monthStart, monthEnd, ctx.user.companyId]),
      availableMicro(ctx.deps.query, ctx.user.id, ctx.user.companyId),
      reservedMicro(ctx.deps.query, ctx.user.id, ctx.user.companyId),
    ]);
    return data(200, {
      subscriptionStatus: plan ? "ACTIVE" : "NONE",
      plan,
      periodEndsAt: null,
      balanceMicroCredits: Number(available),
      reservedMicroCredits: Number(reserved),
      monthlyMicroCredits: monthlyMicro("EMPLOYER", plan),
      spentMicroCredits,
      audience: "EMPLOYER",
      source: plan ? "STRIPE" : null,
    }, ctx.rid);
  }
  const plan = ctx.user.plan || null;
  await grantMonthly(ctx, "PERSONAL", plan, ctx.user.id);
  const { monthStart, monthEnd } = utcMonth(ctx.now);
  const [spentMicroCredits, available, reserved, iap] = await Promise.all([
    spentInMonth(ctx, PERSONAL_SPEND, [monthStart, monthEnd, ctx.user.id]),
    availableMicro(ctx.deps.query, ctx.user.id),
    reservedMicro(ctx.deps.query, ctx.user.id),
    one(ctx.deps.query, "SELECT platform FROM iap_subscriptions WHERE user_id = $1 AND status = 'ACTIVE' LIMIT 1", [ctx.user.id]),
  ]);
  const platform = iap?.platform == null ? "" : String(iap.platform);
  const source = platform === "APP_STORE" || platform === "GOOGLE_PLAY"
    ? platform
    : ctx.user.subscriptionStatus === "ACTIVE" ? "STRIPE" : null;
  return data(200, {
    subscriptionStatus: ctx.user.subscriptionStatus || "NONE",
    plan,
    periodEndsAt: ts(ctx.user.periodEndsAt),
    balanceMicroCredits: Number(available),
    reservedMicroCredits: Number(reserved),
    monthlyMicroCredits: monthlyMicro("PERSONAL", plan),
    spentMicroCredits,
    audience: "PERSONAL",
    source,
  }, ctx.rid);
}

async function stripe(ctx: Ctx, method: string, path: string, form?: URLSearchParams): Promise<Record<string, unknown>> {
  const fetchImpl = ctx.deps.fetch ?? fetch;
  const secret = ctx.env.STRIPE_SECRET_KEY || "";
  const res = await fetchImpl("https://api.stripe.com" + path, {
    method,
    headers: {
      authorization: "Basic " + btoa(secret + ":"),
      "content-type": "application/x-www-form-urlencoded",
    },
    body: form,
  });
  const body = await res.json() as Record<string, unknown>;
  if (!res.ok) throw new Error("stripe");
  return body;
}

const subscriptionsOf = (list: Record<string, unknown>): Record<string, unknown>[] =>
  Array.isArray(list.data) ? list.data as Record<string, unknown>[] : [];

const employerPrice = (env: CoreEnv, planId: string): string => {
  if (planId === "BASIC") return env.STRIPE_PRICE_EMPLOYER_BASIC || "";
  if (planId === "PRO") return env.STRIPE_PRICE_EMPLOYER_PRO || "";
  return env.STRIPE_PRICE_EMPLOYER_ULTRA || "";
};

const checkoutSession = async (ctx: Ctx, form: URLSearchParams): Promise<Response> => {
  try {
    const session = await stripe(ctx, "POST", "/v1/checkout/sessions", form);
    if (typeof session.url !== "string" || !session.url) throw new Error("url");
    return data(200, {
      url: session.url,
      expiresAt: session.expires_at ? ts(new Date(Number(session.expires_at) * 1000)) : null,
    }, ctx.rid);
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(502, "PROVIDER_ERROR", "stripe checkout session failed");
  }
};

export async function checkout(ctx: Ctx): Promise<Response> {
  if (!configured(ctx)) throw new HttpError(503, "NOT_CONFIGURED", "billing is not configured");
  const body = await readObject(ctx.request);
  if (typeof body.planId !== "string") throw new HttpError(400, "VALIDATION_ERROR", "invalid request body");
  if (ctx.user.accountType !== "EMPLOYER") throw new HttpError(403, "FORBIDDEN", "admin required");
  if (!ctx.user.companyId) throw new HttpError(404, "NOT_FOUND", "resource not found");
  if (ctx.user.companyRole !== "ADMIN") throw new HttpError(403, "FORBIDDEN", "admin required");
  if (!EMPLOYER_PLANS.has(body.planId)) throw new HttpError(400, "VALIDATION_ERROR", "unsupported plan", { field: "planId" });
  const price = employerPrice(ctx.env, body.planId);
  if (!price) throw new HttpError(503, "NOT_CONFIGURED", "plan price is not configured");
  const company = await one(ctx.deps.query, "SELECT stripe_customer_id FROM companies WHERE id = $1", [ctx.user.companyId]);
  if (!company) throw new HttpError(404, "NOT_FOUND", "resource not found");
  const form = new URLSearchParams({
    mode: "subscription",
    "line_items[0][price]": price,
    "line_items[0][quantity]": "1",
    ...returnUrls(ctx, "success"),
    client_reference_id: ctx.user.companyId,
    "metadata[audience]": "EMPLOYER",
    "metadata[plan]": body.planId,
  });
  const customer = company.stripe_customer_id == null ? "" : String(company.stripe_customer_id);
  if (customer) form.set("customer", customer);
  return checkoutSession(ctx, form);
}

/** Cancels every live subscription now (no refund). Called before an account is marked for deletion. */
export async function cancelSubscriptions(ctx: Ctx, customerId?: string): Promise<void> {
  const customer = customerId ?? ctx.user.stripeCustomerId;
  if (!configured(ctx) || !customer) return;
  try {
    // Without a status filter Stripe lists every subscription that is not already canceled.
    const list = await stripe(ctx, "GET", "/v1/subscriptions?limit=100&customer=" + encodeURIComponent(customer));
    for (const sub of subscriptionsOf(list)) {
      if (CANCELLABLE.has(String(sub.status))) await stripe(ctx, "DELETE", "/v1/subscriptions/" + encodeURIComponent(String(sub.id)));
    }
  } catch {
    throw new HttpError(502, "PROVIDER_ERROR", "stripe subscription cancel failed");
  }
}

export async function portal(ctx: Ctx): Promise<Response> {
  if (!configured(ctx)) throw new HttpError(503, "NOT_CONFIGURED", "billing is not configured");
  if (!ctx.user.stripeCustomerId) throw new HttpError(409, "INVALID_TRANSITION", "no billing account");
  try {
    const form = new URLSearchParams({
      customer: ctx.user.stripeCustomerId,
      return_url: ctx.env.STRIPE_PORTAL_RETURN_URL || "",
    });
    const session = await stripe(ctx, "POST", "/v1/billing_portal/sessions", form);
    if (typeof session.url !== "string" || !session.url) throw new Error("url");
    return data(200, { url: session.url }, ctx.rid);
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(502, "PROVIDER_ERROR", "stripe portal session failed");
  }
}

export async function ledger(ctx: Ctx): Promise<Response> {
  const employer = ctx.user.accountType === "EMPLOYER";
  if (employer && !ctx.user.companyId) throw new HttpError(404, "NOT_FOUND", "resource not found");
  const page = pageOf(ctx.url);
  const params: unknown[] = [employer ? ctx.user.companyId : ctx.user.id];
  let sql = "SELECT id, type, amount_micro_credits, balance_after, reference_id, created_at, description, amount_usd_cents, receipt_url FROM billing_ledger WHERE "
    + (employer ? "company_id = $1 AND user_id IS NULL" : "user_id = $1");
  if (page.cursor) {
    params.push(page.cursor.createdAt, page.cursor.id);
    sql += ` AND (created_at, id) < ($${params.length - 1}, $${params.length})`;
  }
  params.push(page.limit + 1);
  sql += ` ORDER BY created_at DESC, id DESC LIMIT $${params.length}`;
  const rows = await query(ctx.deps.query, sql, params);
  const mapped = rows.rows.map((row) => ({
    item: {
      id: String(row.id),
      type: String(row.type),
      amountMicroCredits: Number(row.amount_micro_credits),
      balanceAfter: Number(row.balance_after),
      referenceId: row.reference_id == null ? null : String(row.reference_id),
      createdAt: ts(row.created_at),
      description: row.description == null ? null : String(row.description),
      amountUsd: row.amount_usd_cents == null ? null : Number(row.amount_usd_cents) / 100,
      receiptUrl: row.receipt_url == null ? null : String(row.receipt_url),
    },
    createdAt: row.created_at,
    id: String(row.id),
  }));
  const paged = pageResult(mapped, page.limit, (row) => ({ createdAt: row.createdAt, id: row.id }));
  return pageBody(paged.items.map((row) => row.item), paged.nextCursor, paged.hasMore, ctx.rid);
}

export async function verifyStripe(payload: Uint8Array, header: string, secret: string, now: Date): Promise<void> {
  let stamp = 0;
  const sigs: string[] = [];
  for (const part of header.split(",")) {
    const kv = part.trim().split("=");
    if (kv.length < 2) continue;
    if (kv[0] === "t") stamp = Number(kv[1]);
    else if (kv[0] === "v1") sigs.push(kv.slice(1).join("="));
  }
  if (!stamp || sigs.length === 0) throw new Error("missing signature");
  if (Math.abs(Math.floor(now.getTime() / 1000) - stamp) > TOLERANCE) throw new Error("stale timestamp");
  const prefix = new TextEncoder().encode(`${stamp}.`);
  const signed = new Uint8Array(prefix.length + payload.length);
  signed.set(prefix);
  signed.set(payload, prefix.length);
  const expected = await hmacSha256Hex(secret, signed);
  const ok = sigs.some((sig) => {
    if (sig.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
    return diff === 0;
  });
  if (!ok) throw new Error("signature mismatch");
}

export async function webhook(ctx: Ctx): Promise<Response> {
  const raw = new Uint8Array(await ctx.request.arrayBuffer());
  if (raw.length === 0) throw new HttpError(400, "VALIDATION_ERROR", "unreadable body");
  if (!configured(ctx) || !ctx.env.STRIPE_WEBHOOK_SECRET) {
    throw new HttpError(503, "NOT_CONFIGURED", "billing is not configured");
  }
  try {
    await verifyStripe(raw, ctx.request.headers.get("stripe-signature") || "", ctx.env.STRIPE_WEBHOOK_SECRET, ctx.now);
  } catch {
    throw new HttpError(400, "VALIDATION_ERROR", "invalid webhook signature");
  }
  let event: Record<string, unknown> = {};
  try { event = JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>; } catch { event = {}; }
  if (!event.id) throw new HttpError(400, "VALIDATION_ERROR", "invalid webhook payload");
  const fresh = await one(ctx.deps.query,
    "INSERT INTO stripe_events (event_id, type, processed_at) VALUES ($1,$2,$3) ON CONFLICT (event_id) DO NOTHING RETURNING event_id",
    [String(event.id), String(event.type || ""), ctx.now.toISOString()]);
  if (!fresh) return data(200, { received: true }, ctx.rid);
  const obj = ((event.data as { object?: Record<string, unknown> } | undefined)?.object) || {};
  try {
    if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
      await checkoutCompleted(ctx, obj);
    }
    else if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
      await subscriptionChanged(ctx, String(event.type), obj);
    }
    else if (event.type === "invoice.paid") await invoicePaid(ctx, obj);
  } catch (err) {
    await query(ctx.deps.query, "DELETE FROM stripe_events WHERE event_id = $1", [String(event.id)]);
    throw err;
  }
  return data(200, { received: true }, ctx.rid);
}

const metaOf = (obj: Record<string, unknown>): Record<string, unknown> => {
  const meta = obj.metadata;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return {};
  return meta as Record<string, unknown>;
};

const positiveInt = (value: unknown): number | null => {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return null;
  return parsed;
};

const httpsUrl = (value: unknown): string | null => typeof value === "string" && value.startsWith("https://") ? value : null;

// The receipt link is display data: a Stripe read failure must not block the credit grant.
const receiptOf = async (ctx: Ctx, path: string, pick: (body: Record<string, unknown>) => unknown): Promise<string | null> => {
  try {
    return httpsUrl(pick(await stripe(ctx, "GET", path)));
  } catch {
    return null;
  }
};

const invoiceReceipt = (ctx: Ctx, invoice: unknown): Promise<string | null> => typeof invoice === "string" && invoice
  ? receiptOf(ctx, "/v1/invoices/" + encodeURIComponent(invoice), (body) => body.hosted_invoice_url)
  : Promise.resolve(null);

const chargeReceipt = (ctx: Ctx, intent: unknown): Promise<string | null> => typeof intent === "string" && intent
  ? receiptOf(ctx, "/v1/payment_intents/" + encodeURIComponent(intent) + "?expand[]=latest_charge",
    (body) => (body.latest_charge as { receipt_url?: unknown } | null | undefined)?.receipt_url)
  : Promise.resolve(null);

const usdCents = (obj: Record<string, unknown>, cents: number | null): number | null => {
  if (cents == null || obj.currency === "usd") return cents;
  console.error(`billing: ${String(obj.id)} paid in ${String(obj.currency)}, amount not stored`);
  return null;
};

type Item = { price?: { id?: string }; current_period_start?: number; current_period_end?: number };
const itemOf = (sub: Record<string, unknown>): Item | undefined => (sub.items as { data?: Item[] } | undefined)?.data?.[0];
const priceOf = (sub: Record<string, unknown>): string => itemOf(sub)?.price?.id || "";

// Subscriptions are ordered by (created, id), so two created in the same second still have one survivor.
const olderThan = (sub: Record<string, unknown>, keep: { id: string; created: number }): boolean =>
  Number(sub.created) < keep.created || (Number(sub.created) === keep.created && String(sub.id) < keep.id);

// A plan change is a new Checkout subscription; end every older one so the company never pays twice. Newer ones wait for their own checkout event.
// Unused time is refunded only while the replaced period's plan credits stay within the kept plan: after a downgrade the higher credits are already out.
async function cancelReplaced(ctx: Ctx, companyId: string, customers: string[], keep: { id: string; created: number; plan: "BASIC" | "PRO" | "ULTRA" }): Promise<void> {
  for (const customer of customers) {
    const list = await stripe(ctx, "GET", "/v1/subscriptions?limit=100&customer=" + encodeURIComponent(customer));
    for (const sub of subscriptionsOf(list)) {
      if (sub.id === keep.id || !CANCELLABLE.has(String(sub.status)) || !olderThan(sub, keep)) continue;
      const id = String(sub.id);
      const refund = await subscriptionLevel(ctx.deps.query, companyId, id, ctx.now) <= grantMicro("EMPLOYER", keep.plan);
      try {
        await stripe(ctx, "DELETE", "/v1/subscriptions/" + encodeURIComponent(id) + (refund ? "?prorate=true&invoice_now=true" : ""));
      } catch (err) {
        await raiseAlert(ctx, companyId, "CANCEL_FAILED", id, `replaced subscription still billing, kept ${keep.id}`);
        throw err;
      }
      await resolveCancelAlert(ctx, id);
    }
  }
}

// Acts on a live subscription of the paid plan only, and never moves the company to an older one than it has,
// so a late or replayed checkout can neither point the company at an ended subscription nor cancel the live one.
async function adoptSubscription(ctx: Ctx, companyId: string, planId: "BASIC" | "PRO" | "ULTRA", customer: string, subscriptionId: string): Promise<void> {
  if (!customer || !subscriptionId) return;
  const sub = await stripe(ctx, "GET", "/v1/subscriptions/" + encodeURIComponent(subscriptionId));
  if (!LIVE.has(String(sub.status)) || priceOf(sub) !== employerPrice(ctx.env, planId) || sub.customer !== customer) {
    console.error(`billing: company ${companyId} checkout subscription ${subscriptionId} not adopted (${String(sub.status)})`);
    if (LIVE.has(String(sub.status))) {
      await raiseAlert(ctx, companyId, "NOT_ADOPTED", subscriptionId, `paid ${planId}, subscription price ${priceOf(sub)} customer ${String(sub.customer)}`);
    }
    return;
  }
  const q = ctx.deps.query;
  const start = new Date(Number(itemOf(sub)?.current_period_start ?? sub.created) * 1000);
  const before = await one(q, "SELECT stripe_customer_id, stripe_subscription_id, extract(epoch FROM stripe_subscription_created_at)::bigint AS created_unix, extract(epoch FROM credit_period_start)::bigint AS period_unix FROM companies WHERE id = $1", [companyId]);
  const current = String(before?.stripe_subscription_id ?? "");
  const switching = current !== subscriptionId && !(current && olderThan(sub, { id: current, created: Number(before?.created_unix) }));
  const previousKey = companyKey(before, ctx.now);
  // An upgrade or same-plan swap keeps the tiers the replaced period granted; a downgrade starts the lower plan fresh.
  const carry = async (): Promise<number> => {
    const level = await keyLevel(q, companyId, previousKey);
    return switching && level <= grantMicro("EMPLOYER", planId) ? level : 0;
  };
  // Written before the switch so a retry after a crash still finds them.
  if (switching) await carryInto(q, { companyId, key: periodKey(subscriptionId, start), level: await carry(), now: ctx.now });
  await query(q,
    "UPDATE companies SET plan = $2, stripe_customer_id = $3, stripe_subscription_id = $4, stripe_subscription_created_at = $5::timestamptz, credit_period_start = CASE WHEN stripe_subscription_id IS DISTINCT FROM $4 THEN $6::timestamptz ELSE credit_period_start END WHERE id = $1 AND (stripe_subscription_created_at IS NULL OR stripe_subscription_created_at < $5::timestamptz OR (stripe_subscription_created_at = $5::timestamptz AND stripe_subscription_id COLLATE \"C\" <= $4))",
    [companyId, planId, customer, subscriptionId, new Date(Number(sub.created) * 1000).toISOString(), start.toISOString()]);
  const kept = await one(q, "SELECT plan, stripe_subscription_id, extract(epoch FROM stripe_subscription_created_at)::bigint AS created_unix, extract(epoch FROM credit_period_start)::bigint AS period_unix FROM companies WHERE id = $1", [companyId]);
  const keepPlan = employerPlanOf(kept?.plan);
  const keepId = String(kept?.stripe_subscription_id ?? "");
  if (!keepPlan || !keepId) return;
  if (keepId === subscriptionId && kept?.period_unix != null) {
    await grantPeriod(q, { companyId, subscriptionId, periodStart: new Date(Number(kept.period_unix) * 1000), plan: planId, carry: await carry(), now: ctx.now });
  }
  const previous = before?.stripe_customer_id == null ? "" : String(before.stripe_customer_id);
  const customers = previous && previous !== customer ? [customer, previous] : [customer];
  await cancelReplaced(ctx, companyId, customers, { id: keepId, created: Number(kept?.created_unix), plan: keepPlan });
}

const planLine = (env: CoreEnv, obj: Record<string, unknown>): { plan: "BASIC" | "PRO" | "ULTRA"; start: number | null } | null => {
  type Line = { amount?: number; price?: { id?: string } | null; pricing?: { price_details?: { price?: string } }; period?: { start?: number } };
  const lines = ((obj.lines as { data?: Line[] } | undefined)?.data) || [];
  for (const line of lines) {
    if (!(Number(line.amount) > 0)) continue;
    const plan = employerPlanByPrice(env, line.price?.id || line.pricing?.price_details?.price || "");
    if (plan) return { plan, start: positiveInt(line.period?.start) };
  }
  return null;
};

// A paid renewal of the company's current subscription opens its next credit period; past_due never reaches here.
// The total, not amount_paid, is the charge: a renewal paid from the Stripe balance has amount_paid 0.
// The first invoice is the checkout row. A replaced subscription's final invoice is negative and becomes Stripe balance.
async function invoicePaid(ctx: Ctx, obj: Record<string, unknown>): Promise<void> {
  if (obj.billing_reason !== "subscription_cycle") return;
  const total = Number(obj.total);
  const customer = String(obj.customer || "");
  if (!Number.isSafeInteger(total) || !customer || !obj.id) return;
  const company = await one(ctx.deps.query, "SELECT id, plan, stripe_subscription_id FROM companies WHERE stripe_customer_id = $1", [customer]);
  if (!company) return;
  const companyId = String(company.id);
  const line = planLine(ctx.env, obj);
  const plan = line?.plan ?? employerPlanOf(company.plan);
  await companyLedger(ctx, companyId, 0, String(obj.id), {
    description: total < 0 ? REFUND_DESCRIPTION : plan ? planDescription(plan) : null,
    amountUsdCents: usdCents(obj, total),
    receiptUrl: httpsUrl(obj.hosted_invoice_url),
  });
  const subscriptionId = String((obj.parent as { subscription_details?: { subscription?: unknown } } | null | undefined)?.subscription_details?.subscription ?? "");
  if (total < 0 || !subscriptionId || subscriptionId !== String(company.stripe_subscription_id ?? "")) return;
  if (!line?.start) {
    await raiseAlert(ctx, companyId, "NOT_GRANTED", String(obj.id), `paid renewal of ${subscriptionId} has no employer plan line`);
    return;
  }
  const periodStart = new Date(line.start * 1000);
  await query(ctx.deps.query,
    "UPDATE companies SET credit_period_start = $2::timestamptz WHERE id = $1 AND stripe_subscription_id = $3 AND (credit_period_start IS NULL OR credit_period_start < $2::timestamptz)",
    [companyId, periodStart.toISOString(), subscriptionId]);
  await grantPeriod(ctx.deps.query, { companyId, subscriptionId, periodStart, plan: line.plan, carry: 0, now: ctx.now });
}

async function checkoutCompleted(ctx: Ctx, obj: Record<string, unknown>): Promise<void> {
  if (obj.payment_status === "unpaid") return;
  const meta = metaOf(obj);
  if (meta.amountMicroCredits != null && String(meta.amountMicroCredits) !== "") {
    const micro = positiveInt(meta.amountMicroCredits);
    if (micro == null) throw new HttpError(400, "VALIDATION_ERROR", "unsupported plan");
    const ownerId = String(meta.ownerId || obj.client_reference_id || "");
    if (!UUID.test(ownerId)) throw new HttpError(400, "VALIDATION_ERROR", "invalid session reference");
    const reference = String(obj.id || "");
    if (String(meta.audience || "") === "EMPLOYER") {
      await companyLedger(ctx, ownerId, micro, reference, {
        description: TOPUP_DESCRIPTION,
        amountUsdCents: usdCents(obj, positiveInt(obj.amount_total)),
        receiptUrl: await chargeReceipt(ctx, obj.payment_intent),
      });
    }
    else await userLedger(ctx, ownerId, micro, reference);
    return;
  }
  if (String(meta.audience || "") === "EMPLOYER") {
    const companyId = String(meta.ownerId || obj.client_reference_id || "");
    if (!UUID.test(companyId)) throw new HttpError(400, "VALIDATION_ERROR", "invalid session reference");
    const planId = employerPlanOf(meta.plan || meta.planId);
    if (!planId) throw new HttpError(400, "VALIDATION_ERROR", "unsupported plan");
    await companyLedger(ctx, companyId, 0, String(obj.id || ""), {
      description: planDescription(planId),
      amountUsdCents: usdCents(obj, positiveInt(obj.amount_total)),
      receiptUrl: await invoiceReceipt(ctx, obj.invoice),
    });
    await adoptSubscription(ctx, companyId, planId, String(obj.customer || ""), String(obj.subscription || ""));
    return;
  }
  const userId = String(obj.client_reference_id || "");
  if (!UUID.test(userId)) throw new HttpError(400, "VALIDATION_ERROR", "invalid session reference");
  const planId = String(meta.planId || "");
  if (!PLANS.has(planId) || planId === "FREE") throw new HttpError(400, "VALIDATION_ERROR", "unsupported plan");
  const credits = grantMicro("PERSONAL", planId);
  const id = crypto.randomUUID();
  await query(ctx.deps.query,
    "WITH locked AS (SELECT id FROM users WHERE id = $1 FOR UPDATE), updated AS (UPDATE users SET plan = $2, subscription_status = 'ACTIVE', stripe_customer_id = COALESCE(NULLIF($3, ''), stripe_customer_id) WHERE id IN (SELECT id FROM locked) RETURNING id), bal AS (SELECT COALESCE((SELECT balance_after FROM billing_ledger WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1), 0) AS b) INSERT INTO billing_ledger (id, user_id, type, amount_micro_credits, balance_after, reference_id, created_at) SELECT $4, updated.id, 'PURCHASE', $5, bal.b + $5, $6, $7 FROM updated, bal ON CONFLICT (user_id, type, reference_id) DO NOTHING",
    [userId, planId, String(obj.customer || ""), id, credits, String(obj.id || ""), ctx.now.toISOString()]);
}

async function subscriptionChanged(ctx: Ctx, type: string, obj: Record<string, unknown>): Promise<void> {
  const customer = String(obj.customer || "");
  if (!customer) throw new HttpError(400, "VALIDATION_ERROR", "invalid subscription payload");
  const canceled = type === "customer.subscription.deleted" || ENDED.has(String(obj.status ?? ""));
  const priceId = priceOf(obj);
  const current = "stripe_customer_id = $1 AND (stripe_subscription_id IS NULL OR stripe_subscription_id = $2)";
  const company = await one(ctx.deps.query,
    canceled
      ? `UPDATE companies SET plan = NULL WHERE ${current} RETURNING id`
      : `UPDATE companies SET plan = COALESCE($3, plan) WHERE ${current} RETURNING id`,
    canceled ? [customer, String(obj.id || "")] : [customer, String(obj.id || ""), priceId ? employerPlanByPrice(ctx.env, priceId) : null]);
  if (canceled) await resolveCancelAlert(ctx, String(obj.id || ""));
  if (company) return;
  const replaced = await one(ctx.deps.query, "SELECT id FROM companies WHERE stripe_customer_id = $1", [customer]);
  if (replaced) return;
  const end = itemOf(obj)?.current_period_end;
  const period = end ? new Date(Number(end) * 1000).toISOString() : null;
  const status = canceled ? "CANCELED" : "ACTIVE";
  const plan = canceled ? "FREE" : priceId ? personalPlanByPrice(ctx.env, priceId) : null;
  const updated = await one(ctx.deps.query,
    "UPDATE users SET subscription_status = $2, period_ends_at = COALESCE($3::timestamptz, period_ends_at), plan = COALESCE($4, plan) WHERE stripe_customer_id = $1 RETURNING id",
    [customer, status, period, plan]);
  if (!updated) throw new HttpError(500, "INTERNAL", "internal error");
}

const employerPlanByPrice = (env: CoreEnv, priceId: string): "BASIC" | "PRO" | "ULTRA" | null => {
  if (priceId === env.STRIPE_PRICE_EMPLOYER_BASIC) return "BASIC";
  if (priceId === env.STRIPE_PRICE_EMPLOYER_PRO) return "PRO";
  if (priceId === env.STRIPE_PRICE_EMPLOYER_ULTRA) return "ULTRA";
  return null;
};

const personalPlanByPrice = (env: CoreEnv, priceId: string): "PRO" | "ULTRA" | null => {
  if (priceId === env.STRIPE_PRICE_PRO) return "PRO";
  if (priceId === env.STRIPE_PRICE_ULTRA) return "ULTRA";
  return null;
};

const productKind = (env: CoreEnv, productId: string): "PRO" | "ULTRA" | "TOPUP" | "UNKNOWN" | "MISSING" => {
  if (!env.IAP_PRODUCT_PRO && !env.IAP_PRODUCT_ULTRA && !env.IAP_PRODUCT_TOPUP) return "MISSING";
  if (env.IAP_PRODUCT_PRO && productId === env.IAP_PRODUCT_PRO) return "PRO";
  if (env.IAP_PRODUCT_ULTRA && productId === env.IAP_PRODUCT_ULTRA) return "ULTRA";
  if (env.IAP_PRODUCT_TOPUP && productId === env.IAP_PRODUCT_TOPUP) return "TOPUP";
  return "UNKNOWN";
};

const storePort = (ctx: Ctx): StoreReceipts => ctx.deps.stores ?? createStoreReceipts(ctx.env, ctx.deps.fetch ?? fetch, ctx.now);

// A store transaction belongs to the first account that verifies it; replaying it from another account is refused.
const CLAIM_PURCHASE = "INSERT INTO iap_subscriptions (id, user_id, platform, original_transaction_id, product_id, expires_at, status, sandbox) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (original_transaction_id) DO UPDATE SET product_id = EXCLUDED.product_id, expires_at = EXCLUDED.expires_at, status = EXCLUDED.status, platform = EXCLUDED.platform, sandbox = EXCLUDED.sandbox WHERE iap_subscriptions.user_id = EXCLUDED.user_id RETURNING user_id";

const claimPurchase = async (
  ctx: Ctx,
  platform: "APP_STORE" | "GOOGLE_PLAY",
  receipt: { productId: string; originalTransactionId: string; expiresAt: string | null; sandbox?: boolean },
  status: "ACTIVE" | "CONSUMED",
): Promise<void> => {
  const row = await one(ctx.deps.query, CLAIM_PURCHASE,
    [crypto.randomUUID(), ctx.user.id, platform, receipt.originalTransactionId, receipt.productId, receipt.expiresAt, status, receipt.sandbox === true]);
  if (!row) throw new HttpError(409, "CONFLICT", "purchase belongs to another account");
};

const requireKind = (env: CoreEnv, productId: string): "PRO" | "ULTRA" | "TOPUP" => {
  const kind = productKind(env, productId);
  if (kind === "MISSING") throw new HttpError(503, "NOT_CONFIGURED", "iap products are not configured");
  if (kind === "UNKNOWN") throw new HttpError(400, "VALIDATION_ERROR", "unknown product", { field: "productId" });
  return kind;
};

export const topup = async (ctx: Ctx): Promise<Response> => {
  if (!configured(ctx)) throw new HttpError(503, "NOT_CONFIGURED", "billing is not configured");
  const body = await readObject(ctx.request);
  const packs = body.packs;
  if (typeof packs !== "number" || !Number.isSafeInteger(packs) || packs < 1 || packs > MAX_PACKS) {
    throw new HttpError(400, "VALIDATION_ERROR", "must be an integer from 1 to " + MAX_PACKS, { field: "packs" });
  }
  if (ctx.user.accountType !== "EMPLOYER") throw new HttpError(403, "FORBIDDEN", "admin required");
  if (!ctx.user.companyId) throw new HttpError(404, "NOT_FOUND", "resource not found");
  if (ctx.user.companyRole !== "ADMIN") throw new HttpError(403, "FORBIDDEN", "admin required");
  const price = ctx.env.STRIPE_PRICE_TOPUP;
  if (!price) throw new HttpError(503, "NOT_CONFIGURED", "plan price is not configured");
  const company = await one(ctx.deps.query, "SELECT stripe_customer_id FROM companies WHERE id = $1", [ctx.user.companyId]);
  if (!company) throw new HttpError(404, "NOT_FOUND", "resource not found");
  const customer = company.stripe_customer_id == null ? null : String(company.stripe_customer_id);
  const ownerId = ctx.user.companyId;
  try {
    const form = new URLSearchParams({
      mode: "payment",
      "line_items[0][price]": price,
      "line_items[0][quantity]": String(packs),
      ...returnUrls(ctx, "credits"),
      client_reference_id: ownerId,
      "metadata[amountMicroCredits]": String(packs * PACK_MICRO),
      "metadata[audience]": "EMPLOYER",
      "metadata[ownerId]": ownerId,
    });
    if (customer) form.set("customer", customer);
    const session = await stripe(ctx, "POST", "/v1/checkout/sessions", form);
    if (typeof session.url !== "string" || !session.url) throw new Error("url");
    return data(200, { url: session.url }, ctx.rid);
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(502, "PROVIDER_ERROR", "stripe checkout session failed");
  }
};

export const verifyIap = async (ctx: Ctx): Promise<Response> => {
  const body = await readObject(ctx.request);
  const platform = body.platform;
  if (platform !== "APP_STORE" && platform !== "GOOGLE_PLAY") {
    throw new HttpError(400, "VALIDATION_ERROR", "invalid request body", { field: "platform" });
  }
  if (typeof body.productId !== "string" || !body.productId) {
    throw new HttpError(400, "VALIDATION_ERROR", "invalid request body", { field: "productId" });
  }
  const kind = requireKind(ctx.env, body.productId);
  if (kind !== "TOPUP" && ctx.user.subscriptionStatus === "ACTIVE" && ctx.user.stripeCustomerId) {
    throw new HttpError(409, "ALREADY_SUBSCRIBED", "already subscribed");
  }
  if (platform === "APP_STORE" && (typeof body.signedTransaction !== "string" || !body.signedTransaction)) {
    throw new HttpError(400, "VALIDATION_ERROR", "invalid request body", { field: "signedTransaction" });
  }
  if (platform === "GOOGLE_PLAY" && (typeof body.purchaseToken !== "string" || !body.purchaseToken)) {
    throw new HttpError(400, "VALIDATION_ERROR", "invalid request body", { field: "purchaseToken" });
  }
  const stores = storePort(ctx);
  const receipt = platform === "APP_STORE"
    ? await stores.verifyApple(String(body.signedTransaction))
    : await stores.verifyGoogle(String(body.purchaseToken), body.productId, kind !== "TOPUP");
  if (requireKind(ctx.env, receipt.productId) !== kind) {
    throw new HttpError(400, "VALIDATION_ERROR", "unknown product", { field: "productId" });
  }
  if (kind !== "TOPUP" && receipt.expiresAt != null && Date.parse(receipt.expiresAt) <= ctx.now.getTime()) {
    throw new HttpError(400, "VALIDATION_ERROR", "purchase is not valid");
  }
  await claimPurchase(ctx, platform, receipt, kind === "TOPUP" ? "CONSUMED" : "ACTIVE");
  if (kind === "TOPUP") {
    await userLedger(ctx, ctx.user.id, iapTopupMicro(ctx.env.IAP_TOPUP_CREDITS), receipt.originalTransactionId);
    return data(200, { plan: ctx.user.plan || null, periodEndsAt: ts(ctx.user.periodEndsAt) }, ctx.rid);
  }
  await query(ctx.deps.query,
    "UPDATE users SET plan = $2, subscription_status = 'ACTIVE', period_ends_at = COALESCE($3::timestamptz, period_ends_at) WHERE id = $1",
    [ctx.user.id, kind, receipt.expiresAt]);
  await userLedger(ctx, ctx.user.id, grantMicro("PERSONAL", kind), receipt.originalTransactionId);
  return data(200, { plan: kind, periodEndsAt: ts(receipt.expiresAt) }, ctx.rid);
};

const grantNote = async (
  ctx: Ctx,
  notificationType: string,
  transactionId: string,
  productId: string,
  expiresAt: string | null,
  sandbox = false,
): Promise<void> => {
  const upper = notificationType.toUpperCase();
  if (upper === "REFUND" || upper === "EXPIRED" || upper === "REVOKE" || upper === "GRACE_PERIOD_EXPIRED") {
    const row = await one(ctx.deps.query,
      "SELECT user_id FROM iap_subscriptions WHERE original_transaction_id = $1",
      [transactionId]);
    await query(ctx.deps.query,
      "UPDATE iap_subscriptions SET status = 'CANCELED', expires_at = COALESCE($2::timestamptz, expires_at), sandbox = $3 WHERE original_transaction_id = $1",
      [transactionId, expiresAt, sandbox]);
    if (!row?.user_id) return;
    await query(ctx.deps.query,
      "UPDATE users SET plan = 'FREE', subscription_status = 'CANCELED', period_ends_at = COALESCE($2::timestamptz, period_ends_at) WHERE id = $1",
      [String(row.user_id), expiresAt]);
    return;
  }
  const grants = upper === "PURCHASE" || upper === "RENEWAL" || upper === "SUBSCRIBED" || upper === "DID_RENEW";
  if (!grants || !transactionId) return;
  const kind = requireKind(ctx.env, productId);
  const row = await one(ctx.deps.query,
    "SELECT user_id FROM iap_subscriptions WHERE original_transaction_id = $1",
    [transactionId]);
  if (!row) return;
  const userId = String(row.user_id);
  if (kind === "TOPUP") {
    await userLedger(ctx, userId, iapTopupMicro(ctx.env.IAP_TOPUP_CREDITS), transactionId);
    return;
  }
  await query(ctx.deps.query,
    "UPDATE iap_subscriptions SET status = 'ACTIVE', product_id = $2, expires_at = COALESCE($3::timestamptz, expires_at), sandbox = $4 WHERE original_transaction_id = $1",
    [transactionId, productId, expiresAt, sandbox]);
  await query(ctx.deps.query,
    "UPDATE users SET plan = $2, subscription_status = 'ACTIVE', period_ends_at = COALESCE($3::timestamptz, period_ends_at) WHERE id = $1",
    [userId, kind, expiresAt]);
  await userLedger(ctx, userId, grantMicro("PERSONAL", kind), transactionId);
};

export const appleWebhook = async (ctx: Ctx): Promise<Response> => {
  const raw = await ctx.request.text();
  if (!raw) throw new HttpError(400, "VALIDATION_ERROR", "unreadable body");
  const note = await storePort(ctx).decodeAppleNotification(raw);
  await grantNote(ctx, note.notificationType, note.originalTransactionId, note.productId, note.expiresAt, note.sandbox === true);
  return data(200, { received: true }, ctx.rid);
};

export const googleWebhook = async (ctx: Ctx): Promise<Response> => {
  const raw = await ctx.request.text();
  if (!raw) throw new HttpError(400, "VALIDATION_ERROR", "unreadable body");
  let body: unknown;
  try {
    body = JSON.parse(raw) as unknown;
  } catch {
    throw new HttpError(400, "VALIDATION_ERROR", "invalid request body");
  }
  const note = await storePort(ctx).decodeGoogleNotification(body, ctx.request.headers.get("authorization"));
  await grantNote(ctx, note.notificationType, note.purchaseToken, note.productId, note.expiresAt);
  return data(200, { received: true }, ctx.rid);
};
