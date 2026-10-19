import { hmacSha256Hex } from "../crypto.ts";
import { one, query } from "../db.ts";
import { HttpError, data, pageBody } from "../http.ts";
import { pageOf, pageResult, ts } from "../page.ts";
import type { Ctx } from "../types.ts";

const PLANS = new Set(["FREE", "PRO", "ULTRA"]);
const CREDITS: Record<string, number> = { PRO: 30_000_000, ULTRA: 100_000_000 };
const TOLERANCE = 300;

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

export async function billingStatus(ctx: Ctx): Promise<Response> {
  const bal = await one(ctx.deps.query,
    "SELECT balance_after FROM billing_ledger WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1",
    [ctx.user.id]);
  return data(200, {
    subscriptionStatus: ctx.user.subscriptionStatus || "NONE",
    plan: ctx.user.plan || null,
    periodEndsAt: ts(ctx.user.periodEndsAt),
    balanceMicroCredits: Number(bal?.balance_after || 0),
    reservedMicroCredits: 0,
  }, ctx.rid);
}

async function stripePost(ctx: Ctx, path: string, form: URLSearchParams): Promise<Record<string, unknown>> {
  const fetchImpl = ctx.deps.fetch ?? fetch;
  const secret = ctx.env.STRIPE_SECRET_KEY || "";
  const res = await fetchImpl("https://api.stripe.com" + path, {
    method: "POST",
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

export async function checkout(ctx: Ctx): Promise<Response> {
  if (!configured(ctx)) throw new HttpError(503, "NOT_CONFIGURED", "billing is not configured");
  const body = await readObject(ctx.request);
  if (typeof body.planId !== "string") throw new HttpError(400, "VALIDATION_ERROR", "invalid request body");
  if (body.planId === "FREE" || !PLANS.has(body.planId)) {
    throw new HttpError(400, "VALIDATION_ERROR", "unsupported plan", { field: "planId" });
  }
  const price = body.planId === "PRO" ? ctx.env.STRIPE_PRICE_PRO : ctx.env.STRIPE_PRICE_ULTRA;
  if (!price) throw new HttpError(503, "NOT_CONFIGURED", "plan price is not configured");
  try {
    const form = new URLSearchParams({
      mode: "subscription",
      "line_items[0][price]": price,
      "line_items[0][quantity]": "1",
      success_url: ctx.env.STRIPE_SUCCESS_URL || "",
      cancel_url: ctx.env.STRIPE_CANCEL_URL || "",
      client_reference_id: ctx.user.id,
      "metadata[planId]": body.planId,
    });
    if (ctx.user.stripeCustomerId) form.set("customer", ctx.user.stripeCustomerId);
    const session = await stripePost(ctx, "/v1/checkout/sessions", form);
    if (typeof session.url !== "string" || !session.url) throw new Error("url");
    return data(200, {
      url: session.url,
      expiresAt: session.expires_at ? ts(new Date(Number(session.expires_at) * 1000)) : null,
    }, ctx.rid);
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(502, "PROVIDER_ERROR", "stripe checkout session failed");
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
    const session = await stripePost(ctx, "/v1/billing_portal/sessions", form);
    if (typeof session.url !== "string" || !session.url) throw new Error("url");
    return data(200, { url: session.url }, ctx.rid);
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(502, "PROVIDER_ERROR", "stripe portal session failed");
  }
}

export async function ledger(ctx: Ctx): Promise<Response> {
  const page = pageOf(ctx.url);
  const params: unknown[] = [ctx.user.id];
  let sql = "SELECT id, type, amount_micro_credits, balance_after, reference_id, created_at FROM billing_ledger WHERE user_id = $1";
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

async function checkoutCompleted(ctx: Ctx, obj: Record<string, unknown>): Promise<void> {
  const userId = String(obj.client_reference_id || "");
  if (!/^[0-9a-f-]{36}$/i.test(userId)) throw new HttpError(400, "VALIDATION_ERROR", "invalid session reference");
  const planId = String((obj.metadata as { planId?: string } | undefined)?.planId || "");
  if (!PLANS.has(planId) || planId === "FREE") throw new HttpError(400, "VALIDATION_ERROR", "unsupported plan");
  const credits = CREDITS[planId];
  const id = crypto.randomUUID();
  await query(ctx.deps.query,
    "WITH locked AS (SELECT id FROM users WHERE id = $1 FOR UPDATE), updated AS (UPDATE users SET plan = $2, subscription_status = 'ACTIVE', stripe_customer_id = COALESCE(NULLIF($3, ''), stripe_customer_id) WHERE id IN (SELECT id FROM locked) RETURNING id), bal AS (SELECT COALESCE((SELECT balance_after FROM billing_ledger WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1), 0) AS b) INSERT INTO billing_ledger (id, user_id, type, amount_micro_credits, balance_after, reference_id, created_at) SELECT $4, updated.id, 'PURCHASE', $5, bal.b + $5, $6, $7 FROM updated, bal ON CONFLICT (user_id, type, reference_id) DO NOTHING",
    [userId, planId, String(obj.customer || ""), id, credits, String(obj.id || ""), ctx.now.toISOString()]);
}

async function subscriptionChanged(ctx: Ctx, type: string, obj: Record<string, unknown>): Promise<void> {
  const customer = String(obj.customer || "");
  if (!customer) throw new HttpError(400, "VALIDATION_ERROR", "invalid subscription payload");
  const period = obj.current_period_end ? new Date(Number(obj.current_period_end) * 1000).toISOString() : null;
  const canceled = type === "customer.subscription.deleted" || obj.status === "canceled";
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
