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
const COMPANY_INSERT = "INSERT INTO billing_ledger (id, user_id, company_id, type, amount_micro_credits, balance_after, reference_id, created_at) SELECT $1, NULL, c.id, 'PURCHASE', $3::bigint, (SELECT COALESCE(SUM(amount_micro_credits), 0)::bigint FROM billing_ledger WHERE company_id = c.id AND user_id IS NULL) + $3::bigint, $4, $5 FROM ";
const COMPANY_CONFLICT = " ON CONFLICT (company_id, type, reference_id) WHERE company_id IS NOT NULL DO NOTHING";
// A month grant runs outside the webhook transaction: the share lock waits for a subscription switch in flight, then sees it.
// A legacy `monthly:YYYY-MM` row (one row of the whole plan amount) already covers every tier up to its amount.
const MONTH_STEP = COMPANY_INSERT + "(SELECT id FROM companies WHERE id = $2 AND credit_period_start IS NULL FOR SHARE) c WHERE NOT EXISTS (SELECT 1 FROM billing_ledger WHERE company_id = $2 AND user_id IS NULL AND type = 'PURCHASE' AND reference_id = $6 AND amount_micro_credits >= $7::bigint)" + COMPANY_CONFLICT;
const PERIOD_STEP = COMPANY_INSERT + "(SELECT $2::uuid AS id) c" + COMPANY_CONFLICT;
const COMPANY_GRANTS = "SELECT reference_id, amount_micro_credits FROM billing_ledger WHERE company_id = $1 AND user_id IS NULL AND type = 'PURCHASE' AND (reference_id = $2 OR reference_id LIKE $3)";

const EMPLOYER_TIERS = ["BASIC", "PRO", "ULTRA"];
const tiersUpTo = (plan: string): string[] => EMPLOYER_TIERS.slice(0, EMPLOYER_TIERS.indexOf(plan) + 1);
export const monthKey = (now: Date): string => "monthly:" + now.toISOString().slice(0, 7);
export const periodKey = (subscriptionId: string, start: Date): string => `period:${subscriptionId}:${Math.floor(start.getTime() / 1000)}`;

/**
 * Writes this month's plan credits once. Personal: one `monthly:YYYY-MM` row. Employer, only while the company has no
 * Stripe period (`companies.credit_period_start` is NULL): one row per tier up to the plan (`monthly:YYYY-MM:BASIC|PRO|ULTRA`),
 * each worth the gap to the tier below, so upgrades add only the difference whatever the order or concurrency of the calls.
 * Employer credits of a paid Stripe period come from `grantPeriod`. Safe to call on every billing read and enqueue.
 */
export const ensureMonthlyGrant = async (
  q: Query,
  input: { audience: "PERSONAL" | "EMPLOYER"; plan: string | null; ownerId: string; now: Date },
): Promise<void> => {
  const plan = input.plan?.trim() || (input.audience === "PERSONAL" ? "FREE" : "");
  const amount = grantMicro(input.audience, plan);
  if (amount <= 0) return;
  const month = monthKey(input.now);
  if (input.audience === "PERSONAL") {
    await q(USER_GRANT, [crypto.randomUUID(), input.ownerId, amount, month, input.now.toISOString()]);
    return;
  }
  let below = 0;
  for (const tier of tiersUpTo(plan)) {
    const total = EMPLOYER[tier] ?? 0;
    await q(MONTH_STEP, [crypto.randomUUID(), input.ownerId, total - below, month + ":" + tier, input.now.toISOString(), month, total]);
    below = total;
  }
};

/**
 * Writes the plan credits of one paid period (`period:<sub>:<start>:TIER`) once. Tiers within `carry` (what the replaced
 * period already granted) are 0-credit rows. Callers hold the company row lock of the webhook transaction.
 */
export const grantPeriod = async (
  q: Query,
  input: { companyId: string; subscriptionId: string; periodStart: Date; plan: string; carry: number; now: Date },
): Promise<void> => {
  const key = periodKey(input.subscriptionId, input.periodStart);
  let below = 0;
  for (const tier of tiersUpTo(input.plan)) {
    const total = EMPLOYER[tier] ?? 0;
    const amount = total <= input.carry ? 0 : total - Math.max(below, input.carry);
    await q(PERIOD_STEP, [crypto.randomUUID(), input.companyId, amount, key + ":" + tier, input.now.toISOString()]);
    below = total;
  }
};

const levelOf = (rows: Record<string, unknown>[], key: string): number => rows.reduce<number>((max, row) => {
  const ref = String(row.reference_id);
  const level = ref === key ? Number(row.amount_micro_credits) : EMPLOYER[ref.slice(key.length + 1)] ?? 0;
  return Math.max(max, level);
}, 0);

/** The highest plan amount `key` has granted (its top tier row, or a legacy whole-month row). */
export const keyLevel = async (q: Query, companyId: string, key: string): Promise<number> =>
  levelOf((await q(COMPANY_GRANTS, [companyId, key, key + ":%"])).rows, key);

/**
 * The plan amount a subscription's latest period granted. With no period rows, the company's subscription from before 0042
 * (`calendar`) had this month's credits; any other one was never adopted and granted nothing.
 */
export const subscriptionLevel = async (q: Query, companyId: string, subscriptionId: string, now: Date, calendar: boolean): Promise<number> => {
  const rows = (await q(COMPANY_GRANTS, [companyId, "", `period:${subscriptionId}:%`])).rows;
  if (rows.length === 0) return calendar ? keyLevel(q, companyId, monthKey(now)) : 0;
  const latest = Math.max(...rows.map((row) => Number(String(row.reference_id).split(":")[2])));
  const key = `period:${subscriptionId}:${latest}`;
  return levelOf(rows.filter((row) => String(row.reference_id).startsWith(key + ":")), key);
};
