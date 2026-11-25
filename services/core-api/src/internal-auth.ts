import { timingSafeEqual } from "node:crypto";

import { one } from './db.ts';
import type { Query } from './db.ts';
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
// A company's writes that reach people outside it need their card too, whatever headers the call has:
// the posting's company or the actor's membership decides, not x-push-company.
// need() names the approved tool and the exact target its tool_args must contain, or null for no card.
type Json = string | number | boolean | null | Array<Json> | { [key: string]: Json };
type JsonObject = { [key: string]: Json };
type Need = { tool: string; target: JsonObject } | null;
type Asked = { match: RegExpExecArray; request: Request; query: Query; userId: string; companyId: string | null };
type ApprovalRoute = { method: string; pattern: RegExp; need: (asked: Asked) => Promise<Need> };

const isJsonObject = (value: unknown): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);

const jsonBody = async (request: Request): Promise<JsonObject> => {
  const body: unknown = await request.clone().json().catch(() => null);
  return isJsonObject(body) ? body : {};
};

const refuse = (): never => {
  throw new HttpError(403, "APPROVAL_REQUIRED", "the user has not approved this action");
};

const pathKeys = (match: RegExpExecArray, keys: ReadonlyArray<string>): JsonObject =>
  Object.fromEntries(keys.map((key, i) => [key, decodeURIComponent(match[i + 1])]));

// A missing field stays null, which no approved card contains.
const bodyKeys = (body: JsonObject, keys: ReadonlyArray<string>): JsonObject =>
  Object.fromEntries(keys.map((key) => [key, body[key] ?? null]));

const fixed = (tool: string, keys: ReadonlyArray<string>, fields: ReadonlyArray<string> = []) =>
  async ({ match, request }: Asked): Promise<Need> => ({ tool, target: { ...pathKeys(match, keys), ...bodyKeys(await jsonBody(request), fields) } });

const companyOf = async ({ query, userId, companyId }: Asked): Promise<string | null> => {
  if (companyId) {return companyId;}
  const row = await one(query, "SELECT company_id FROM company_members WHERE user_id = $1", [userId]);
  return row?.company_id ? String(row.company_id) : null;
};

const postingOf = async ({ match, query }: Asked): Promise<{ id: string; status: string } | null> => {
  const id = parseUuid(decodeURIComponent(match[1]));
  if (!id) {return null;}
  const row = await one(query, "SELECT status FROM job_postings WHERE id = $1 AND company_id IS NOT NULL", [id]);
  return row ? { id, status: String(row.status) } : null;
};

const onlyKeys = (body: JsonObject, allowed: ReadonlyArray<string>): void => {
  if (Object.keys(body).some((key) => !allowed.includes(key))) {refuse();}
};

// Publishing binds the one change it makes; editing a live posting binds the text it writes.
const postingPatch = async (asked: Asked): Promise<Need> => {
  const posting = await postingOf(asked);
  if (!posting) {return null;}
  const body = await jsonBody(asked.request);
  if ("status" in body) {
    if (body.status !== "OPEN") {refuse();}
    onlyKeys(body, ["status", "expectedRevision"]);
    return { tool: "publish_posting", target: { posting_id: posting.id } };
  }
  if (posting.status === "DRAFT") {return null;}
  onlyKeys(body, ["title", "description", "expectedRevision"]);
  const text = Object.fromEntries((["title", "description"] as const).flatMap((key) => (key in body ? [[key, body[key]]] : [])));
  return { tool: "update_published_posting", target: { posting_id: posting.id, ...text } };
};

const close = async (asked: Asked): Promise<Need> => {
  const posting = await postingOf(asked);
  return posting ? { tool: "close_posting", target: { posting_id: posting.id } } : null;
};

const asCompany = (tool: string, keys: ReadonlyArray<string>, fields: ReadonlyArray<string>) =>
  async (asked: Asked): Promise<Need> => ((await companyOf(asked)) ? fixed(tool, keys, fields)(asked) : null);

const APPROVAL_ROUTES: ReadonlyArray<ApprovalRoute> = [
  { method: "POST", pattern: /^\/api\/v1\/postings\/([^/]+)\/apply$/, need: fixed("apply_to_posting", ["posting_id"]) },
  { method: "POST", pattern: /^\/api\/v1\/me\/offers\/([^/]+)\/accept$/, need: fixed("accept_offer", ["offer_id"]) },
  { method: "PATCH", pattern: /^\/api\/v1\/postings\/([^/]+)\/applicants\/([^/]+)$/, need: fixed("change_applicant_stage", ["posting_id", "application_id"], ["stage"]) },
  { method: "PATCH", pattern: /^\/api\/v1\/postings\/([^/]+)$/, need: postingPatch },
  { method: "POST", pattern: /^\/api\/v1\/postings\/([^/]+)\/close$/, need: close },
  { method: "POST", pattern: /^\/api\/v1\/profiles\/([^/]+)\/offer$/, need: asCompany("send_offer", ["profile_id"], ["message"]) },
  { method: "POST", pattern: /^\/api\/v1\/posts$/, need: asCompany("create_company_post", [], ["category", "title", "body"]) },
];

const CONSUME_APPROVAL = `UPDATE approvals SET consumed_at = COALESCE(consumed_at, now()), consumed_key = $5::uuid
  WHERE id = $1 AND $2::uuid IN (user_id, decided_by) AND kind = 'TOOL_ACTION'
  AND tool_name = $3 AND status = 'APPROVED' AND option_id = 'approve' AND tool_args @> $4::jsonb
  AND (consumed_at IS NULL OR consumed_key = $5::uuid)
  RETURNING id`;

const requireApproval = async (request: Request, path: string, userId: string, companyId: string | null, query: Query): Promise<void> => {
  for (const route of APPROVAL_ROUTES) {
    const match = request.method === route.method ? route.pattern.exec(path) : null;
    if (!match) {continue;}
    const need = await route.need({ match, request, query, userId, companyId });
    if (!need) {continue;}
    const approvalId = parseUuid(request.headers.get("x-push-approval") || "");
    const retryKey = parseUuid(request.headers.get("idempotency-key") || "");
    if (!approvalId || !(await one(query, CONSUME_APPROVAL, [approvalId, userId, need.tool, JSON.stringify(need.target), retryKey]))) {
      refuse();
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

const isNil = (value: unknown): value is null | undefined => value === null || value === undefined;

const textOrNull = (value: unknown): string | null => (isNil(value) || value === "" ? null : String(value));

type UserColumns = {
  id?: unknown; display_name?: unknown; locale?: unknown; email?: unknown; provider?: unknown; plan?: unknown;
  subscription_status?: unknown; stripe_customer_id?: unknown; period_ends_at?: unknown; created_at?: unknown;
  is_employer?: unknown; company_id?: unknown; company_role?: unknown;
};

const userFrom = (row: UserColumns, companyId: string | null): UserRow => ({
  id: String(row.id),
  displayName: String(row.display_name ?? ""),
  locale: String(row.locale ?? "ko"),
  email: isNil(row.email) ? "" : String(row.email),
  provider: isNil(row.provider) ? "" : String(row.provider),
  plan: String(row.plan ?? "FREE"),
  subscriptionStatus: String(row.subscription_status ?? "NONE"),
  stripeCustomerId: isNil(row.stripe_customer_id) ? null : String(row.stripe_customer_id),
  periodEndsAt: isNil(row.period_ends_at) ? null : String(row.period_ends_at),
  createdAt: String(row.created_at),
  accountType: row.is_employer === true || row.is_employer === "t" || row.is_employer === "true" || row.is_employer === 1 ? "EMPLOYER" : "PERSONAL",
  companyId: companyId ?? textOrNull(row.company_id),
  companyRole: textOrNull(row.company_role),
});

export const actAs = async (request: Request, env: CoreEnv, query: Query): Promise<ActAs | null> => {
  const hasSecret = request.headers.has("x-push-internal-secret");
  const hasAct = request.headers.has("x-push-act-as");
  const hasCompany = request.headers.has("x-push-company");
  if (!hasSecret && !hasAct && !hasCompany) {return null;}
  const expected = (env.INTERNAL_API_SECRET || "").trim();
  const presented = request.headers.get("x-push-internal-secret") || "";
  if (!expected || !secretMatches(presented, expected)) {
    throw new HttpError(401, "UNAUTHORIZED", "unauthorized");
  }
  if (!hasAct) {return null;}
  if (!actAsAllowed(request.method, new URL(request.url).pathname)) {
    throw new HttpError(403, "FORBIDDEN", "not available to the ai worker");
  }
  const userId = parseUuid(request.headers.get("x-push-act-as") || "");
  if (!userId) {throw new HttpError(401, "UNAUTHORIZED", "unauthorized");}
  const companyRaw = hasCompany ? request.headers.get("x-push-company") || "" : "";
  const companyId = companyRaw ? parseUuid(companyRaw) : null;
  if (companyRaw && !companyId) {throw new HttpError(401, "UNAUTHORIZED", "unauthorized");}
  if (companyId) {
    const member = await one(query, "SELECT 1 FROM company_members WHERE user_id = $1 AND company_id = $2", [userId, companyId]);
    if (!member) {throw new HttpError(403, "FORBIDDEN", "not a member of this company");}
  }
  await requireApproval(request, new URL(request.url).pathname, userId, companyId, query);
  return { userId, companyId };
};

export const userForActAs = async (query: Query, acted: ActAs): Promise<UserRow> => {
  const row = await one(query, ACT_AS_USER, [acted.userId]);
  if (!row) {throw new HttpError(401, "UNAUTHORIZED", "unauthorized");}
  return userFrom(row, acted.companyId);
};
