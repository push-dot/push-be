import type { Query } from "../db.ts";
import { isMissingRelation, one } from "../db.ts";
import { HttpError } from "../http.ts";

const asBig = (value: unknown): bigint => {
  if (typeof value === "bigint") return value;
  if (value == null || value === "") return 0n;
  return BigInt(String(value));
};

const USER_CHARGED = "SELECT balance_after FROM billing_ledger WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1";
const USER_SETTLED = "SELECT COALESCE(SUM(cost_micro_credits), 0) AS settled FROM ai_usage WHERE user_id = $1 AND status = 'SETTLED'";
const USER_RESERVED = "SELECT COALESCE(SUM(amount_micro), 0) AS reserved FROM credit_reservations WHERE user_id = $1 AND status = 'RESERVED'";
const COMPANY_CHARGED = "SELECT balance_after FROM billing_ledger WHERE company_id = $1 AND user_id IS NULL ORDER BY created_at DESC, id DESC LIMIT 1";
const COMPANY_SETTLED = "SELECT COALESCE(SUM(cost_micro_credits), 0) AS settled FROM ai_usage WHERE status = 'SETTLED' AND user_id IN (SELECT user_id FROM company_members WHERE company_id = $1)";
const COMPANY_RESERVED = "SELECT COALESCE(SUM(amount_micro), 0) AS reserved FROM credit_reservations WHERE company_id = $1 AND status = 'RESERVED'";

export const reservedMicro = async (tx: Query, userId: string, companyId?: string): Promise<bigint> => {
  const row = await one(tx, companyId ? COMPANY_RESERVED : USER_RESERVED, [companyId ?? userId]);
  return asBig(row?.reserved);
};

const settledMicro = async (tx: Query, sql: string, owner: string): Promise<bigint> => {
  try {
    const row = await one(tx, sql, [owner]);
    return asBig(row?.settled);
  } catch (err) {
    if (isMissingRelation(err)) return 0n;
    throw err;
  }
};

export const availableMicro = async (tx: Query, userId: string, companyId?: string): Promise<bigint> => {
  const owner = companyId ?? userId;
  const charged = await one(tx, companyId ? COMPANY_CHARGED : USER_CHARGED, [owner]);
  const settled = await settledMicro(tx, companyId ? COMPANY_SETTLED : USER_SETTLED, owner);
  const reserved = await reservedMicro(tx, userId, companyId);
  return asBig(charged?.balance_after) - settled - reserved;
};

export const reserveCredits = async (
  tx: Query,
  input: { userId: string; companyId?: string; amount: bigint },
): Promise<void> => {
  if (input.amount <= 0n) return;
  const available = await availableMicro(tx, input.userId, input.companyId);
  if (available < input.amount) {
    throw new HttpError(402, "INSUFFICIENT_CREDITS", "insufficient credits");
  }
};
