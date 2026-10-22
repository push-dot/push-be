import { timingSafeEqual } from "node:crypto";

import { one, type Query } from "./db.ts";
import { HttpError, parseUuid } from "./http.ts";
import type { CoreEnv, UserRow } from "./types.ts";

const ACT_AS_USER = `SELECT id, display_name, locale, plan, subscription_status, stripe_customer_id, period_ends_at, created_at, is_employer, email, provider,
  (SELECT company_id FROM company_members WHERE company_members.user_id = users.id) AS company_id,
  (SELECT role FROM company_members WHERE company_members.user_id = users.id) AS company_role
  FROM users WHERE id = $1`;

export type ActAs = { userId: string; companyId: string | null };

const secretMatches = (presented: string, expected: string): boolean => {
  const left = Buffer.from(presented);
  const right = Buffer.from(expected);
  if (left.length !== right.length) {
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
};

const textOrNull = (value: unknown): string | null => (value == null || value === "" ? null : String(value));

const userFrom = (row: Record<string, unknown>, companyId: string | null): UserRow => ({
  id: String(row.id),
  displayName: String(row.display_name ?? ""),
  locale: String(row.locale ?? "ko"),
  email: row.email == null ? "" : String(row.email),
  provider: row.provider == null ? "" : String(row.provider),
  plan: String(row.plan ?? "FREE"),
  subscriptionStatus: String(row.subscription_status ?? "NONE"),
  stripeCustomerId: row.stripe_customer_id == null ? null : String(row.stripe_customer_id),
  periodEndsAt: row.period_ends_at == null ? null : String(row.period_ends_at),
  createdAt: String(row.created_at),
  accountType: row.is_employer === true || row.is_employer === "t" || row.is_employer === "true" || row.is_employer === 1 ? "EMPLOYER" : "PERSONAL",
  companyId: companyId ?? textOrNull(row.company_id),
  companyRole: textOrNull(row.company_role),
});

export const actAs = async (request: Request, env: CoreEnv, query: Query): Promise<ActAs | null> => {
  const hasSecret = request.headers.has("x-push-internal-secret");
  const hasAct = request.headers.has("x-push-act-as");
  const hasCompany = request.headers.has("x-push-company");
  if (!hasSecret && !hasAct && !hasCompany) return null;
  const expected = (env.INTERNAL_API_SECRET || "").trim();
  const presented = request.headers.get("x-push-internal-secret") || "";
  if (!expected || !secretMatches(presented, expected)) {
    throw new HttpError(401, "UNAUTHORIZED", "unauthorized");
  }
  if (!hasAct) return null;
  const userId = parseUuid(request.headers.get("x-push-act-as") || "");
  if (!userId) throw new HttpError(401, "UNAUTHORIZED", "unauthorized");
  const companyRaw = hasCompany ? request.headers.get("x-push-company") || "" : "";
  const companyId = companyRaw ? parseUuid(companyRaw) : null;
  if (companyRaw && !companyId) throw new HttpError(401, "UNAUTHORIZED", "unauthorized");
  if (companyId) {
    const member = await one(query, "SELECT 1 FROM company_members WHERE user_id = $1 AND company_id = $2", [userId, companyId]);
    if (!member) throw new HttpError(403, "FORBIDDEN", "not a member of this company");
  }
  return { userId, companyId };
};

export const userForActAs = async (query: Query, acted: ActAs): Promise<UserRow> => {
  const row = await one(query, ACT_AS_USER, [acted.userId]);
  if (!row) throw new HttpError(401, "UNAUTHORIZED", "unauthorized");
  return userFrom(row, acted.companyId);
};
