// isNew, the apply-time profile snapshot, and hub tenure buckets on a real Postgres.
// CI test-db sets BILLING_PG_URL. A mock cannot show the flag flipping or a stale profile.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import type { Query } from "../src/db.ts";
import { handle, type CoreEnv } from "../src/handler.ts";
import { resetLimits } from "../src/ratelimit.ts";
import { livePg, type LivePg } from "./parity/pg.ts";

const URL_ = process.env.BILLING_PG_URL;
const env: CoreEnv = { APP_ENV: "production" };
const NOW = new Date("2026-11-10T00:00:00.000Z");

let pg: LivePg | undefined;
before(async () => { if (URL_) pg = await livePg(URL_); });
after(async () => { await pg?.close(); });

type Person = { name: string; employer: boolean; companyId: string | null; email: string };

const dbFor = (people: Map<string, Person>, userId: string): Query => async (sql, params = []) => {
  if (sql.includes("rate_limits")) return { rows: [{ hits: 1 }], rowCount: 1 };
  if (sql.includes("idempotency_keys")) return sql.includes("INSERT") ? { rows: [{ id: crypto.randomUUID() }], rowCount: 1 } : { rows: [], rowCount: 0 };
  if (sql.includes("access_tokens")) {
    const person = people.get(userId)!;
    return { rows: [{
      id: userId, display_name: person.name, locale: "ko", plan: "FREE", subscription_status: "NONE",
      stripe_customer_id: null, period_ends_at: null, created_at: "2026-11-01T00:00:00Z",
      token_expires_at: "2099-01-01T00:00:00Z", is_employer: person.employer, email: person.email,
      company_id: person.companyId, company_role: person.employer ? "ADMIN" : null,
    }], rowCount: 1 };
  }
  return pg!.query(sql, params);
};

const call = async (people: Map<string, Person>, userId: string, method: string, path: string, body?: unknown) => {
  resetLimits();
  const headers: Record<string, string> = { authorization: "Bearer followup-test" };
  if (method === "POST") headers["idempotency-key"] = crypto.randomUUID();
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await handle(new Request("https://core.example" + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  }), env, { query: dbFor(people, userId), now: () => NOW });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, text };
};

const insertUser = async (id: string, name: string, email: string, employer = false) => {
  await pg!.query(
    "INSERT INTO users (id, provider, provider_subject, display_name, email, is_employer, plan) VALUES ($1, 'test', $1, $2, $3, $4, 'FREE')",
    [id, name, email, employer]);
};

test("isNew clears on open, and the detail keeps the profile from apply time", async (t) => {
  if (!pg) return t.skip("set BILLING_PG_URL to a migrated Postgres");
  const applicant = crypto.randomUUID();
  const employer = crypto.randomUUID();
  const company = crypto.randomUUID();
  const posting = crypto.randomUUID();
  const oldPosting = crypto.randomUUID();
  const people = new Map<string, Person>([
    [applicant, { name: "김태윤", employer: false, companyId: null, email: `ada-${applicant.slice(0, 8)}@person.test` }],
    [employer, { name: "담당자", employer: true, companyId: company, email: `boss-${employer.slice(0, 8)}@company.test` }],
  ]);
  await insertUser(applicant, "김태윤", people.get(applicant)!.email);
  await insertUser(employer, "담당자", people.get(employer)!.email, true);
  await pg.query("INSERT INTO companies (id, name, verified_at) VALUES ($1, 'followup co', now())", [company]);
  await pg.query("INSERT INTO company_members (company_id, user_id, role) VALUES ($1, $2, 'ADMIN')", [company, employer]);
  const postingSql = `INSERT INTO job_postings (id, company, title, job_category, career_min, location, employment_type, description, company_id, status)
    VALUES ($1, 'followup co', 'backend', 'dev', 1, 'Seoul', 'full_time', 'build', $2, 'OPEN')`;
  await pg.query(postingSql, [posting, company]);
  await pg.query(postingSql, [oldPosting, company]);
  await pg.query(
    "INSERT INTO profiles (user_id, headline, job_category, tenure_years, careers, skills) VALUES ($1, $2, 'dev', 4, $3::jsonb, $4::jsonb)",
    [applicant, "제출한 한 줄", JSON.stringify([{ company: "옛회사", role: "백엔드" }]), JSON.stringify(["Go"])]);

  const applied = await call(people, applicant, "POST", `/api/v1/postings/${posting}/apply`, {});
  assert.equal(applied.status, 201, applied.text);
  const applicationId = applied.body.data.id as string;
  const stored = await pg.query("SELECT applicant_snapshot FROM applications WHERE id = $1", [applicationId]);
  const snap = typeof stored.rows[0].applicant_snapshot === "string"
    ? JSON.parse(stored.rows[0].applicant_snapshot)
    : stored.rows[0].applicant_snapshot;
  assert.equal(snap.headline, "제출한 한 줄");
  assert.equal(snap.jobCategory, "dev");
  assert.equal(snap.tenureYears, 4);
  assert.deepEqual(snap.careers, [{ company: "옛회사", role: "백엔드" }]);
  assert.deepEqual(snap.skills, ["Go"]);
  assert.ok(snap.capturedAt);

  const before = await call(people, employer, "GET", `/api/v1/postings/${posting}/applicants`);
  assert.equal(before.status, 200, before.text);
  const fresh = before.body.data.find((row: { applicationId: string }) => row.applicationId === applicationId);
  assert.equal(fresh.isNew, true);

  const opened = await call(people, employer, "GET", `/api/v1/postings/${posting}/applicants/${applicationId}`);
  assert.equal(opened.status, 200, opened.text);
  assert.equal(opened.body.data.applicant.profileSource, "SUBMITTED");
  assert.equal(opened.body.data.applicant.headline, "제출한 한 줄");
  assert.equal(opened.body.data.applicant.displayName, "김태윤");

  await pg.query(
    "UPDATE profiles SET headline = $2, job_category = 'design', tenure_years = 9, careers = $3::jsonb, skills = $4::jsonb WHERE user_id = $1",
    [applicant, "지금 한 줄", JSON.stringify([{ company: "새회사" }]), JSON.stringify(["Rust"])]);
  await pg.query("UPDATE users SET display_name = $2, email = $3 WHERE id = $1", [applicant, "바뀐이름", `new-${applicant.slice(0, 8)}@person.test`]);

  const again = await call(people, employer, "GET", `/api/v1/postings/${posting}/applicants/${applicationId}`);
  assert.equal(again.body.data.applicant.profileSource, "SUBMITTED");
  assert.equal(again.body.data.applicant.headline, "제출한 한 줄");
  assert.equal(again.body.data.applicant.jobCategory, "dev");
  assert.equal(again.body.data.applicant.tenureYears, 4);
  assert.deepEqual(again.body.data.applicant.careers, [{ company: "옛회사", role: "백엔드" }]);
  assert.deepEqual(again.body.data.applicant.skills, ["Go"]);
  assert.equal(again.body.data.applicant.displayName, "바뀐이름");
  assert.equal(again.body.data.applicant.email, `new-${applicant.slice(0, 8)}@person.test`);
  assert.ok(again.body.data.applicant.capturedAt);

  const seen = await call(people, employer, "GET", `/api/v1/postings/${posting}/applicants`);
  const openedRow = seen.body.data.find((row: { applicationId: string }) => row.applicationId === applicationId);
  assert.equal(openedRow.isNew, false);

  const oldJob = crypto.randomUUID();
  const oldApp = crypto.randomUUID();
  await pg.query(
    "INSERT INTO jobs (id, user_id, company, title, source_kind, source_text, source_posting_id) VALUES ($1, $2, 'followup co', 'backend', 'TEXT', 's', $3)",
    [oldJob, applicant, oldPosting]);
  await pg.query(
    "INSERT INTO applications (id, user_id, job_id, company, title, stage, applied_at, applicant_snapshot) VALUES ($1, $2, $3, 'followup co', 'backend', 'APPLIED', now(), NULL)",
    [oldApp, applicant, oldJob]);
  const legacyList = await call(people, employer, "GET", `/api/v1/postings/${oldPosting}/applicants`);
  const legacyRow = legacyList.body.data.find((row: { applicationId: string }) => row.applicationId === oldApp);
  assert.equal(legacyRow.isNew, true);
  const legacy = await call(people, employer, "GET", `/api/v1/postings/${oldPosting}/applicants/${oldApp}`);
  assert.equal(legacy.status, 200, legacy.text);
  assert.equal(legacy.body.data.applicant.profileSource, "CURRENT");
  assert.equal(legacy.body.data.applicant.capturedAt, null);
  assert.equal(legacy.body.data.applicant.headline, "지금 한 줄");
  assert.equal(legacy.body.data.applicant.jobCategory, "design");
  assert.equal(legacy.body.data.applicant.tenureYears, 9);
  assert.equal(legacy.body.data.applicant.displayName, "바뀐이름");
  const afterOpen = await call(people, employer, "GET", `/api/v1/postings/${oldPosting}/applicants`);
  const openedLegacy = afterOpen.body.data.find((row: { applicationId: string }) => row.applicationId === oldApp);
  assert.equal(openedLegacy.isNew, false);
});

test("hub tenure 0 and 1-2 select those years, and legacy 0-2 still includes both", async (t) => {
  if (!pg) return t.skip("set BILLING_PG_URL to a migrated Postgres");
  const token = `tenure-${crypto.randomUUID().slice(0, 8)}`;
  const viewer = crypto.randomUUID();
  const years = [0, 1, 2, 6];
  const ids = years.map(() => crypto.randomUUID());
  await insertUser(viewer, "보는 사람", `${token}-viewer@person.test`);
  for (let i = 0; i < years.length; i += 1) {
    await insertUser(ids[i], `사람${years[i]}`, `${token}-${years[i]}@person.test`);
    await pg!.query(
      "INSERT INTO profiles (user_id, headline, job_category, tenure_years) VALUES ($1, $2, 'dev', $3)",
      [ids[i], `${token} 한 줄`, years[i]]);
  }
  const people = new Map<string, Person>([
    [viewer, { name: "보는 사람", employer: false, companyId: null, email: `${token}-viewer@person.test` }],
  ]);
  const found = async (tenure: string): Promise<Set<string>> => {
    const res = await call(people, viewer, "GET", `/api/v1/profiles?tenure=${encodeURIComponent(tenure)}&q=${encodeURIComponent(token)}&limit=100`);
    assert.equal(res.status, 200, res.text);
    return new Set(res.body.data.map((row: { userId: string }) => row.userId));
  };
  const none = await found("0");
  assert.equal(none.has(ids[0]), true);
  assert.equal(none.has(ids[1]), false);
  assert.equal(none.has(ids[2]), false);
  const mid = await found("1-2");
  assert.equal(mid.has(ids[0]), false);
  assert.equal(mid.has(ids[1]), true);
  assert.equal(mid.has(ids[2]), true);
  assert.equal(mid.has(ids[3]), false);
  const legacy = await found("0-2");
  assert.equal(legacy.has(ids[0]), true);
  assert.equal(legacy.has(ids[1]), true);
  assert.equal(legacy.has(ids[2]), true);
  assert.equal(legacy.has(ids[3]), false);
  const senior = await found("6-9");
  assert.equal(senior.has(ids[3]), true);
  assert.equal(senior.has(ids[2]), false);
});
