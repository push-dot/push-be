import type { Ctx } from "../types.ts";

export type TossPlan = "BASIC" | "PRO" | "ULTRA";

export const TOSS_PRICES = { BASIC: 29_000, PRO: 140_000, ULTRA: 280_000, pack: 14_000 } as const;
export const TOSS_PACK_CREDITS = 1500;

const TOSS_TIMEOUT_MS = 10_000;
const TOSS_ORIGIN = "https://api.tosspayments.com";

export class TossError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

export type TossPayment = { status: string; paymentKey: string; receiptUrl: string | null };

type Json = string | number | boolean | null | Array<Json> | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

const isJsonObject = (value: unknown): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);

const call = async (ctx: Ctx, path: string, body: JsonObject, idempotencyKey?: string): Promise<JsonObject> => {
  const fetchImpl = ctx.deps.fetch ?? fetch;
  const secret = ctx.env.TOSS_SECRET_KEY || "";
  const base = { authorization: "Basic " + btoa(secret + ":"), "content-type": "application/json" };
  const headers = idempotencyKey ? { ...base, "idempotency-key": idempotencyKey } : base;
  let res: Response;
  try {
    res = await fetchImpl(TOSS_ORIGIN + path, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TOSS_TIMEOUT_MS),
    });
  } catch {
    throw new TossError(0, "NETWORK");
  }
  let parsed: JsonObject = {};
  try {
    const raw: unknown = await res.json();
    if (isJsonObject(raw)) {parsed = raw;}
  } catch { /* an unreadable body counts as empty */ }
  if (!res.ok) {throw new TossError(res.status, typeof parsed.code === "string" ? parsed.code : "UNKNOWN");}
  return parsed;
};

const paymentOf = (body: JsonObject): TossPayment => {
  const receipt = body.receipt;
  const url = isJsonObject(receipt) ? receipt.url : undefined;
  return {
    status: String(body.status ?? ""),
    paymentKey: String(body.paymentKey ?? ""),
    receiptUrl: typeof url === "string" && url.startsWith("https://") ? url : null,
  };
};

export const issueBillingKey = async (ctx: Ctx, authKey: string, customerKey: string): Promise<string> => {
  const body = await call(ctx, "/v1/billing/authorizations/issue", { authKey, customerKey });
  if (typeof body.billingKey !== "string" || !body.billingKey) {throw new TossError(502, "NO_BILLING_KEY");}
  return body.billingKey;
};

export const chargeBillingKey = async (
  ctx: Ctx,
  input: { billingKey: string; customerKey: string; amount: number; orderId: string; orderName: string; idempotencyKey: string },
): Promise<TossPayment> => paymentOf(await call(ctx, "/v1/billing/" + encodeURIComponent(input.billingKey), {
  customerKey: input.customerKey, amount: input.amount, orderId: input.orderId, orderName: input.orderName,
}, input.idempotencyKey));

export const confirmPayment = async (ctx: Ctx, input: { paymentKey: string; orderId: string; amount: number }): Promise<TossPayment> =>
  paymentOf(await call(ctx, "/v1/payments/confirm", input, "confirm-" + input.orderId));
