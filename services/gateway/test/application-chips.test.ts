// APPLICATION chips name the applicant and their documents, only inside that company's conversation.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { handle, resetLimits, type Deps, type FrontEnv, type Query } from "../src/handler.ts";

const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONV = "11111111-1111-4111-8111-111111111111";
const APP = "44444444-4444-4444-8444-444444444444";
const MSG = "55555555-5555-4555-8555-555555555555";
const NOW = new Date("2026-11-10T00:00:00Z");

const env = (extra: Partial<FrontEnv> = {}): FrontEnv => ({
  DATABASE_URL: "postgres://example",
  APP_ENV: "production",
  ...extra,
});

const deps = (query: Query): Deps => ({ query, now: () => NOW });

const message = (applicationId: string) => ({
  id: MSG,
  conversation_id: CONV,
  role: "USER",
  text: "이 지원자요",
  attachments: [{ type: "APPLICATION", id: applicationId }, { type: "EVIDENCE", id: USER, title: "메모" }],
  operation_id: null,
  created_at: "2026-11-10T00:00:00Z",
});

const authRow = (rows: Record<string, unknown>[]) => ({
  id: USER, display_name: "Ada", locale: "ko",
  created_at: "2026-01-02T03:04:05Z", expires_at: "2099-01-01T00:00:00Z",
  hits: 1, conversation_id: CONV, rows,
});

test("a company conversation names the applicant and lists submitted documents", async () => {
  resetLimits();
  const seen: string[] = [];
  const query: Query = async (sql) => {
    seen.push(sql);
    if (sql.includes("FROM applications a")) {
      return [{ id: APP, display_name: "김태윤", document_titles: ["이력서", "포트폴리오.pdf"] }];
    }
    if (sql.includes("conversation_attachments")) return [];
    if (sql.includes("json_agg") || sql.includes("access_tokens")) return [authRow([message(APP)])];
    return [];
  };
  const res = await handle(new Request(`https://push-be.example/api/v1/conversations/${CONV}/messages`, {
    headers: { authorization: "Bearer secret-token" },
  }), env(), deps(query));
  assert.equal(res.status, 200, await res.clone().text());
  const body = await res.json() as { data: { attachments: Record<string, unknown>[] }[] };
  assert.deepEqual(body.data[0].attachments[0], {
    type: "APPLICATION",
    id: APP,
    title: "김태윤",
    documentTitles: ["이력서", "포트폴리오.pdf"],
  });
  assert.deepEqual(body.data[0].attachments[1], { type: "EVIDENCE", id: USER, title: "메모" });
  const chipSql = seen.find((sql) => sql.includes("FROM applications a"));
  assert.ok(chipSql);
  assert.match(chipSql, /c\.company_id IS NOT NULL/);
  assert.match(chipSql, /c\.company_id = p\.company_id/);
  assert.match(chipSql, /JOIN conversations c/);
});

test("an application from another company adds no title", async () => {
  resetLimits();
  const query: Query = async (sql) => {
    if (sql.includes("FROM applications a")) return [];
    if (sql.includes("conversation_attachments")) return [];
    if (sql.includes("json_agg") || sql.includes("access_tokens")) return [authRow([message(APP)])];
    return [];
  };
  const res = await handle(new Request(`https://push-be.example/api/v1/conversations/${CONV}/messages`, {
    headers: { authorization: "Bearer secret-token" },
  }), env(), deps(query));
  assert.equal(res.status, 200);
  const body = await res.json() as { data: { attachments: Record<string, unknown>[] }[] };
  assert.deepEqual(body.data[0].attachments[0], { type: "APPLICATION", id: APP });
  assert.equal(Object.hasOwn(body.data[0].attachments[0], "title"), false);
  assert.equal(Object.hasOwn(body.data[0].attachments[0], "documentTitles"), false);
});

const URL_ = process.env.BILLING_PG_URL;
let pg: { query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>; close: () => Promise<void> } | undefined;

before(async () => {
  if (!URL_) return;
  const { livePg } = await import("../../core-api/test/parity/pg.ts");
  pg = await livePg(URL_);
});
after(async () => { await pg?.close(); });

test("gateway chips stay inside the conversation's company", async (t) => {
  if (!pg) return t.skip("set BILLING_PG_URL to a migrated Postgres");
  const db = pg;
  const applicant = crypto.randomUUID();
  const member = crypto.randomUUID();
  const outsider = crypto.randomUUID();
  const company = crypto.randomUUID();
  const otherCompany = crypto.randomUUID();
  const posting = crypto.randomUUID();
  const otherPosting = crypto.randomUUID();
  const application = crypto.randomUUID();
  const otherApplication = crypto.randomUUID();
  const job = crypto.randomUUID();
  const otherJob = crypto.randomUUID();
  const companyConv = crypto.randomUUID();
  const otherConv = crypto.randomUUID();
  const personalConv = crypto.randomUUID();
  const insertUser = (id: string, name: string) => db.query(
    "INSERT INTO users (id, provider, provider_subject, display_name, plan) VALUES ($1, 'test', $1, $2, 'FREE')",
    [id, name]);
  await insertUser(applicant, "김태윤");
  await insertUser(member, "담당자");
  await insertUser(outsider, "다른회사");
  await db.query("INSERT INTO companies (id, name) VALUES ($1, 'chip co'), ($2, 'other co')", [company, otherCompany]);
  await db.query("INSERT INTO company_members (company_id, user_id, role) VALUES ($1, $2, 'ADMIN'), ($3, $4, 'ADMIN')", [company, member, otherCompany, outsider]);
  const insertPosting = (id: string, companyId: string) => db.query(
    `INSERT INTO job_postings (id, company, title, job_category, career_min, location, employment_type, description, company_id)
     VALUES ($1, 'co', 'role', 'dev', 0, 'Seoul', 'full_time', 'd', $2)`, [id, companyId]);
  await insertPosting(posting, company);
  await insertPosting(otherPosting, otherCompany);
  const insertJob = (id: string, postingId: string) => db.query(
    "INSERT INTO jobs (id, user_id, company, title, source_kind, source_text, source_posting_id) VALUES ($1, $2, 'co', 'role', 'TEXT', 's', $3)",
    [id, applicant, postingId]);
  await insertJob(job, posting);
  await insertJob(otherJob, otherPosting);
  const insertApp = (id: string, jobId: string) => db.query(
    "INSERT INTO applications (id, user_id, job_id, company, title, stage) VALUES ($1, $2, $3, 'co', 'role', 'APPLIED')",
    [id, applicant, jobId]);
  await insertApp(application, job);
  await insertApp(otherApplication, otherJob);
  await db.query(
    "INSERT INTO application_snapshots (id, application_id, title, content) VALUES (gen_random_uuid(), $1, '이력서', 'cv')",
    [application]);
  await db.query(
    "INSERT INTO application_files (id, application_id, file_name, mime_type, size, storage_key) VALUES (gen_random_uuid(), $1, '포트폴리오.pdf', 'application/pdf', 3, 'k')",
    [application]);
  const insertConv = (id: string, owner: string, companyId: string | null) => db.query(
    "INSERT INTO conversations (id, user_id, title, company_id) VALUES ($1, $2, 'chat', $3)",
    [id, owner, companyId]);
  await insertConv(companyConv, member, company);
  await insertConv(otherConv, outsider, otherCompany);
  await insertConv(personalConv, member, null);
  const insertMsg = (conversationId: string, owner: string, applicationId: string) => db.query(
    "INSERT INTO messages (id, user_id, conversation_id, role, text, attachments) VALUES (gen_random_uuid(), $1, $2, 'USER', '봐 주세요', $3::jsonb)",
    [owner, conversationId, JSON.stringify([{ type: "APPLICATION", id: applicationId }])]);
  await insertMsg(companyConv, member, application);
  await insertMsg(otherConv, outsider, application);
  await insertMsg(personalConv, member, application);
  await insertMsg(companyConv, member, otherApplication);

  const read = async (userId: string, conversationId: string) => {
    resetLimits();
    const res = await handle(new Request(`https://push-be.example/api/v1/conversations/${conversationId}/messages`, {
      headers: { authorization: "Bearer dev-token" },
    }), env({
      APP_ENV: "development",
      DEV_AUTH_TOKEN: "dev-token",
      DEV_USER_ID: userId,
    }), deps(async (sql, params) => (await db.query(sql, params)).rows));
    const text = await res.text();
    assert.equal(res.status, 200, text);
    const body = JSON.parse(text) as { data: { attachments: Record<string, unknown>[] }[] };
    return body.data.flatMap((row) => row.attachments);
  };

  const own = await read(member, companyConv);
  const named = own.find((item) => item.id === application);
  assert.equal(named?.title, "김태윤");
  assert.deepEqual(named?.documentTitles, ["이력서", "포트폴리오.pdf"]);
  const foreignOnOwnBoard = own.find((item) => item.id === otherApplication);
  assert.equal(foreignOnOwnBoard?.title, undefined);
  assert.equal(Object.hasOwn(foreignOnOwnBoard ?? {}, "documentTitles"), false);

  const other = await read(outsider, otherConv);
  assert.equal(other[0]?.title, undefined);
  assert.equal(Object.hasOwn(other[0] ?? {}, "documentTitles"), false);

  const personal = await read(member, personalConv);
  assert.equal(personal[0]?.type, "APPLICATION");
  assert.equal(personal[0]?.title, undefined);
  assert.equal(Object.hasOwn(personal[0] ?? {}, "documentTitles"), false);
});
