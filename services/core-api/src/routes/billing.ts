import { DISPLAY_MICRO, grantMicro, iapTopupMicro } from "../billing/credits.ts";
import { createStoreReceipts, type StoreReceipts } from "../billing/stores.ts";
import { hmacSha256Hex } from "../crypto.ts";
import { one, query } from "../db.ts";
import { HttpError, data, pageBody } from "../http.ts";
import { pageOf, pageResult, ts } from "../page.ts";
import type { CoreEnv, Ctx } from "../types.ts";

const PLANS = new Set(["FREE", "PRO", "ULTRA"]);
const EMPLOYER_PLANS = new Set(["BASIC", "PRO", "ULTRA"]);
const TOLERANCE = 300;
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

const monthKey = (now: Date): string => "monthly:" + now.toISOString().slice(0, 7);

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

const companyLedger = async (ctx: Ctx, companyId: string, amount: number, referenceId: string): Promise<void> => {
  await query(ctx.deps.query,
    "INSERT INTO billing_ledger (id, user_id, company_id, type, amount_micro_credits, balance_after, reference_id, created_at) SELECT $1, NULL, $2, 'PURCHASE', $3, COALESCE((SELECT balance_after FROM billing_ledger WHERE company_id = $2 AND user_id IS NULL ORDER BY created_at DESC, id DESC LIMIT 1), 0) + $3, $4, $5 ON CONFLICT (company_id, type, reference_id) WHERE company_id IS NOT NULL DO NOTHING",
    [crypto.randomUUID(), companyId, amount, referenceId, ctx.now.toISOString()]);
};

const grantMonthly = async (ctx: Ctx, audience: "PERSONAL" | "EMPLOYER", plan: string | null, ownerId: string): Promise<void> => {
  if (!plan) return;
  const amount = grantMicro(audience, plan);
  if (amount <= 0) return;
  const reference = monthKey(ctx.now);
  if (audience === "EMPLOYER") {
    await companyLedger(ctx, ownerId, amount, reference);
    return;
  }
  await userLedger(ctx, ownerId, amount, reference);
};

export async function billingStatus(ctx: Ctx): Promise<Response> {
  if (ctx.user.accountType === "EMPLOYER") {
    if (!ctx.user.companyId) throw new HttpError(404, "NOT_FOUND", "resource not found");
    const company = await one(ctx.deps.query, "SELECT plan FROM companies WHERE id = $1", [ctx.user.companyId]);
    if (!company) throw new HttpError(404, "NOT_FOUND", "resource not found");
    const plan = employerPlanOf(company.plan);
    await grantMonthly(ctx, "EMPLOYER", plan, ctx.user.companyId);
    const bal = await one(ctx.deps.query,
      "SELECT balance_after FROM billing_ledger WHERE company_id = $1 AND user_id IS NULL ORDER BY created_at DESC, id DESC LIMIT 1",
      [ctx.user.companyId]);
    return data(200, {
      subscriptionStatus: plan ? "ACTIVE" : "NONE",
      plan,
      periodEndsAt: null,
      balanceMicroCredits: Number(bal?.balance_after || 0),
      reservedMicroCredits: 0,
      audience: "EMPLOYER",
      source: plan ? "STRIPE" : null,
    }, ctx.rid);
  }
  const plan = ctx.user.plan || null;
  await grantMonthly(ctx, "PERSONAL", plan, ctx.user.id);
  const bal = await one(ctx.deps.query,
    "SELECT balance_after FROM billing_ledger WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1",
    [ctx.user.id]);
  const iap = await one(ctx.deps.query,
    "SELECT platform FROM iap_subscriptions WHERE user_id = $1 AND status = 'ACTIVE' LIMIT 1",
    [ctx.user.id]);
  const platform = iap?.platform == null ? "" : String(iap.platform);
  const source = platform === "APP_STORE" || platform === "GOOGLE_PLAY"
    ? platform
    : ctx.user.subscriptionStatus === "ACTIVE" ? "STRIPE" : null;
  return data(200, {
    subscriptionStatus: ctx.user.subscriptionStatus || "NONE",
    plan,
    periodEndsAt: ts(ctx.user.periodEndsAt),
    balanceMicroCredits: Number(bal?.balance_after || 0),
    reservedMicroCredits: 0,
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
  if (ctx.user.accountType === "EMPLOYER") {
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
      success_url: ctx.env.STRIPE_SUCCESS_URL || "",
      cancel_url: ctx.env.STRIPE_CANCEL_URL || "",
      client_reference_id: ctx.user.companyId,
      "metadata[audience]": "EMPLOYER",
      "metadata[plan]": body.planId,
    });
    const customer = company.stripe_customer_id == null ? "" : String(company.stripe_customer_id);
    if (customer) form.set("customer", customer);
    return checkoutSession(ctx, form);
  }
  if (body.planId === "FREE" || !PLANS.has(body.planId)) {
    throw new HttpError(400, "VALIDATION_ERROR", "unsupported plan", { field: "planId" });
  }
  const activeIap = await one(ctx.deps.query,
    "SELECT id FROM iap_subscriptions WHERE user_id = $1 AND status = 'ACTIVE' LIMIT 1",
    [ctx.user.id]);
  if (activeIap) throw new HttpError(409, "ALREADY_SUBSCRIBED", "already subscribed");
  const price = body.planId === "PRO" ? ctx.env.STRIPE_PRICE_PRO : ctx.env.STRIPE_PRICE_ULTRA;
  if (!price) throw new HttpError(503, "NOT_CONFIGURED", "plan price is not configured");
  const form = new URLSearchParams({
    mode: "subscription",
    "line_items[0][price]": price,
    "line_items[0][quantity]": "1",
    success_url: ctx.env.STRIPE_SUCCESS_URL || "",
    cancel_url: ctx.env.STRIPE_CANCEL_URL || "",
    client_reference_id: ctx.user.id,
    "metadata[planId]": body.planId,
    "metadata[audience]": "PERSONAL",
  });
  if (ctx.user.stripeCustomerId) form.set("customer", ctx.user.stripeCustomerId);
  return checkoutSession(ctx, form);
}

/** Cancels every live subscription now (no refund). Called before an account is marked for deletion. */
export async function cancelSubscriptions(ctx: Ctx, customerId?: string): Promise<void> {
  const customer = customerId ?? ctx.user.stripeCustomerId;
  if (!configured(ctx) || !customer) return;
  try {
    // Without a status filter Stripe lists every subscription that is not already canceled.
    const list = await stripe(ctx, "GET", "/v1/subscriptions?limit=100&customer=" + encodeURIComponent(customer));
    const subs = Array.isArray(list.data) ? list.data as Record<string, unknown>[] : [];
    for (const sub of subs) await stripe(ctx, "DELETE", "/v1/subscriptions/" + encodeURIComponent(String(sub.id)));
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
  let sql = "SELECT id, type, amount_micro_credits, balance_after, reference_id, created_at FROM billing_ledger WHERE "
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
    if (event.type === "checkout.session.completed") await checkoutCompleted(ctx, obj);
    else if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
      await subscriptionChanged(ctx, String(event.type), obj);
    }
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

async function checkoutCompleted(ctx: Ctx, obj: Record<string, unknown>): Promise<void> {
  const meta = metaOf(obj);
  if (meta.amountMicroCredits != null && String(meta.amountMicroCredits) !== "") {
    const micro = positiveInt(meta.amountMicroCredits);
    if (micro == null) throw new HttpError(400, "VALIDATION_ERROR", "unsupported plan");
    const ownerId = String(meta.ownerId || obj.client_reference_id || "");
    if (!UUID.test(ownerId)) throw new HttpError(400, "VALIDATION_ERROR", "invalid session reference");
    const reference = String(obj.id || "");
    if (String(meta.audience || "") === "EMPLOYER") await companyLedger(ctx, ownerId, micro, reference);
    else await userLedger(ctx, ownerId, micro, reference);
    return;
  }
  if (String(meta.audience || "") === "EMPLOYER") {
    const companyId = String(meta.ownerId || obj.client_reference_id || "");
    if (!UUID.test(companyId)) throw new HttpError(400, "VALIDATION_ERROR", "invalid session reference");
    const planId = String(meta.plan || meta.planId || "");
    if (!EMPLOYER_PLANS.has(planId)) throw new HttpError(400, "VALIDATION_ERROR", "unsupported plan");
    await query(ctx.deps.query,
      "UPDATE companies SET plan = $2, stripe_customer_id = COALESCE(NULLIF($3, ''), stripe_customer_id) WHERE id = $1",
      [companyId, planId, String(obj.customer || "")]);
    await companyLedger(ctx, companyId, grantMicro("EMPLOYER", planId), String(obj.id || ""));
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
  const canceled = type === "customer.subscription.deleted" || obj.status === "canceled";
  const items = ((obj.items as { data?: { price?: { id?: string } }[] } | undefined)?.data) || [];
  const employerPriceId = items[0]?.price?.id || "";
  let employerPlan: string | null = null;
  if (employerPriceId && employerPriceId === ctx.env.STRIPE_PRICE_EMPLOYER_BASIC) employerPlan = "BASIC";
  else if (employerPriceId && employerPriceId === ctx.env.STRIPE_PRICE_EMPLOYER_PRO) employerPlan = "PRO";
  else if (employerPriceId && employerPriceId === ctx.env.STRIPE_PRICE_EMPLOYER_ULTRA) employerPlan = "ULTRA";
  const company = await one(ctx.deps.query,
    canceled
      ? "UPDATE companies SET plan = NULL WHERE stripe_customer_id = $1 RETURNING id"
      : "UPDATE companies SET plan = COALESCE($2, plan) WHERE stripe_customer_id = $1 RETURNING id",
    canceled ? [customer] : [customer, employerPlan]);
  if (company) return;
  const period = obj.current_period_end ? new Date(Number(obj.current_period_end) * 1000).toISOString() : null;
  const status = canceled ? "CANCELED" : "ACTIVE";
  let plan: string | null = canceled ? "FREE" : null;
  if (!canceled) {
    const items = ((obj.items as { data?: { price?: { id?: string } }[] } | undefined)?.data) || [];
    const price = items[0]?.price?.id || "";
    if (price && price === ctx.env.STRIPE_PRICE_PRO) plan = "PRO";
    else if (price && price === ctx.env.STRIPE_PRICE_ULTRA) plan = "ULTRA";
  }
  const updated = await one(ctx.deps.query,
    "UPDATE users SET subscription_status = $2, period_ends_at = COALESCE($3::timestamptz, period_ends_at), plan = COALESCE($4, plan) WHERE stripe_customer_id = $1 RETURNING id",
    [customer, status, period, plan]);
  if (!updated) throw new HttpError(500, "INTERNAL", "internal error");
}

const productKind = (env: CoreEnv, productId: string): "PRO" | "ULTRA" | "TOPUP" | "UNKNOWN" | "MISSING" => {
  if (!env.IAP_PRODUCT_PRO && !env.IAP_PRODUCT_ULTRA && !env.IAP_PRODUCT_TOPUP) return "MISSING";
  if (env.IAP_PRODUCT_PRO && productId === env.IAP_PRODUCT_PRO) return "PRO";
  if (env.IAP_PRODUCT_ULTRA && productId === env.IAP_PRODUCT_ULTRA) return "ULTRA";
  if (env.IAP_PRODUCT_TOPUP && productId === env.IAP_PRODUCT_TOPUP) return "TOPUP";
  return "UNKNOWN";
};

const storePort = (ctx: Ctx): StoreReceipts => ctx.deps.stores ?? createStoreReceipts(ctx.env, ctx.deps.fetch ?? fetch);

const requireKind = (env: CoreEnv, productId: string): "PRO" | "ULTRA" | "TOPUP" => {
  const kind = productKind(env, productId);
  if (kind === "MISSING") throw new HttpError(503, "NOT_CONFIGURED", "iap products are not configured");
  if (kind === "UNKNOWN") throw new HttpError(400, "VALIDATION_ERROR", "unknown product", { field: "productId" });
  return kind;
};

export const topup = async (ctx: Ctx): Promise<Response> => {
  if (!configured(ctx)) throw new HttpError(503, "NOT_CONFIGURED", "billing is not configured");
  const body = await readObject(ctx.request);
  const amount = body.amount;
  if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount <= 0) {
    throw new HttpError(400, "VALIDATION_ERROR", "must be a positive integer", { field: "amount" });
  }
  const price = ctx.env.STRIPE_PRICE_TOPUP;
  if (!price) throw new HttpError(503, "NOT_CONFIGURED", "plan price is not configured");
  let audience: "PERSONAL" | "EMPLOYER" = "PERSONAL";
  let ownerId = ctx.user.id;
  let customer = ctx.user.stripeCustomerId;
  if (ctx.user.accountType === "EMPLOYER") {
    if (!ctx.user.companyId) throw new HttpError(404, "NOT_FOUND", "resource not found");
    if (ctx.user.companyRole !== "ADMIN") throw new HttpError(403, "FORBIDDEN", "admin required");
    audience = "EMPLOYER";
    ownerId = ctx.user.companyId;
    const company = await one(ctx.deps.query, "SELECT stripe_customer_id FROM companies WHERE id = $1", [ctx.user.companyId]);
    if (!company) throw new HttpError(404, "NOT_FOUND", "resource not found");
    customer = company.stripe_customer_id == null ? null : String(company.stripe_customer_id);
  }
  try {
    const form = new URLSearchParams({
      mode: "payment",
      "line_items[0][price]": price,
      "line_items[0][quantity]": String(amount),
      success_url: ctx.env.STRIPE_SUCCESS_URL || "",
      cancel_url: ctx.env.STRIPE_CANCEL_URL || "",
      client_reference_id: ownerId,
      "metadata[amountMicroCredits]": String(amount * DISPLAY_MICRO),
      "metadata[audience]": audience,
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
  if (kind !== "TOPUP" && ctx.user.subscriptionStatus === "ACTIVE") {
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
    : await stores.verifyGoogle(String(body.purchaseToken), body.productId);
  if (requireKind(ctx.env, receipt.productId) !== kind) {
    throw new HttpError(400, "VALIDATION_ERROR", "unknown product", { field: "productId" });
  }
  if (kind === "TOPUP") {
    await userLedger(ctx, ctx.user.id, iapTopupMicro(ctx.env.IAP_TOPUP_CREDITS), receipt.originalTransactionId);
    return data(200, { plan: ctx.user.plan || null, periodEndsAt: ts(ctx.user.periodEndsAt) }, ctx.rid);
  }
  await query(ctx.deps.query,
    "INSERT INTO iap_subscriptions (id, user_id, platform, original_transaction_id, product_id, expires_at, status) VALUES ($1,$2,$3,$4,$5,$6,'ACTIVE') ON CONFLICT (original_transaction_id) DO UPDATE SET product_id = EXCLUDED.product_id, expires_at = EXCLUDED.expires_at, status = 'ACTIVE', platform = EXCLUDED.platform",
    [crypto.randomUUID(), ctx.user.id, platform, receipt.originalTransactionId, receipt.productId, receipt.expiresAt]);
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
): Promise<void> => {
  const upper = notificationType.toUpperCase();
  if (upper === "REFUND" || upper === "EXPIRED") {
    await query(ctx.deps.query,
      "UPDATE iap_subscriptions SET status = 'CANCELED', expires_at = COALESCE($2::timestamptz, expires_at) WHERE original_transaction_id = $1",
      [transactionId, expiresAt]);
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
    "UPDATE iap_subscriptions SET status = 'ACTIVE', product_id = $2, expires_at = COALESCE($3::timestamptz, expires_at) WHERE original_transaction_id = $1",
    [transactionId, productId, expiresAt]);
  await query(ctx.deps.query,
    "UPDATE users SET plan = $2, subscription_status = 'ACTIVE', period_ends_at = COALESCE($3::timestamptz, period_ends_at) WHERE id = $1",
    [userId, kind, expiresAt]);
  await userLedger(ctx, userId, grantMicro("PERSONAL", kind), transactionId);
};

export const appleWebhook = async (ctx: Ctx): Promise<Response> => {
  const raw = await ctx.request.text();
  if (!raw) throw new HttpError(400, "VALIDATION_ERROR", "unreadable body");
  const note = await storePort(ctx).decodeAppleNotification(raw);
  await grantNote(ctx, note.notificationType, note.originalTransactionId, note.productId, note.expiresAt);
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
  const note = await storePort(ctx).decodeGoogleNotification(body);
  await grantNote(ctx, note.notificationType, note.purchaseToken, note.productId, note.expiresAt);
  return data(200, { received: true }, ctx.rid);
};
