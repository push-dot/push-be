import type { Query } from "../db.ts";

export const DISPLAY_MICRO = 6000;

const PERSONAL: Record<string, number> = {
  FREE: 1_800_000,
  PRO: 27_000_000,
  ULTRA: 108_000_000,
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
// A legacy `monthly:YYYY-MM` row (one row of the whole plan amount) already covers every tier up to its amount.
const COMPANY_STEP = "INSERT INTO billing_ledger (id, user_id, company_id, type, amount_micro_credits, balance_after, reference_id, created_at) SELECT $1, NULL, $2, 'PURCHASE', $3::bigint, (SELECT COALESCE(SUM(amount_micro_credits), 0)::bigint FROM billing_ledger WHERE company_id = $2 AND user_id IS NULL) + $3::bigint, $4, $5 WHERE NOT EXISTS (SELECT 1 FROM billing_ledger WHERE company_id = $2 AND user_id IS NULL AND type = 'PURCHASE' AND reference_id = $6 AND amount_micro_credits >= $7::bigint) ON CONFLICT (company_id, type, reference_id) WHERE company_id IS NOT NULL DO NOTHING";
const COMPANY_GRANTED = "SELECT COALESCE(SUM(amount_micro_credits), 0) AS granted FROM billing_ledger WHERE company_id = $1 AND user_id IS NULL AND type = 'PURCHASE' AND reference_id LIKE $2";

const EMPLOYER_TIERS = ["BASIC", "PRO", "ULTRA"];
const monthOf = (now: Date): string => "monthly:" + now.toISOString().slice(0, 7);

/**
 * Writes this month's plan credits once. Personal: one `monthly:YYYY-MM` row. Employer: one row per tier up to the plan
 * (`monthly:YYYY-MM:BASIC|PRO|ULTRA`), each worth the gap to the tier below, so upgrades add only the difference and
 * a month never grants more than its highest plan, whatever the order or concurrency of the calls.
 * Safe to call on every billing read, enqueue, and plan checkout.
 */
export const ensureMonthlyGrant = async (
  q: Query,
  input: { audience: "PERSONAL" | "EMPLOYER"; plan: string | null; ownerId: string; now: Date },
): Promise<void> => {
  const plan = input.plan?.trim() || (input.audience === "PERSONAL" ? "FREE" : "");
  const amount = grantMicro(input.audience, plan);
  if (amount <= 0) return;
  const month = monthOf(input.now);
  if (input.audience === "PERSONAL") {
    await q(USER_GRANT, [crypto.randomUUID(), input.ownerId, amount, month, input.now.toISOString()]);
    return;
  }
  let below = 0;
  for (const tier of EMPLOYER_TIERS.slice(0, EMPLOYER_TIERS.indexOf(plan) + 1)) {
    const total = EMPLOYER[tier] ?? 0;
    await q(COMPANY_STEP, [crypto.randomUUID(), input.ownerId, total - below, month + ":" + tier, input.now.toISOString(), month, total]);
    below = total;
  }
};

/** Plan credits the company got in the month of `now`, legacy and tier rows together. */
export const grantedThisMonth = async (q: Query, companyId: string, now: Date): Promise<number> => {
  const result = await q(COMPANY_GRANTED, [companyId, monthOf(now) + "%"]);
  return Number(result.rows[0]?.granted ?? 0);
};
