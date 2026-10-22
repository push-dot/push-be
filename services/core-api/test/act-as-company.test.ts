import assert from "node:assert/strict";
import { test } from "node:test";

import { handle, type CoreEnv, type Deps } from "../src/handler.ts";
import { resetLimits } from "../src/ratelimit.ts";

const USER = "12345678-1234-5678-1234-567812345678";
const COMPANY = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OTHER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const POSTING = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const APPLICATION = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const NOW = "2026-10-21T00:00:00.000Z";
const SECRET = "internal-secret";

const env = (): CoreEnv => ({ APP_ENV: "production", INTERNAL_API_SECRET: SECRET });
const deps = (query: Deps["query"]): Deps => ({ query, now: () => new Date(NOW) });
const empty = { rows: [] as Record<string, unknown>[], rowCount: 0 };

const userRow = () => ({
  id: USER, display_name: "Ada", locale: "ko", plan: "PRO", subscription_status: "NONE",
  stripe_customer_id: null, period_ends_at: null, created_at: NOW, is_employer: true,
  email: "ada@push.app", provider: "email", company_id: COMPANY, company_role: "member",
});

const queryFor = (memberOf: string | null) => async (sql: string, params: unknown[] = []) => {
  if (sql.includes("rate_limits")) return { rows: [{ hits: 1 }], rowCount: 1 };
  if (sql.includes("SELECT 1") && sql.includes("company_members")) {
    return memberOf != null && params[0] === USER && params[1] === memberOf
      ? { rows: [{ ok: 1 }], rowCount: 1 }
      : empty;
  }
  if (sql.includes("FROM users") && sql.includes("display_name")) return { rows: [userRow()], rowCount: 1 };
  return empty;
};

const stageChange = (companyId: string): Request => new Request(
  `https://core.example/api/v1/postings/${POSTING}/applicants/${APPLICATION}`,
  {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      "x-push-internal-secret": SECRET,
      "x-push-act-as": USER,
      "x-push-company": companyId,
    },
    body: JSON.stringify({ stage: "INTERVIEW" }),
  },
);

test("act-as cannot change another company's applicant stage", async () => {
  resetLimits();
  const other = await handle(stageChange(OTHER), env(), deps(queryFor(COMPANY)));
  assert.equal(other.status, 403);
  assert.equal((await other.json() as { error: { code: string } }).error.code, "FORBIDDEN");

  resetLimits();
  const gone = await handle(stageChange(COMPANY), env(), deps(queryFor(null)));
  assert.equal(gone.status, 403);
  assert.equal((await gone.json() as { error: { code: string } }).error.code, "FORBIDDEN");
});
