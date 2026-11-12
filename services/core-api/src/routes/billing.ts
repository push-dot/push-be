import { DISPLAY_MICRO, boundTransaction, ensureMonthlyGrant, grantMicro, grantPeriod, iapTopupMicro, keyLevel, lockOwner, monthGranted, monthKey, periodKey, subscriptionLevel } from "../billing/credits.ts";
import { availableMicro, reservedMicro } from "../jobs/credits.ts";
import { createStoreReceipts, googlePlayPubsub, type StoreReceipts } from "../billing/stores.ts";
import { hmacSha256Hex } from "../crypto.ts";
import { isLockTimeout, isMissingRelation, one, query, type Transaction } from "../db.ts";
import { HttpError, data, pageBody } from "../http.ts";
import { pageOf, pageResult, ts } from "../page.ts";
import type { CoreEnv, Ctx } from "../types.ts";
import { readObject } from "./recruiting-shared.ts";

const PLANS = new Set(["FREE", "PRO", "ULTRA"]);
const EMPLOYER_PLANS = new Set(["BASIC", "PRO", "ULTRA"]);
const TOLERANCE = 300;
const PACK_MICRO = 1500 * DISPLAY_MICRO;
const MAX_PACKS = 20;
const LIVE = new Set(["active", "trialing"]);
const CANCELLABLE = new Set(["active", "trialing", "past_due", "unpaid", "incomplete", "paused"]);
const ENDED = new Set(["canceled", "unpaid", "incomplete_expired"]);
// Written on the cancel that refunds a replaced subscription's unused time, so the successor carries that period's credits.
const REFUNDED = "push: replaced, unused time refunded";
const UUID = /^[0-9a-f-]{36}$/i;

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

// Usage written off (WRITE_OFF rows) was never charged, so the month's spend leaves it out.
// A write-off booked in the month after its usage would turn that month negative; spend is display only, so floor it at 0.
const EMPLOYER_SPEND = "SELECT GREATEST(COALESCE((SELECT SUM(ai_usage.cost_micro_credits) FROM ai_usage WHERE status = 'SETTLED' AND created_at >= $1 AND created_at < $2 AND user_id IN (SELECT user_id FROM company_members WHERE company_id = $3)), 0) - COALESCE((SELECT SUM(amount_micro_credits) FROM billing_ledger WHERE company_id = $3 AND type = 'WRITE_OFF' AND created_at >= $1 AND created_at < $2), 0), 0) AS spent";
const PERSONAL_SPEND = "SELECT GREATEST(COALESCE((SELECT SUM(ai_usage.cost_micro_credits) FROM ai_usage WHERE status = 'SETTLED' AND created_at >= $1 AND created_at < $2 AND user_id = $3), 0) - COALESCE((SELECT SUM(amount_micro_credits) FROM billing_ledger WHERE user_id = $3 AND type = 'WRITE_OFF' AND created_at >= $1 AND created_at < $2), 0), 0) AS spent";

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

const userLedger = async (ctx: Ctx, userId: string, amount: number, referenceId: string, type = "PURCHASE"): Promise<void> => {
  await query(ctx.deps.query,
    "INSERT INTO billing_ledger (id, user_id, type, amount_micro_credits, balance_after, reference_id, created_at) SELECT $1, $2, $6::text, $3, COALESCE((SELECT balance_after FROM billing_ledger WHERE user_id = $2 ORDER BY seq DESC LIMIT 1), 0) + $3, $4, $5 ON CONFLICT (user_id, type, reference_id) DO NOTHING",
    [crypto.randomUUID(), userId, amount, referenceId, ctx.now.toISOString(), type]);
};

type Payment = { description: string | null; amountUsdCents: number | null; receiptUrl: string | null };

const companyLedger = async (ctx: Ctx, companyId: string, amount: number, referenceId: string, payment: Payment, type = "PURCHASE"): Promise<void> => {
  await query(ctx.deps.query,
    "INSERT INTO billing_ledger (id, user_id, company_id, type, amount_micro_credits, balance_after, reference_id, created_at, description, amount_usd_cents, receipt_url) SELECT $1, NULL, $2, $9::text, $3::bigint, (SELECT COALESCE(SUM(amount_micro_credits), 0)::bigint FROM billing_ledger WHERE company_id = $2 AND user_id IS NULL) + $3::bigint, $4, $5, $6::text, $7::integer, $8::text ON CONFLICT (company_id, type, reference_id) WHERE company_id IS NOT NULL DO NOTHING",
    [crypto.randomUUID(), companyId, amount, referenceId, ctx.now.toISOString(), payment.description, payment.amountUsdCents, payment.receiptUrl, type]);
};

const PLAN_LABEL = { BASIC: "Basic", PRO: "Pro", ULTRA: "Ultra" } as const;
const planDescription = (plan: "BASIC" | "PRO" | "ULTRA"): string => PLAN_LABEL[plan] + " 월 구독";
const TOPUP_DESCRIPTION = "크레딧 구매";
const TOPUP_REFUND_DESCRIPTION = "크레딧 구매 환불";

// A refunded top-up takes its credits back, at most what is still unspent, so the balance stops at 0 (D18).
// The REFUND row's reference is the purchase's, so a repeated refund notice writes nothing.
const takeBack = async (ctx: Ctx, owner: { userId: string } | { companyId: string }, micro: number, referenceId: string): Promise<void> => {
  const companyId = "companyId" in owner ? owner.companyId : undefined;
  const left = await availableMicro(ctx.deps.query, "userId" in owner ? owner.userId : "", companyId);
  let deduct: bigint;
  if (left <= 0n) deduct = 0n;
  else if (left < BigInt(micro)) deduct = left;
  else deduct = BigInt(micro);
  const amount = -Number(deduct);
  if (companyId) {
    await companyLedger(ctx, companyId, amount, referenceId, { description: TOPUP_REFUND_DESCRIPTION, amountUsdCents: null, receiptUrl: null }, "REFUND");
  }
  else await userLedger(ctx, (owner as { userId: string }).userId, amount, referenceId, "REFUND");
};
const REFUND_DESCRIPTION = "요금제 변경 환급";

type Alert = { companyId: string; kind: "CANCEL_FAILED" | "NOT_ADOPTED" | "NOT_GRANTED" | "REFUND_SKIPPED"; referenceId: string; detail: string };
// A webhook's transaction ctx carries `alerts`: what it raised is raised again outside the transaction if that rolls back.
type AlertCtx = Ctx & { alerts?: Alert[] };

// Operator-only: the dispatcher alerts (Discord, else email) while a billing_alerts row is open.
const raiseAlert = async (ctx: AlertCtx, companyId: string, kind: Alert["kind"], referenceId: string, detail: string): Promise<void> => {
  console.error(JSON.stringify({ billingAlert: kind, companyId, referenceId, detail }));
  ctx.alerts?.push({ companyId, kind, referenceId, detail });
  await query(ctx.deps.query,
    "INSERT INTO billing_alerts (id, company_id, kind, reference_id, detail, created_at) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (kind, reference_id) DO UPDATE SET detail = EXCLUDED.detail, resolved_at = NULL",
    [crypto.randomUUID(), companyId, kind, referenceId, detail, ctx.now.toISOString()]);
};

// Thrown to fail a webhook with an alert that must outlive the rolled-back transaction.
class AlertingError extends Error {
  readonly alert: Alert;
  constructor(alert: Alert) {
    super(alert.detail);
    this.alert = alert;
  }
}

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

// Most reads find the month already granted and skip the owner lock, so they never wait on a webhook.
const grantMonthly = async (ctx: Ctx, audience: "PERSONAL" | "EMPLOYER", plan: string | null, ownerId: string): Promise<void> => {
  if (!plan || await monthGranted(ctx.deps.query, { audience, plan, ownerId, now: ctx.now })) return;
  try {
    await inTransactionOf(ctx)(async (q) => {
      await boundTransaction(q, "3s");
      await lockOwner(q, audience, ownerId);
      await ensureMonthlyGrant(q, { audience, plan, ownerId, now: ctx.now });
    });
  } catch (err) {
    // A webhook holds the owner row: show the balance now, the month's grant lands on the next read or enqueue.
    if (!isLockTimeout(err)) throw err;
  }
};

// In-memory test fakes have no transactions.
const inTransactionOf = (ctx: Ctx): Transaction => ctx.deps.transaction ?? ((work) => work(ctx.deps.query));

// Same switch as the payment gate in handler.ts: apps hide buy buttons while it is off, since a store charges before verify.
const paymentsEnabled = (ctx: Ctx): boolean => ctx.env.PAYMENTS_ENABLED === "1";

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
      paymentsEnabled: paymentsEnabled(ctx),
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
    paymentsEnabled: paymentsEnabled(ctx),
  }, ctx.rid);
}

// A webhook calls Stripe while it holds the company row lock, so a hung call must fail the event (Stripe retries it) rather than hold the lock.
const STRIPE_TIMEOUT_MS = 10_000;

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
    signal: AbortSignal.timeout(STRIPE_TIMEOUT_MS),
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
  // Commit order (seq), as balance_after runs: a row that waited for the owner lock can carry an earlier created_at.
  // The cursor keeps its (createdAt, id) shape; only its id is used.
  if (page.cursor) {
    params.push(page.cursor.id);
    sql += ` AND seq < (SELECT seq FROM billing_ledger WHERE id = $${params.length})`;
  }
  params.push(page.limit + 1);
  sql += ` ORDER BY seq DESC LIMIT $${params.length}`;
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
  const obj = ((event.data as { object?: Record<string, unknown> } | undefined)?.object) || {};
  // One transaction per event: each handler locks the company (or user) row first, so the billing changes of one owner run one
  // at a time and a failure rolls back the event row with the rest.
  const alerts: Alert[] = [];
  try {
    await inTransactionOf(ctx)(async (q) => {
      // A timeout fails the event and Stripe retries it.
      await boundTransaction(q, "15s");
      const tx: AlertCtx = { ...ctx, deps: { ...ctx.deps, query: q }, alerts };
      const fresh = await one(q,
        "INSERT INTO stripe_events (event_id, type, processed_at) VALUES ($1,$2,$3) ON CONFLICT (event_id) DO NOTHING RETURNING event_id",
        [String(event.id), String(event.type || ""), ctx.now.toISOString()]);
      if (!fresh) return;
      if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
        await checkoutCompleted(tx, obj);
      }
      else if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
        await subscriptionChanged(tx, String(event.type), obj);
      }
      else if (event.type === "invoice.paid") await invoicePaid(tx, obj);
      else if (event.type === "charge.refunded") await chargeRefunded(tx, obj);
    });
  } catch (err) {
    await query(ctx.deps.query, "DELETE FROM stripe_events WHERE event_id = $1", [String(event.id)]);
    // A retry may not raise them again: a replaced subscription canceled before the failure is no longer listed.
    for (const alert of err instanceof AlertingError ? [...alerts, err.alert] : alerts) {
      await raiseAlert(ctx, alert.companyId, alert.kind, alert.referenceId, alert.detail);
    }
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

// The expanded latest invoice is paid and bills the period the subscription is in now.
const currentPeriodPaid = (env: CoreEnv, sub: Record<string, unknown>): boolean => {
  const invoice = sub.latest_invoice;
  if (!invoice || typeof invoice !== "object" || (invoice as Record<string, unknown>).status !== "paid") return false;
  const start = planLine(env, invoice as Record<string, unknown>)?.start;
  return start != null && start === positiveInt(itemOf(sub)?.current_period_start);
};

// A plan change is a new Checkout subscription; end every older one so the company never pays twice. Newer ones wait for their own checkout event.
// Unused time is refunded only while the replaced period's plan credits stay within the kept plan: after a downgrade the higher credits are already out.
// Only a period whose invoice is paid is refunded: Stripe would credit unused time of an unpaid one. That rules out past_due and unpaid, and
// also an active subscription that just renewed: Stripe keeps the renewal invoice a draft for about an hour before it charges it.
// Any other cancel voids the open invoices first, so a late payment cannot land on a subscription the company left. Stripe itself turns off
// auto_advance on the open and draft invoices of a canceled subscription, so the draft is never finalized or charged.
// `calendar` is the company's subscription from before credit periods, whose credits are the month's.
async function cancelReplaced(ctx: Ctx, companyId: string, customers: string[], keep: { id: string; created: number; plan: "BASIC" | "PRO" | "ULTRA" }, calendar: string): Promise<void> {
  for (const customer of customers) {
    const list = await stripe(ctx, "GET", "/v1/subscriptions?limit=100&expand[]=data.latest_invoice&customer=" + encodeURIComponent(customer));
    for (const sub of subscriptionsOf(list)) {
      if (sub.id === keep.id || !CANCELLABLE.has(String(sub.status)) || !olderThan(sub, keep)) continue;
      const id = String(sub.id);
      const refundable = LIVE.has(String(sub.status))
        && await subscriptionLevel(ctx.deps.query, companyId, id, ctx.now, id === calendar) <= grantMicro("EMPLOYER", keep.plan);
      const refund = refundable && currentPeriodPaid(ctx.env, sub);
      // Fail closed: with no readable invoice the period may be paid, so an operator checks it and refunds by hand.
      const unread = refundable && (sub.latest_invoice == null || typeof sub.latest_invoice !== "object");
      const path = "/v1/subscriptions/" + encodeURIComponent(id);
      try {
        if (refund) {
          await stripe(ctx, "DELETE", path + "?" + new URLSearchParams({ prorate: "true", invoice_now: "true", "cancellation_details[comment]": REFUNDED }));
        } else {
          const open = await stripe(ctx, "GET", "/v1/invoices?status=open&limit=100&subscription=" + encodeURIComponent(id));
          for (const invoice of subscriptionsOf(open)) await stripe(ctx, "POST", "/v1/invoices/" + encodeURIComponent(String(invoice.id)) + "/void");
          await stripe(ctx, "DELETE", path);
        }
      } catch {
        throw new AlertingError({ companyId, kind: "CANCEL_FAILED", referenceId: id, detail: `replaced subscription still billing, kept ${keep.id}` });
      }
      await resolveCancelAlert(ctx, id);
      if (unread) await raiseAlert(ctx, companyId, "REFUND_SKIPPED", id, `latest_invoice unreadable (${typeof sub.latest_invoice}), canceled without refund, kept ${keep.id}`);
    }
  }
}

// The period whose unused time a replacing checkout refunded, read back from Stripe so a retry after a crash finds it too.
async function refundedStart(ctx: Ctx, subscriptionId: string): Promise<number | null> {
  const sub = await stripe(ctx, "GET", "/v1/subscriptions/" + encodeURIComponent(subscriptionId));
  const details = sub.cancellation_details as { comment?: unknown } | null | undefined;
  return sub.status === "canceled" && details?.comment === REFUNDED ? positiveInt(itemOf(sub)?.current_period_start) : null;
}

// Acts on a live subscription of the paid plan only, and never moves the company to an older one than it has,
// so a late or replayed checkout can neither point the company at an ended subscription nor cancel the live one.
async function adoptSubscription(ctx: Ctx, companyId: string, planId: "BASIC" | "PRO" | "ULTRA", customer: string, subscriptionId: string): Promise<void> {
  if (!customer || !subscriptionId) return;
  const q = ctx.deps.query;
  const before = await one(q, "SELECT plan, stripe_customer_id, stripe_subscription_id, extract(epoch FROM stripe_subscription_created_at)::bigint AS created_unix, extract(epoch FROM credit_period_start)::bigint AS period_unix FROM companies WHERE id = $1 FOR NO KEY UPDATE", [companyId]);
  if (!before) return;
  const sub = await stripe(ctx, "GET", "/v1/subscriptions/" + encodeURIComponent(subscriptionId));
  if (!LIVE.has(String(sub.status)) || priceOf(sub) !== employerPrice(ctx.env, planId) || sub.customer !== customer) {
    console.error(`billing: company ${companyId} checkout subscription ${subscriptionId} not adopted (${String(sub.status)})`);
    if (LIVE.has(String(sub.status))) {
      await raiseAlert(ctx, companyId, "NOT_ADOPTED", subscriptionId, `paid ${planId}, subscription price ${priceOf(sub)} customer ${String(sub.customer)}`);
    }
    return;
  }
  const start = new Date(Number(itemOf(sub)?.current_period_start ?? sub.created) * 1000);
  const current = String(before.stripe_subscription_id ?? "");
  const switching = current !== subscriptionId && !(current && olderThan(sub, { id: current, created: Number(before.created_unix) }));
  const keepPlan = switching ? planId : employerPlanOf(before.plan);
  const keep = switching ? { id: subscriptionId, created: Number(sub.created) } : { id: current, created: Number(before.created_unix) };
  if (switching) {
    await query(q,
      "UPDATE companies SET plan = $2, stripe_customer_id = $3, stripe_subscription_id = $4, stripe_subscription_created_at = $5::timestamptz, credit_period_start = $6::timestamptz WHERE id = $1",
      [companyId, planId, customer, subscriptionId, new Date(Number(sub.created) * 1000).toISOString(), start.toISOString()]);
  }
  const previous = before.stripe_customer_id == null ? "" : String(before.stripe_customer_id);
  if (keepPlan && keep.id) await cancelReplaced(ctx, companyId, previous && previous !== customer ? [customer, previous] : [customer], { ...keep, plan: keepPlan }, before.period_unix == null ? current : "");
  if (!switching) return;
  // An upgrade or same-plan swap keeps the tiers of the period whose unused time was just refunded; a downgrade, or a replaced
  // subscription that was not refunded, starts the new plan fresh. A company on calendar months carries the month its period starts in.
  const refunded = before.period_unix == null ? null : current ? await refundedStart(ctx, current) : null;
  const from = before.period_unix == null ? monthKey(start) : refunded ? periodKey(current, new Date(refunded * 1000)) : null;
  const level = from ? await keyLevel(q, companyId, from) : 0;
  await grantPeriod(q, { companyId, subscriptionId, periodStart: start, plan: planId, carry: level <= grantMicro("EMPLOYER", planId) ? level : 0, now: ctx.now });
}

const planLine = (env: CoreEnv, obj: Record<string, unknown>): { plan: "BASIC" | "PRO" | "ULTRA"; start: number | null } | null => {
  type Line = {
    amount?: number; price?: { id?: string } | null; pricing?: { price_details?: { price?: string } }; period?: { start?: number };
    parent?: { subscription_item_details?: { proration?: boolean } | null } | null;
  };
  const lines = ((obj.lines as { data?: Line[] } | undefined)?.data) || [];
  for (const line of lines) {
    // A proration line starts mid-period, so it never names the period the renewal opens.
    if (!(Number(line.amount) > 0) || line.parent?.subscription_item_details?.proration) continue;
    const plan = employerPlanByPrice(env, line.price?.id || line.pricing?.price_details?.price || "");
    if (plan) return { plan, start: positiveInt(line.period?.start) };
  }
  return null;
};

// A paid cycle invoice grants its period, whatever order it arrives in: also one paid late after a newer period, and one of a
// subscription the company has since left, unless that period is the one the replacing checkout refunded (its credits carried).
// The total, not amount_paid, is the charge: a renewal paid from the Stripe balance has amount_paid 0.
// The first invoice is the checkout row. A replaced subscription's final invoice is negative and becomes Stripe balance.
async function invoicePaid(ctx: Ctx, obj: Record<string, unknown>): Promise<void> {
  if (obj.billing_reason !== "subscription_cycle") return;
  const total = Number(obj.total);
  const customer = String(obj.customer || "");
  if (!Number.isSafeInteger(total) || !customer || !obj.id) return;
  const company = await one(ctx.deps.query, "SELECT id, plan, stripe_subscription_id FROM companies WHERE stripe_customer_id = $1 FOR NO KEY UPDATE", [customer]);
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
  const current = subscriptionId === String(company.stripe_subscription_id ?? "");
  if (total < 0 || !subscriptionId || (!current && total === 0)) return;
  if (!line?.start) {
    await raiseAlert(ctx, companyId, "NOT_GRANTED", String(obj.id), `paid renewal of ${subscriptionId} has no employer plan line`);
    return;
  }
  if (!current && await refundedStart(ctx, subscriptionId) === line.start) return;
  const periodStart = new Date(line.start * 1000);
  await query(ctx.deps.query,
    "UPDATE companies SET credit_period_start = $2::timestamptz WHERE id = $1 AND stripe_subscription_id = $3 AND (credit_period_start IS NULL OR credit_period_start < $2::timestamptz)",
    [companyId, periodStart.toISOString(), subscriptionId]);
  await grantPeriod(ctx.deps.query, { companyId, subscriptionId, periodStart, plan: line.plan, carry: 0, now: ctx.now });
}

// A fully refunded top-up checkout takes its credits back. Subscription refunds keep their credits (the replaced-period refund
// in checkout carries them). shortcut: a partial refund changes nothing; the operator adjusts by hand until partial refunds are offered.
async function chargeRefunded(ctx: Ctx, obj: Record<string, unknown>): Promise<void> {
  if (obj.refunded !== true || typeof obj.payment_intent !== "string" || !obj.payment_intent) return;
  const list = await stripe(ctx, "GET", "/v1/checkout/sessions?payment_intent=" + encodeURIComponent(obj.payment_intent));
  const session = (Array.isArray(list.data) ? list.data[0] : null) as Record<string, unknown> | null;
  const meta = session ? metaOf(session) : {};
  const micro = positiveInt(meta.amountMicroCredits);
  if (!session || micro == null) return;
  const ownerId = String(meta.ownerId || session.client_reference_id || "");
  if (!UUID.test(ownerId)) throw new HttpError(400, "VALIDATION_ERROR", "invalid session reference");
  if (String(meta.audience || "") === "EMPLOYER") {
    await lockOwner(ctx.deps.query, "EMPLOYER", ownerId);
    await takeBack(ctx, { companyId: ownerId }, micro, String(session.id));
  }
  else {
    await lockOwner(ctx.deps.query, "PERSONAL", ownerId);
    await takeBack(ctx, { userId: ownerId }, micro, String(session.id));
  }
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
      await lockOwner(ctx.deps.query, "EMPLOYER", ownerId);
      await companyLedger(ctx, ownerId, micro, reference, {
        description: TOPUP_DESCRIPTION,
        amountUsdCents: usdCents(obj, positiveInt(obj.amount_total)),
        receiptUrl: await chargeReceipt(ctx, obj.payment_intent),
      });
    }
    else {
      await lockOwner(ctx.deps.query, "PERSONAL", ownerId);
      await userLedger(ctx, ownerId, micro, reference);
    }
    return;
  }
  if (String(meta.audience || "") === "EMPLOYER") {
    const companyId = String(meta.ownerId || obj.client_reference_id || "");
    if (!UUID.test(companyId)) throw new HttpError(400, "VALIDATION_ERROR", "invalid session reference");
    const planId = employerPlanOf(meta.plan || meta.planId);
    if (!planId) throw new HttpError(400, "VALIDATION_ERROR", "unsupported plan");
    await lockOwner(ctx.deps.query, "EMPLOYER", companyId);
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
  // The lock is its own statement: a lock taken inside the INSERT would read the balance from the snapshot before the wait.
  if (!await lockOwner(ctx.deps.query, "PERSONAL", userId)) return;
  await query(ctx.deps.query,
    "UPDATE users SET plan = $2, subscription_status = 'ACTIVE', stripe_customer_id = COALESCE(NULLIF($3, ''), stripe_customer_id) WHERE id = $1",
    [userId, planId, String(obj.customer || "")]);
  await userLedger(ctx, userId, grantMicro("PERSONAL", planId), String(obj.id || ""));
}

// Subscription events arrive late and out of order. A delete is final; an update is read back from Stripe and applied only to
// the company's current subscription, so a stale copy can neither revive the plan of an ended one nor end a live one.
async function companySubscriptionChanged(ctx: Ctx, type: string, companyId: string, currentId: string, subscriptionId: string): Promise<void> {
  if (type !== "customer.subscription.deleted") {
    if (!subscriptionId || subscriptionId !== currentId) return;
    const sub = await stripe(ctx, "GET", "/v1/subscriptions/" + encodeURIComponent(subscriptionId));
    if (!ENDED.has(String(sub.status))) {
      const plan = LIVE.has(String(sub.status)) ? employerPlanByPrice(ctx.env, priceOf(sub)) : null;
      if (plan) await query(ctx.deps.query, "UPDATE companies SET plan = $3 WHERE id = $1 AND stripe_subscription_id = $2", [companyId, subscriptionId, plan]);
      return;
    }
  }
  await query(ctx.deps.query,
    "UPDATE companies SET plan = NULL WHERE id = $1 AND (stripe_subscription_id IS NULL OR stripe_subscription_id = $2)",
    [companyId, subscriptionId]);
  await resolveCancelAlert(ctx, subscriptionId);
}

// Personal Stripe subscriptions are legacy; they follow the employer rules: an update is read back from Stripe, a delete is final.
// An active, unexpired App Store or Google Play subscription owns the user's plan, so a late Stripe event leaves it alone. A store row
// whose EXPIRED notification never arrived stops guarding at its expires_at.
async function subscriptionChanged(ctx: Ctx, type: string, obj: Record<string, unknown>): Promise<void> {
  const customer = String(obj.customer || "");
  const subscriptionId = String(obj.id || "");
  if (!customer || !subscriptionId) throw new HttpError(400, "VALIDATION_ERROR", "invalid subscription payload");
  const company = await one(ctx.deps.query, "SELECT id, stripe_subscription_id FROM companies WHERE stripe_customer_id = $1 FOR NO KEY UPDATE", [customer]);
  if (company) {
    await companySubscriptionChanged(ctx, type, String(company.id), String(company.stripe_subscription_id ?? ""), subscriptionId);
    return;
  }
  const user = await one(ctx.deps.query, "SELECT id FROM users WHERE stripe_customer_id = $1 FOR NO KEY UPDATE", [customer]);
  if (!user) {
    // An employer subscription whose customer no company holds: its checkout is not adopted yet (adoption reads the subscription
    // itself), or the company moved to a newer customer and left it. Neither needs the event, and a retry would never find an owner.
    if (employerPlanByPrice(ctx.env, priceOf(obj))) return;
    throw new HttpError(500, "INTERNAL", "internal error");
  }
  const deleted = type === "customer.subscription.deleted";
  const sub = deleted ? obj : await stripe(ctx, "GET", "/v1/subscriptions/" + encodeURIComponent(subscriptionId));
  const canceled = deleted || ENDED.has(String(sub.status ?? ""));
  const priceId = priceOf(sub);
  const end = itemOf(sub)?.current_period_end;
  const period = end ? new Date(Number(end) * 1000).toISOString() : null;
  const plan = canceled ? "FREE" : priceId ? personalPlanByPrice(ctx.env, priceId) : null;
  await query(ctx.deps.query,
    "UPDATE users SET subscription_status = $2, period_ends_at = COALESCE($3::timestamptz, period_ends_at), plan = COALESCE($4, plan) WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM iap_subscriptions WHERE user_id = $1 AND status = 'ACTIVE' AND (expires_at IS NULL OR expires_at > $5::timestamptz))",
    [String(user.id), canceled ? "CANCELED" : "ACTIVE", period, plan, ctx.now.toISOString()]);
}

// Price ids this plan used before the current STRIPE_PRICE_EMPLOYER_* value.
// planLine reads them, so a price rotation still refunds and grants invoices
// created on the previous id. Add the old id here when the env value changes;
// do not delete it. These are test-mode ids, never a live charge.
const LEGACY_EMPLOYER_PRICES: Record<"BASIC" | "PRO" | "ULTRA", readonly string[]> = {
  BASIC: [],
  PRO: ["price_retired_employer_pro"],
  ULTRA: [],
};

const employerPlanByPrice = (env: CoreEnv, priceId: string): "BASIC" | "PRO" | "ULTRA" | null => {
  if (priceId === env.STRIPE_PRICE_EMPLOYER_BASIC || LEGACY_EMPLOYER_PRICES.BASIC.includes(priceId)) return "BASIC";
  if (priceId === env.STRIPE_PRICE_EMPLOYER_PRO || LEGACY_EMPLOYER_PRICES.PRO.includes(priceId)) return "PRO";
  if (priceId === env.STRIPE_PRICE_EMPLOYER_ULTRA || LEGACY_EMPLOYER_PRICES.ULTRA.includes(priceId)) return "ULTRA";
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
  await inTransactionOf(ctx)(async (q) => {
    const tx: Ctx = { ...ctx, deps: { ...ctx.deps, query: q } };
    await lockOwner(q, "PERSONAL", ctx.user.id);
    await claimPurchase(tx, platform, receipt, kind === "TOPUP" ? "CONSUMED" : "ACTIVE");
    if (kind === "TOPUP") {
      await userLedger(tx, ctx.user.id, iapTopupMicro(ctx.env.IAP_TOPUP_CREDITS), receipt.originalTransactionId);
      return;
    }
    await query(q,
      "UPDATE users SET plan = $2, subscription_status = 'ACTIVE', period_ends_at = COALESCE($3::timestamptz, period_ends_at) WHERE id = $1",
      [ctx.user.id, kind, receipt.expiresAt]);
    await userLedger(tx, ctx.user.id, grantMicro("PERSONAL", kind), receipt.originalTransactionId);
  });
  if (kind === "TOPUP") return data(200, { plan: ctx.user.plan || null, periodEndsAt: ts(ctx.user.periodEndsAt) }, ctx.rid);
  return data(200, { plan: kind, periodEndsAt: ts(receipt.expiresAt) }, ctx.rid);
};

// One transaction per notice, holding the user row lock as the Stripe webhook does: a refund reads what is left and writes it
// back, and enqueueJob takes the same lock, so a job cannot reserve credits in between.
const grantNote = (
  ctx: Ctx,
  notificationType: string,
  transactionId: string,
  productId: string,
  expiresAt: string | null,
  sandbox = false,
): Promise<void> => {
  return inTransactionOf(ctx)((q) => storeNote({ ...ctx, deps: { ...ctx.deps, query: q } }, notificationType, transactionId, productId, expiresAt, sandbox));
};

const lockUser = (ctx: Ctx, userId: unknown) => lockOwner(ctx.deps.query, "PERSONAL", String(userId));

const currentStoreSubscription = async (ctx: Ctx, userId: string): Promise<string | null> => {
  const row = await one(ctx.deps.query,
    "SELECT original_transaction_id FROM iap_subscriptions WHERE user_id = $1 AND status = 'ACTIVE' ORDER BY expires_at DESC NULLS FIRST LIMIT 1",
    [userId]);
  return row?.original_transaction_id == null ? null : String(row.original_transaction_id);
};

const storeNote = async (
  ctx: Ctx,
  notificationType: string,
  transactionId: string,
  productId: string,
  expiresAt: string | null,
  sandbox: boolean,
): Promise<void> => {
  const upper = notificationType.toUpperCase();
  if (upper === "REFUND" || upper === "EXPIRED" || upper === "REVOKE" || upper === "GRACE_PERIOD_EXPIRED") {
    // A top-up row is CONSUMED from verify (REFUNDED once refunded), whatever the product id is configured as today.
    const row = await one(ctx.deps.query,
      "SELECT user_id, status IN ('CONSUMED', 'REFUNDED') AS topup FROM iap_subscriptions WHERE original_transaction_id = $1",
      [transactionId]);
    if (row?.user_id) await lockUser(ctx, row.user_id);
    let drivesPlan = false;
    if (row?.user_id && row.topup !== true) {
      drivesPlan = (await currentStoreSubscription(ctx, String(row.user_id))) === transactionId;
    }
    await query(ctx.deps.query,
      "UPDATE iap_subscriptions SET status = CASE WHEN status IN ('CONSUMED', 'REFUNDED') THEN 'REFUNDED' ELSE 'CANCELED' END, expires_at = COALESCE($2::timestamptz, expires_at), sandbox = $3 WHERE original_transaction_id = $1",
      [transactionId, expiresAt, sandbox]);
    if (!row?.user_id) return;
    // A refunded credit top-up is not the subscription: the plan stays and the pack's credits go.
    if (row.topup === true) {
      await takeBack(ctx, { userId: String(row.user_id) }, iapTopupMicro(ctx.env.IAP_TOPUP_CREDITS), transactionId);
      return;
    }
    if (drivesPlan) {
      await query(ctx.deps.query,
        "UPDATE users SET plan = 'FREE', subscription_status = 'CANCELED', period_ends_at = COALESCE($2::timestamptz, period_ends_at) WHERE id = $1",
        [String(row.user_id), expiresAt]);
    }
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
  await lockUser(ctx, userId);
  if (kind === "TOPUP") {
    await userLedger(ctx, userId, iapTopupMicro(ctx.env.IAP_TOPUP_CREDITS), transactionId);
    return;
  }
  await query(ctx.deps.query,
    "UPDATE iap_subscriptions SET status = 'ACTIVE', product_id = $2, expires_at = COALESCE($3::timestamptz, expires_at), sandbox = $4 WHERE original_transaction_id = $1",
    [transactionId, productId, expiresAt, sandbox]);
  if ((await currentStoreSubscription(ctx, userId)) === transactionId) {
    await query(ctx.deps.query,
      "UPDATE users SET plan = $2, subscription_status = 'ACTIVE', period_ends_at = COALESCE($3::timestamptz, period_ends_at) WHERE id = $1",
      [userId, kind, expiresAt]);
    await userLedger(ctx, userId, grantMicro("PERSONAL", kind), transactionId);
  }
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
  let expiresAt = note.expiresAt;
  const pushed = googlePlayPubsub(body);
  const sub = pushed?.subscriptionNotification && typeof pushed.subscriptionNotification === "object"
    ? pushed.subscriptionNotification as Record<string, unknown> : null;
  if (sub) {
    const upper = String(note.notificationType).toUpperCase();
    const grant = upper === "PURCHASE" || upper === "RENEWAL" || upper === "SUBSCRIBED" || upper === "DID_RENEW";
    if (grant && note.purchaseToken && note.productId) {
      expiresAt = (await storePort(ctx).verifyGoogle(note.purchaseToken, note.productId, true)).expiresAt;
    }
  }
  await grantNote(ctx, note.notificationType, note.purchaseToken, note.productId, expiresAt);
  return data(200, { received: true }, ctx.rid);
};
