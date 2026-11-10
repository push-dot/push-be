import assert from "node:assert/strict";
import { test } from "node:test";

import { handle, resetLimits, type Deps, type FrontEnv, type Query } from "../src/handler.ts";

const USER_A = "aaaaaaaa-0000-4000-8000-00000000000a";
const USER_B = "bbbbbbbb-0000-4000-8000-00000000000b";
const COMPANY = "cccccccc-0000-4000-8000-00000000000c";
const CONV = "cccccccc-2222-4222-8222-222222222222";
const JOB = "dddddddd-4444-4444-8444-444444444444";
const NOW = new Date("2026-10-18T00:00:00Z");

const env = (): FrontEnv => ({
  DATABASE_URL: "postgres://example",
  CORE: { async fetch() { throw new Error("core should not be called"); } },
  APP_ENV: "production",
  SSE_MAX_POLLS: "1",
});

type Job = { id: string; userId: string; status: string };

const userRow = (id: string): Record<string, unknown> => ({
  id,
  display_name: id === USER_A ? "Ada" : "Bea",
  locale: "ko",
  created_at: "2026-01-02T03:04:05Z",
  expires_at: "2099-01-01T00:00:00Z",
  is_employer: true,
  company_id: COMPANY,
  company_role: "MEMBER",
  hits: 1,
});

// Applies the cancel statement the way Postgres does: a company member can see
// the conversation, and the update hits only when the SQL keeps the job's creator.
function queryFor(caller: string, job: Job): Query {
  return async (sql, params = []) => {
    if (sql.startsWith("WITH auth") || (sql.includes("FROM access_tokens") && !sql.startsWith("WITH found"))) {
      return [userRow(caller)];
    }
    if (sql.includes("rate_limits")) return [{ hits: 1 }];
    if (!sql.startsWith("WITH found AS")) return [];
    const [convId, userId, companyId] = params as [string, string, string | null];
    if (convId !== CONV || companyId !== COMPANY) return [{ conversation_id: null, job_id: null, mine: null }];
    const active = job.status === "PENDING" || job.status === "RUNNING";
    if (!sql.includes("UPDATE chat_jobs")) {
      return [{ conversation_id: CONV, job_id: active ? job.id : null }];
    }
    if (!active) return [{ conversation_id: CONV, job_id: null, mine: null }];
    const restricts = sql.includes("j.user_id = $2::uuid") && sql.includes("AND user_id = $2::uuid");
    const mine = job.userId === userId;
    if (restricts && !mine) return [{ conversation_id: CONV, job_id: null, mine: false }];
    job.status = "CANCELLED";
    return [{ conversation_id: CONV, job_id: job.id, mine: true }];
  };
}

const deps = (query: Query): Deps => ({ query, sleep: async () => {}, now: () => NOW });

const cancel = (user: string, query: Query): Promise<Response> => handle(new Request(
  `https://push-be.example/api/v1/conversations/${CONV}/stream/cancel`,
  { method: "POST", headers: { authorization: `Bearer tok-${user}` } },
), env(), deps(query));

test("member B cannot cancel member A's running job; A can cancel their own", async () => {
  resetLimits();
  const job: Job = { id: JOB, userId: USER_A, status: "RUNNING" };
  const denied = await cancel(USER_B, queryFor(USER_B, job));
  assert.equal(denied.status, 403);
  assert.equal((await denied.json() as { error: { code: string } }).error.code, "FORBIDDEN");
  assert.equal(job.status, "RUNNING");

  resetLimits();
  const ok = await cancel(USER_A, queryFor(USER_A, job));
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { data: { jobId: JOB, status: "CANCELLED" } });
  assert.equal(job.status, "CANCELLED");
});
