import assert from "node:assert/strict";
import { test } from "node:test";

import { handle, type CoreEnv, type Deps } from "../src/handler.ts";
import { resetLimits } from "../src/ratelimit.ts";

const USER = "12345678-1234-5678-1234-567812345678";
const COMPANY = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const POSTING = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const APP = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const APPLICANT = "99999999-9999-4999-8999-999999999999";
const NOW = "2026-10-21T00:00:00.000Z";

type Call = { sql: string; params: unknown[] };

const env = (): CoreEnv => ({ APP_ENV: "production", MANAGED_AI: "1", MANAGED_GO: "0" });
const deps = (query: Deps["query"]): Deps => ({ query, now: () => new Date(NOW) });
const empty = { rows: [] as Record<string, unknown>[], rowCount: 0 };

const authed = (seen: Call[], extra: Deps["query"]): Deps["query"] => async (sql, params = []) => {
  seen.push({ sql, params });
  if (sql.includes("rate_limits")) return { rows: [{ hits: 1 }], rowCount: 1 };
  if (sql.includes("access_tokens")) {
    return {
      rows: [{
        id: USER, display_name: "Ada", locale: "ko", plan: "FREE", subscription_status: "NONE",
        created_at: NOW, token_expires_at: "2099-01-01T00:00:00Z", is_employer: true,
      }],
      rowCount: 1,
    };
  }
  if (sql.includes("idempotency_keys") && sql.includes("INSERT")) return { rows: [{ id: "1" }], rowCount: 1 };
  if (sql.includes("idempotency_keys")) return empty;
  if (sql.includes("is_employer") && sql.includes("FROM users") && !sql.includes("access_tokens")) {
    return { rows: [{ is_employer: true, display_name: "Ada" }], rowCount: 1 };
  }
  return extra(sql, params);
};

const missingColumn = (): Error => Object.assign(new Error('column "created_by" of relation "job_postings" does not exist'), { code: "42703" });

const get = (path: string): Request => new Request("https://core.example" + path, {
  headers: { authorization: "Bearer secret-token" },
});

const post = (path: string, body: unknown, key: string): Request => new Request("https://core.example" + path, {
  method: "POST",
  headers: {
    authorization: "Bearer secret-token",
    "content-type": "application/json",
    "idempotency-key": key,
  },
  body: JSON.stringify(body),
});

test("company postings count unseen applicants and name the creator", async () => {
  resetLimits();
  const seen: Call[] = [];
  const res = await handle(get("/api/v1/companies/me/postings"), env(), deps(authed(seen, async (sql) => {
    if (sql.includes("SELECT company_id FROM company_members")) return { rows: [{ company_id: COMPANY }], rowCount: 1 };
    if (sql.includes("count(*)") && sql.includes("job_postings") && !sql.includes("company_seen_at")) {
      return { rows: [{ total: 1 }], rowCount: 1 };
    }
    if (sql.includes("company_seen_at") && sql.includes("created_by")) {
      return {
        rows: [{
          id: POSTING, company: "Acme", title: "Backend", created_at: NOW, revision: 1,
          new_applicant_count: 3, created_by_name: "Ada", status: "OPEN", closed_at: null,
        }],
        rowCount: 1,
      };
    }
    return empty;
  })));
  assert.equal(res.status, 200);
  const body = await res.json() as { data: { newApplicantCount: number; createdBy: { displayName: string } | null }[] };
  assert.equal(body.data[0].newApplicantCount, 3);
  assert.deepEqual(body.data[0].createdBy, { displayName: "Ada" });
  const list = seen.find((call) => call.sql.includes("company_seen_at") && call.sql.includes("ORDER BY"));
  assert.ok(list);
  assert.match(list.sql, /to_jsonb\(a\) ->> 'company_seen_at'/);
  assert.match(list.sql, /to_jsonb\(p\) ->> 'created_by'/);
});

test("opening an applicant marks it seen once", async () => {
  resetLimits();
  const seen: Call[] = [];
  const res = await handle(get(`/api/v1/postings/${POSTING}/applicants/${APP}`), env(), deps(authed(seen, async (sql) => {
    if (sql.includes("company_members") && sql.includes("job_postings")) return { rows: [{ id: POSTING }], rowCount: 1 };
    if (sql.includes("FROM applications")) {
      return { rows: [{ id: APP, user_id: APPLICANT, stage: "APPLIED", revision: 1, applied_at: NOW, notes: "secret" }], rowCount: 1 };
    }
    if (sql.includes("UPDATE") && sql.includes("company_seen_at")) return empty;
    if (sql.includes("FROM users")) return { rows: [{ display_name: "Bea", email: "bea@push.app" }], rowCount: 1 };
    return empty;
  })));
  assert.equal(res.status, 200);
  const body = await res.json() as { data: { application: { notes?: string } } };
  assert.equal(Object.hasOwn(body.data.application, "notes"), false);
  const update = seen.find((call) => call.sql.includes("UPDATE") && call.sql.includes("company_seen_at"));
  assert.ok(update);
  assert.equal(update.params[0], APP);
  assert.equal(update.params[1], NOW);

  resetLimits();
  const legacy = await handle(get(`/api/v1/postings/${POSTING}/applicants/${APP}`), env(), deps(authed([], async (sql) => {
    if (sql.includes("company_members") && sql.includes("job_postings")) return { rows: [{ id: POSTING }], rowCount: 1 };
    if (sql.includes("FROM applications")) {
      return { rows: [{ id: APP, user_id: APPLICANT, stage: "APPLIED", revision: 1, applied_at: NOW }], rowCount: 1 };
    }
    if (sql.includes("company_seen_at")) throw missingColumn();
    if (sql.includes("FROM users")) return { rows: [{ display_name: "Bea", email: "bea@push.app" }], rowCount: 1 };
    return empty;
  })));
  assert.equal(legacy.status, 200);
});

test("create stores created_by and retries when the column is missing", async () => {
  resetLimits();
  const seen: Call[] = [];
  const res = await handle(post("/api/v1/postings", {
    title: "Backend",
    jobCategory: "dev",
    careerMin: 1,
    careerMax: 3,
    location: "서울",
    employmentType: "full_time",
    description: "Build APIs",
  }, "33333333-3333-4333-8333-333333333333"), env(), deps(authed(seen, async (sql) => {
    if (sql.includes("verified_at IS NOT NULL")) return { rows: [{ id: COMPANY, name: "Acme" }], rowCount: 1 };
    if (sql.includes("INSERT INTO job_postings") && sql.includes("created_by")) throw missingColumn();
    return empty;
  })));
  assert.equal(res.status, 201);
  const body = await res.json() as { data: { createdBy: { displayName: string } | null; newApplicantCount?: number } };
  assert.deepEqual(body.data.createdBy, { displayName: "Ada" });
  assert.equal(body.data.newApplicantCount, 0);
  const inserts = seen.filter((call) => call.sql.includes("INSERT INTO job_postings"));
  assert.equal(inserts.length, 2);
  assert.match(inserts[0].sql, /created_by/);
  assert.equal(inserts[0].params.at(-1), USER);
  assert.doesNotMatch(inserts[1].sql, /created_by/);
  assert.doesNotMatch(inserts[0].sql, /company_user_id/);
});

test("a public posting detail omits the company-only applicant counters", async () => {
  resetLimits();
  const res = await handle(new Request(`https://core.example/api/v1/postings/${POSTING}`), env(), deps(async (sql) => {
    if (sql.includes("rate_limits")) return { rows: [{ hits: 1 }], rowCount: 1 };
    if (sql.includes("FROM job_postings")) {
      return { rows: [{ id: POSTING, company: "Acme", title: "Backend", created_at: NOW, applicant_count: 4, closed_at: null }], rowCount: 1 };
    }
    return empty;
  }));
  assert.equal(res.status, 200);
  const body = await res.json() as { data: { applicantCount: number; newApplicantCount?: number } };
  assert.equal(body.data.applicantCount, 4);
  assert.equal(Object.hasOwn(body.data, "newApplicantCount"), false);
});
