import type { Query } from "../db.ts";

export const DISPLAY_MICRO = 6000;

const PERSONAL: Record<string, number> = {
  FREE: 1_800_000,
  PRO: 30_000_000,
  ULTRA: 100_000_000,
};

const EMPLOYER: Record<string, number> = {
  BASIC: 18_000_000,
  PRO: 90_000_000,
  ULTRA: 180_000_000,
};

export const grantMicro = (audience: "PERSONAL" | "EMPLOYER", plan: string): number => {
  const table = audience === "EMPLOYER" ? EMPLOYER : PERSONAL;
  return table[plan] ?? 0;
};

export const iapTopupMicro = (raw: string | undefined): number => {
  const text = raw?.trim() ?? "";
  if (text === "") return 300 * DISPLAY_MICRO;
  if (!/^[1-9]\d*$/.test(text)) return 300 * DISPLAY_MICRO;
  return Number(text) * DISPLAY_MICRO;
};

const USER_GRANT = "INSERT INTO billing_ledger (id, user_id, type, amount_micro_credits, balance_after, reference_id, created_at) SELECT $1, $2, 'PURCHASE', $3, COALESCE((SELECT balance_after FROM billing_ledger WHERE user_id = $2 ORDER BY created_at DESC, id DESC LIMIT 1), 0) + $3, $4, $5 ON CONFLICT (user_id, type, reference_id) DO NOTHING";
const COMPANY_GRANT = "INSERT INTO billing_ledger (id, user_id, company_id, type, amount_micro_credits, balance_after, reference_id, created_at) SELECT $1, NULL, $2, 'PURCHASE', $3, COALESCE((SELECT balance_after FROM billing_ledger WHERE company_id = $2 AND user_id IS NULL ORDER BY created_at DESC, id DESC LIMIT 1), 0) + $3, $4, $5 ON CONFLICT (company_id, type, reference_id) WHERE company_id IS NOT NULL DO NOTHING";

/** Writes this month's plan credits once (reference `monthly:YYYY-MM`). Safe to call on every billing read and enqueue. */
export const ensureMonthlyGrant = async (
  q: Query,
  input: { audience: "PERSONAL" | "EMPLOYER"; plan: string | null; ownerId: string; now: Date },
): Promise<void> => {
  const plan = input.plan?.trim() || (input.audience === "PERSONAL" ? "FREE" : "");
  const amount = grantMicro(input.audience, plan);
  if (amount <= 0) return;
  const reference = "monthly:" + input.now.toISOString().slice(0, 7);
  await q(input.audience === "EMPLOYER" ? COMPANY_GRANT : USER_GRANT,
    [crypto.randomUUID(), input.ownerId, amount, reference, input.now.toISOString()]);
};
