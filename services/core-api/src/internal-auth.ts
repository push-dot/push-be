import { timingSafeEqual } from "node:crypto";

import { one, type Query } from "./db.ts";
import { HttpError, parseUuid } from "./http.ts";
import type { CoreEnv, UserRow } from "./types.ts";

const ACT_AS_USER = `SELECT id, display_name, locale, plan, subscription_status, stripe_customer_id, period_ends_at, created_at, is_employer, email, provider,
  (SELECT company_id FROM company_members WHERE company_members.user_id = users.id) AS company_id,
  (SELECT role FROM company_members WHERE company_members.user_id = users.id) AS company_role
  FROM users WHERE id = $1`;

export type ActAs = { userId: string; companyId: string | null };

const ACT_AS_ROUTES: ReadonlyArray<readonly [RegExp, ReadonlySet<string>]> = [
  [/^\/api\/v1\/postings$/, new Set(["GET", "POST"])],
  [/^\/api\/v1\/postings\/[^/]+$/, new Set(["GET", "PATCH"])],
  [/^\/api\/v1\/postings\/[^/]+\/bookmark$/, new Set(["POST", "DELETE"])],
  [/^\/api\/v1\/postings\/[^/]+\/(apply|close)$/, new Set(["POST"])],
  [/^\/api\/v1\/postings\/[^/]+\/(applicants|applicant-counts)$/, new Set(["GET"])],
  [/^\/api\/v1\/postings\/[^/]+\/applicants\/[^/]+$/, new Set(["GET", "PATCH"])],
  [/^\/api\/v1\/me\/(bookmarks|offers)$/, new Set(["GET"])],
  [/^\/api\/v1\/me\/offers\/[^/]+$/, new Set(["GET"])],
  [/^\/api\/v1\/me\/offers\/[^/]+\/(accept|decline|messages)$/, new Set(["POST"])],
  [/^\/api\/v1\/me\/profile$/, new Set(["GET", "PATCH"])],
  [/^\/api\/v1\/calendar\/events$/, new Set(["GET", "POST"])],
  [/^\/api\/v1\/calendar\/events\/[^/]+$/, new Set(["PATCH", "DELETE"])],
  [/^\/api\/v1\/posts$/, new Set(["GET", "POST"])],
  [/^\/api\/v1\/posts\/[^/]+\/comments$/, new Set(["POST"])],
  [/^\/api\/v1\/users\/[^/]+\/follow$/, new Set(["POST"])],
  [/^\/api\/v1\/companies\/me(\/postings)?$/, new Set(["GET"])],
  [/^\/api\/v1\/profiles$/, new Set(["GET"])],
  [/^\/api\/v1\/profiles\/[^/]+$/, new Set(["GET"])],
  [/^\/api\/v1\/profiles\/[^/]+\/offer$/, new Set(["POST"])],
  [/^\/api\/v1\/documents\/[^/]+\/edits$/, new Set(["POST"])],
];

// AI calls that commit the user need the TOOL_ACTION card the user approved for the same target, in
// every access mode (약관 9조3항). services/ai/src/app/harness/policy.py ALWAYS_ASK_TOOLS asks for them.
// [method, path, tool, path keys, body keys]: every key must equal the approved tool_args.
const APPROVAL_ROUTES: ReadonlyArray<readonly [string, RegExp, string, readonly string[], readonly string[]]> = [
  ["POST", /^\/api\/v1\/postings\/([^/]+)\/apply$/, "apply_to_posting", ["posting_id"], []],
  ["POST", /^\/api\/v1\/me\/offers\/([^/]+)\/accept$/, "accept_offer", ["offer_id"], []],
  ["PATCH", /^\/api\/v1\/postings\/([^/]+)\/applicants\/([^/]+)$/, "change_applicant_stage", ["posting_id", "application_id"], ["stage"]],
];

const bodyFields = async (request: Request, keys: readonly string[]): Promise<Record<string, unknown>> => {
  if (!keys.length) return {};
  const body = await request.clone().json().catch(() => null) as Record<string, unknown> | null;
  // A missing field stays null, which no approved card contains.
  return Object.fromEntries(keys.map((key) => [key, body?.[key] ?? null]));
};

const APPROVED_TOOL = `SELECT 1 FROM approvals WHERE id = $1 AND user_id = $2 AND kind = 'TOOL_ACTION'
  AND tool_name = $3 AND status = 'APPROVED' AND option_id = 'approve' AND tool_args @> $4::jsonb`;

const requireApproval = async (request: Request, path: string, userId: string, query: Query): Promise<void> => {
  for (const [method, pattern, tool, keys, bodyKeys] of APPROVAL_ROUTES) {
    const match = request.method === method ? pattern.exec(path) : null;
    if (!match) continue;
    const approvalId = parseUuid(request.headers.get("x-push-approval") || "");
    const target = {
      ...Object.fromEntries(keys.map((key, i) => [key, decodeURIComponent(match[i + 1])])),
      ...await bodyFields(request, bodyKeys),
    };
    if (!approvalId || !(await one(query, APPROVED_TOOL, [approvalId, userId, tool, JSON.stringify(target)]))) {
      throw new HttpError(403, "APPROVAL_REQUIRED", "the user has not approved this action");
    }
  }
};

export const actAsAllowed = (method: string, path: string): boolean =>
  ACT_AS_ROUTES.some(([pattern, methods]) => methods.has(method) && pattern.test(path));

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
  if (!actAsAllowed(request.method, new URL(request.url).pathname)) {
    throw new HttpError(403, "FORBIDDEN", "not available to the ai worker");
  }
  const userId = parseUuid(request.headers.get("x-push-act-as") || "");
  if (!userId) throw new HttpError(401, "UNAUTHORIZED", "unauthorized");
  const companyRaw = hasCompany ? request.headers.get("x-push-company") || "" : "";
  const companyId = companyRaw ? parseUuid(companyRaw) : null;
  if (companyRaw && !companyId) throw new HttpError(401, "UNAUTHORIZED", "unauthorized");
  if (companyId) {
    const member = await one(query, "SELECT 1 FROM company_members WHERE user_id = $1 AND company_id = $2", [userId, companyId]);
    if (!member) throw new HttpError(403, "FORBIDDEN", "not a member of this company");
  }
  await requireApproval(request, new URL(request.url).pathname, userId, query);
  return { userId, companyId };
};

export const userForActAs = async (query: Query, acted: ActAs): Promise<UserRow> => {
  const row = await one(query, ACT_AS_USER, [acted.userId]);
  if (!row) throw new HttpError(401, "UNAUTHORIZED", "unauthorized");
  return userFrom(row, acted.companyId);
};
