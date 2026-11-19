import { boundTransaction, grantPeriod, lockOwner } from "../billing/credits.ts";
import {
  TOSS_PACK_CREDITS, TOSS_PRICES, TossError, chargeBillingKey, confirmPayment, issueBillingKey, type TossPayment, type TossPlan,
} from "../billing/toss.ts";
import { base64ToBytes, bytesToBase64, decryptAes, encryptAes, masterKey } from "../crypto.ts";
import { one, query } from "../db.ts";
import { HttpError, data, noContent, uuid5Url } from "../http.ts";
import type { Ctx } from "../types.ts";
import {
  EMPLOYER_PLANS, MAX_PACKS, PACK_MICRO, TOPUP_DESCRIPTION, companyLedger, employerPlanOf, inTransactionOf, planDescription,
} from "./billing.ts";
import { requireJob } from "./notification-jobs.ts";
import { readObject } from "./recruiting-shared.ts";

const MAX_FAILURES = 3;
const RENEW_BATCH = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const subscriptionIdOf = (companyId: string): string => "toss-" + companyId;

const addMonth = (from: Date): Date => {
  const target = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1, from.getUTCHours(), from.getUTCMinutes(), from.getUTCSeconds(), from.getUTCMilliseconds()));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(from.getUTCDate(), lastDay));
  return target;
};

const requireAdmin = (ctx: Ctx): string => {
  if (!ctx.env.TOSS_SECRET_KEY) throw new HttpError(503, "NOT_CONFIGURED", "billing is not configured");
  if (ctx.user.accountType !== "EMPLOYER") throw new HttpError(403, "FORBIDDEN", "admin required");
  if (!ctx.user.companyId) throw new HttpError(404, "NOT_FOUND", "resource not found");
  if (ctx.user.companyRole !== "ADMIN") throw new HttpError(403, "FORBIDDEN", "admin required");
  return ctx.user.companyId;
};

const requirePlan = (value: unknown): TossPlan => {
  if (typeof value !== "string" || !EMPLOYER_PLANS.has(value)) throw new HttpError(400, "VALIDATION_ERROR", "unsupported plan", { field: "planId" });
  return value as TossPlan;
};

const requireText = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.trim() === "") throw new HttpError(400, "VALIDATION_ERROR", "invalid request body", { field });
  return value;
};

const providerError = (err: unknown): HttpError => {
  if (err instanceof HttpError) return err;
  if (err instanceof TossError && err.status >= 400 && err.status < 500) return new HttpError(402, "PAYMENT_FAILED", "payment was declined", { code: err.code });
  return new HttpError(502, "PROVIDER_ERROR", "toss request failed");
};

const cipher = async (ctx: Ctx): Promise<CryptoKey> => {
  if (!ctx.env.TOKEN_ENCRYPTION_KEY) throw new HttpError(503, "NOT_CONFIGURED", "token encryption is not configured");
  return masterKey(ctx.env.TOKEN_ENCRYPTION_KEY);
};

const seal = async (ctx: Ctx, companyId: string, billingKey: string): Promise<string> => {
  const sealed = await encryptAes(await cipher(ctx), billingKey, companyId, "toss");
  return bytesToBase64(sealed.nonce) + ":" + bytesToBase64(sealed.ciphertext);
};

const unseal = async (ctx: Ctx, companyId: string, stored: string): Promise<string> => {
  const [nonce, ciphertext] = stored.split(":");
  return decryptAes(await cipher(ctx), base64ToBytes(ciphertext ?? ""), base64ToBytes(nonce ?? ""), companyId, "toss");
};

const customerKeyOf = async (ctx: Ctx, companyId: string): Promise<string> => {
  await query(ctx.deps.query,
    "INSERT INTO toss_billing (company_id, customer_key, updated_at) VALUES ($1, $2, $3) ON CONFLICT (company_id) DO NOTHING",
    [companyId, crypto.randomUUID(), ctx.now.toISOString()]);
  const row = await one(ctx.deps.query, "SELECT customer_key FROM toss_billing WHERE company_id = $1", [companyId]);
  if (!row) throw new HttpError(500, "INTERNAL", "internal error");
  return String(row.customer_key);
};

const settle = (ctx: Ctx, companyId: string, work: (tx: Ctx) => Promise<void>): Promise<void> => inTransactionOf(ctx)(async (q) => {
  await boundTransaction(q, "15s");
  await lockOwner(q, "EMPLOYER", companyId);
  await work({ ...ctx, deps: { ...ctx.deps, query: q } });
});

const addOrder = (ctx: Ctx, order: { orderId: string; companyId: string; kind: "PLAN" | "TOPUP"; plan: TossPlan | null; packs: number | null; amount: number }): Promise<unknown> => query(ctx.deps.query,
  "INSERT INTO toss_orders (order_id, company_id, kind, plan, packs, amount, status, created_at) VALUES ($1, $2, $3, $4, $5, $6, 'PENDING', $7) ON CONFLICT (order_id) DO NOTHING",
  [order.orderId, order.companyId, order.kind, order.plan, order.packs, order.amount, ctx.now.toISOString()]);

const failOrder = (ctx: Ctx, orderId: string): Promise<unknown> => query(ctx.deps.query,
  "UPDATE toss_orders SET status = 'FAILED' WHERE order_id = $1 AND status = 'PENDING'", [orderId]);

const doneOrder = (ctx: Ctx, orderId: string, payment: TossPayment): Promise<unknown> => query(ctx.deps.query,
  "UPDATE toss_orders SET status = 'DONE', payment_key = $2, receipt_url = $3 WHERE order_id = $1",
  [orderId, payment.paymentKey, payment.receiptUrl]);

const activate = async (tx: Ctx, input: { companyId: string; plan: TossPlan; orderId: string; payment: TossPayment; start: Date; sealedKey: string | null }): Promise<void> => {
  const end = addMonth(input.start);
  const amount = TOSS_PRICES[input.plan];
  await query(tx.deps.query,
    "UPDATE toss_billing SET billing_key_enc = COALESCE($2, billing_key_enc), plan = $3, period_start = $4, period_end = $5, next_charge_at = $5, canceled_at = NULL, failures = 0, updated_at = $4 WHERE company_id = $1",
    [input.companyId, input.sealedKey, input.plan, input.start.toISOString(), end.toISOString()]);
  await query(tx.deps.query, "UPDATE companies SET plan = $2, credit_period_start = $3 WHERE id = $1", [input.companyId, input.plan, input.start.toISOString()]);
  await doneOrder(tx, input.orderId, input.payment);
  await companyLedger(tx, input.companyId, 0, input.orderId, {
    description: planDescription(input.plan), amountUsdCents: null, receiptUrl: input.payment.receiptUrl, amountKrw: amount,
  });
  await grantPeriod(tx.deps.query, { companyId: input.companyId, subscriptionId: subscriptionIdOf(input.companyId), periodStart: input.start, plan: input.plan, carry: 0, now: tx.now });
};

const drop = (ctx: Ctx, companyId: string): Promise<void> => settle(ctx, companyId, async (tx) => {
  await query(tx.deps.query,
    "UPDATE toss_billing SET plan = NULL, billing_key_enc = NULL, next_charge_at = NULL, failures = 0, updated_at = $2 WHERE company_id = $1",
    [companyId, tx.now.toISOString()]);
  await query(tx.deps.query, "UPDATE companies SET plan = NULL, credit_period_start = NULL WHERE id = $1", [companyId]);
});

export const billingAuth = async (ctx: Ctx): Promise<Response> => {
  const companyId = requireAdmin(ctx);
  const body = await readObject(ctx.request);
  const plan = requirePlan(body.planId);
  const customerKey = await customerKeyOf(ctx, companyId);
  return data(200, { customerKey, planId: plan, amount: TOSS_PRICES[plan], orderName: planDescription(plan) }, ctx.rid);
};

export const billingConfirm = async (ctx: Ctx): Promise<Response> => {
  const companyId = requireAdmin(ctx);
  const body = await readObject(ctx.request);
  const authKey = requireText(body.authKey, "authKey");
  const customerKey = requireText(body.customerKey, "customerKey");
  const plan = requirePlan(body.planId);
  const row = await one(ctx.deps.query, "SELECT customer_key FROM toss_billing WHERE company_id = $1", [companyId]);
  if (!row) throw new HttpError(409, "INVALID_TRANSITION", "billing auth required");
  if (String(row.customer_key) !== customerKey) throw new HttpError(403, "FORBIDDEN", "customer key mismatch");
  const amount = TOSS_PRICES[plan];
  const orderId = crypto.randomUUID();
  let payment: TossPayment;
  let sealedKey: string;
  try {
    const billingKey = await issueBillingKey(ctx, authKey, customerKey);
    sealedKey = await seal(ctx, companyId, billingKey);
    await addOrder(ctx, { orderId, companyId, kind: "PLAN", plan, packs: null, amount });
    payment = await chargeBillingKey(ctx, { billingKey, customerKey, amount, orderId, orderName: planDescription(plan), idempotencyKey: "toss-first-" + orderId });
  } catch (err) {
    await failOrder(ctx, orderId);
    throw providerError(err);
  }
  if (payment.status !== "DONE") {
    await failOrder(ctx, orderId);
    throw new HttpError(402, "PAYMENT_FAILED", "payment was declined", { code: payment.status });
  }
  await settle(ctx, companyId, (tx) => activate(tx, { companyId, plan, orderId, payment, start: ctx.now, sealedKey }));
  return data(200, { plan, amount, receiptUrl: payment.receiptUrl }, ctx.rid);
};

export const tossTopup = async (ctx: Ctx): Promise<Response> => {
  const companyId = requireAdmin(ctx);
  const body = await readObject(ctx.request);
  const packs = body.packs;
  if (typeof packs !== "number" || !Number.isSafeInteger(packs) || packs < 1 || packs > MAX_PACKS) {
    throw new HttpError(400, "VALIDATION_ERROR", "must be an integer from 1 to " + MAX_PACKS, { field: "packs" });
  }
  const orderId = crypto.randomUUID();
  const amount = packs * TOSS_PRICES.pack;
  const customerKey = await customerKeyOf(ctx, companyId);
  await addOrder(ctx, { orderId, companyId, kind: "TOPUP", plan: null, packs, amount });
  return data(200, { orderId, amount, orderName: `크레딧 ${packs}팩`, customerKey }, ctx.rid);
};

export const tossTopupConfirm = async (ctx: Ctx): Promise<Response> => {
  const companyId = requireAdmin(ctx);
  const body = await readObject(ctx.request);
  const paymentKey = requireText(body.paymentKey, "paymentKey");
  const orderId = requireText(body.orderId, "orderId");
  if (!UUID.test(orderId)) throw new HttpError(400, "VALIDATION_ERROR", "invalid request body", { field: "orderId" });
  if (typeof body.amount !== "number" || !Number.isSafeInteger(body.amount)) throw new HttpError(400, "VALIDATION_ERROR", "invalid request body", { field: "amount" });
  const order = await one(ctx.deps.query,
    "SELECT kind, packs, amount, status, receipt_url FROM toss_orders WHERE order_id = $1 AND company_id = $2", [orderId, companyId]);
  if (!order || order.kind !== "TOPUP") throw new HttpError(404, "NOT_FOUND", "resource not found");
  if (Number(order.amount) !== body.amount) throw new HttpError(400, "VALIDATION_ERROR", "amount does not match the order", { field: "amount" });
  const creditsAdded = Number(order.packs) * TOSS_PACK_CREDITS;
  if (order.status === "DONE") return data(200, { creditsAdded, receiptUrl: order.receipt_url == null ? null : String(order.receipt_url) }, ctx.rid);
  if (order.status !== "PENDING") throw new HttpError(409, "INVALID_TRANSITION", "order is closed");
  let payment: TossPayment;
  try {
    payment = await confirmPayment(ctx, { paymentKey, orderId, amount: body.amount });
  } catch (err) {
    throw providerError(err);
  }
  if (payment.status !== "DONE") throw new HttpError(402, "PAYMENT_FAILED", "payment was declined", { code: payment.status });
  await settle(ctx, companyId, async (tx) => {
    await doneOrder(tx, orderId, { ...payment, paymentKey });
    await companyLedger(tx, companyId, Number(order.packs) * PACK_MICRO, orderId, {
      description: TOPUP_DESCRIPTION, amountUsdCents: null, receiptUrl: payment.receiptUrl, amountKrw: Number(order.amount),
    });
  });
  return data(200, { creditsAdded, receiptUrl: payment.receiptUrl }, ctx.rid);
};

export const tossCancel = async (ctx: Ctx): Promise<Response> => {
  const companyId = requireAdmin(ctx);
  const row = await one(ctx.deps.query, "SELECT plan FROM toss_billing WHERE company_id = $1", [companyId]);
  if (!row || row.plan == null) throw new HttpError(409, "INVALID_TRANSITION", "no active subscription");
  await query(ctx.deps.query,
    "UPDATE toss_billing SET canceled_at = COALESCE(canceled_at, $2), updated_at = $2 WHERE company_id = $1", [companyId, ctx.now.toISOString()]);
  return noContent(ctx.rid);
};

type Due = { companyId: string; customerKey: string; sealedKey: string | null; plan: TossPlan | null; periodEnd: Date; canceled: boolean; failures: number };

const renewOne = async (ctx: Ctx, due: Due): Promise<"renewed" | "failed" | "dropped"> => {
  const { companyId, plan } = due;
  if (due.canceled || !plan || !due.sealedKey) {
    await drop(ctx, companyId);
    return "dropped";
  }
  const epoch = Math.floor(due.periodEnd.getTime() / 1000);
  const idempotencyKey = `toss-renew:${companyId}:${epoch}:${due.failures}`;
  const orderId = await uuid5Url(idempotencyKey);
  const amount = TOSS_PRICES[plan];
  await addOrder(ctx, { orderId, companyId, kind: "PLAN", plan, packs: null, amount });
  let payment: TossPayment | null = null;
  try {
    const billingKey = await unseal(ctx, companyId, due.sealedKey);
    payment = await chargeBillingKey(ctx, { billingKey, customerKey: due.customerKey, amount, orderId, orderName: planDescription(plan), idempotencyKey });
  } catch {
    payment = null;
  }
  if (payment?.status === "DONE") {
    const start = addMonth(due.periodEnd) > ctx.now ? due.periodEnd : ctx.now;
    const done = payment;
    await settle(ctx, companyId, (tx) => activate(tx, { companyId, plan, orderId, payment: done, start, sealedKey: null }));
    return "renewed";
  }
  await failOrder(ctx, orderId);
  if (due.failures + 1 >= MAX_FAILURES) {
    await drop(ctx, companyId);
    return "dropped";
  }
  await query(ctx.deps.query, "UPDATE toss_billing SET failures = $2, updated_at = $3 WHERE company_id = $1", [companyId, due.failures + 1, ctx.now.toISOString()]);
  return "failed";
};

export const runTossRenewals = async (ctx: Ctx): Promise<Response> => {
  await requireJob(ctx);
  if (!ctx.env.TOSS_SECRET_KEY) return data(200, { renewed: 0, failed: 0, dropped: 0 }, ctx.rid);
  const rows = await query(ctx.deps.query,
    "SELECT company_id, customer_key, billing_key_enc, plan, period_end, canceled_at, failures FROM toss_billing WHERE next_charge_at <= $1 AND plan IS NOT NULL ORDER BY next_charge_at LIMIT " + RENEW_BATCH,
    [ctx.now.toISOString()]);
  const tally = { renewed: 0, failed: 0, dropped: 0 };
  for (const row of rows.rows) {
    try {
      const outcome = await renewOne(ctx, {
        companyId: String(row.company_id),
        customerKey: String(row.customer_key),
        sealedKey: row.billing_key_enc == null ? null : String(row.billing_key_enc),
        plan: employerPlanOf(row.plan),
        periodEnd: new Date(String(row.period_end)),
        canceled: row.canceled_at != null,
        failures: Number(row.failures),
      });
      tally[outcome] += 1;
    } catch {
      console.error(JSON.stringify({ tossRenewalError: String(row.company_id) }));
    }
  }
  return data(200, tally, ctx.rid);
};

export const dispatchToss = async (ctx: Ctx, path: string): Promise<Response | null> => {
  if (ctx.request.method !== "POST") return null;
  if (path === "/api/v1/billing/toss/billing-auth") return billingAuth(ctx);
  if (path === "/api/v1/billing/toss/billing-confirm") return billingConfirm(ctx);
  if (path === "/api/v1/billing/toss/topup") return tossTopup(ctx);
  if (path === "/api/v1/billing/toss/topup-confirm") return tossTopupConfirm(ctx);
  if (path === "/api/v1/billing/toss/cancel") return tossCancel(ctx);
  return null;
};
