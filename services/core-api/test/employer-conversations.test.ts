import assert from "node:assert/strict";
import { test } from "node:test";

import { handle, type CoreEnv, type Deps } from "../src/handler.ts";
import { resetLimits } from "../src/ratelimit.ts";

const USER = "12345678-1234-5678-1234-567812345678";
const COMPANY = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const POSTING = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const CONV = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const NOW = new Date("2026-10-18T00:00:00Z");
const KEY = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

const env = (extra: Partial<CoreEnv> = {}): CoreEnv => ({
  APP_ENV: "production",
  MANAGED_AI: "1",
  AI_ORIGIN: "http://ai.example",
  ...extra,
});

const deps = (query: Deps["query"]): Deps => ({ query, now: () => NOW });

const authRow = {
  id: USER,
  display_name: "Ada",
  locale: "ko",
  plan: "FREE",
  created_at: "2026-01-02T03:04:05Z",
  token_expires_at: "2099-01-01T00:00:00Z",
};

const headers = (extra: Record<string, string> = {}) => ({
  authorization: "Bearer secret-token",
  "idempotency-key": KEY,
  ...extra,
});

const post = (path: string, body: BodyInit, extra: Record<string, string> = {}) =>
  new Request("https://core.example" + path, { method: "POST", headers: headers(extra), body });

test("personal create without audience still inserts a user conversation", async () => {
  resetLimits();
  const sqls: string[] = [];
  const res = await handle(post("/api/v1/conversations", JSON.stringify({ title: "hello" }), {
    "content-type": "application/json",
  }), env(), deps(async (sql) => {
    sqls.push(sql);
    if (sql.includes("access_tokens")) return { rows: [authRow], rowCount: 1 };
    if (sql.includes("rate_limits")) return { rows: [{ hits: 1 }], rowCount: 1 };
    if (sql.includes("idempotency_keys") && sql.includes("INSERT")) return { rows: [{ id: "idem" }], rowCount: 1 };
    if (sql.includes("idempotency_keys") && sql.includes("UPDATE")) return { rows: [], rowCount: 1 };
    if (sql.includes("user_consents")) return { rows: [{ reference_data: true }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  }));
  assert.equal(res.status, 201);
  const body = await res.json() as { data: { title: string; applicationId: null } };
  assert.equal(body.data.title, "hello");
  assert.equal(body.data.applicationId, null);
  const insert = sqls.find((sql) => sql.includes("INSERT INTO conversations"));
  assert.equal(insert?.includes("company_id"), false);
  assert.equal(insert?.includes("posting_id"), false);
});

test("personal create without reference consent is 403 and does not insert", async () => {
  resetLimits();
  const sqls: string[] = [];
  const res = await handle(post("/api/v1/conversations", JSON.stringify({ title: "hello" }), {
    "content-type": "application/json",
    "idempotency-key": "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeee11",
  }), env(), deps(async (sql) => {
    sqls.push(sql);
    if (sql.includes("access_tokens")) return { rows: [authRow], rowCount: 1 };
    if (sql.includes("rate_limits")) return { rows: [{ hits: 1 }], rowCount: 1 };
    if (sql.includes("idempotency_keys") && sql.includes("INSERT")) return { rows: [{ id: "idem-consent" }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  }));
  assert.equal(res.status, 403);
  assert.equal((await res.json() as { error: { code: string } }).error.code, "CONSENT_REQUIRED");
  assert.equal(sqls.some((sql) => sql.includes("INSERT INTO conversations")), false);
});

test("a personal message without reference consent is 403 and an employer message is not", async () => {
  resetLimits();
  const personal = await handle(post("/api/v1/conversations/" + CONV + "/messages", JSON.stringify({
    text: "안녕",
    accessMode: "AUTO",
  }), {
    "content-type": "application/json",
    "idempotency-key": "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeee12",
  }), env(), deps(async (sql) => {
    if (sql.includes("access_tokens")) return { rows: [authRow], rowCount: 1 };
    if (sql.includes("rate_limits")) return { rows: [{ hits: 1 }], rowCount: 1 };
    if (sql.includes("idempotency_keys") && sql.includes("INSERT")) return { rows: [{ id: "idem-personal" }], rowCount: 1 };
    if (sql.includes("FROM conversations")) return { rows: [{ company_id: null, plan: null, verified_at: null }], rowCount: 1 };
    if (sql.includes("chat_jobs")) return { rows: [{ id: "job-personal" }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  }));
  assert.equal(personal.status, 403);
  assert.equal((await personal.json() as { error: { code: string } }).error.code, "CONSENT_REQUIRED");

  resetLimits();
  let queued = false;
  const employer = await handle(post("/api/v1/conversations/" + CONV + "/messages", JSON.stringify({
    text: "공고",
    accessMode: "AUTO",
  }), {
    "content-type": "application/json",
    "idempotency-key": "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeee13",
  }), env(), deps(async (sql) => {
    if (sql.includes("access_tokens")) return { rows: [authRow], rowCount: 1 };
    if (sql.includes("rate_limits")) return { rows: [{ hits: 1 }], rowCount: 1 };
    if (sql.includes("idempotency_keys") && sql.includes("INSERT")) return { rows: [{ id: "idem-employer" }], rowCount: 1 };
    if (sql.includes("idempotency_keys") && sql.includes("UPDATE")) return { rows: [], rowCount: 1 };
    if (sql.includes("chat_jobs")) {
      queued = true;
      return { rows: [{ id: "job-employer" }], rowCount: 1 };
    }
    if (sql.includes("co.verified_at")) {
      return { rows: [{ company_id: COMPANY, plan: "PRO", verified_at: NOW.toISOString() }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }));
  assert.equal(employer.status, 202);
  assert.equal(queued, true);
});

test("employer create without a verified company is 403 BUSINESS_NOT_VERIFIED", async () => {
  resetLimits();
  const res = await handle(post("/api/v1/conversations", JSON.stringify({
    audience: "EMPLOYER",
    title: "공고",
  }), { "content-type": "application/json" }), env(), deps(async (sql) => {
    if (sql.includes("access_tokens")) return { rows: [authRow], rowCount: 1 };
    if (sql.includes("rate_limits")) return { rows: [{ hits: 1 }], rowCount: 1 };
    if (sql.includes("idempotency_keys") && sql.includes("INSERT")) return { rows: [{ id: "idem" }], rowCount: 1 };
    if (sql.includes("company_members")) return { rows: [{ company_id: COMPANY, verified_at: null, plan: null }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  }));
  assert.equal(res.status, 403);
  assert.equal((await res.json() as { error: { code: string } }).error.code, "BUSINESS_NOT_VERIFIED");
});

test("verified employer create stores company_id and posting_id", async () => {
  resetLimits();
  let params: unknown[] = [];
  const res = await handle(post("/api/v1/conversations", JSON.stringify({
    audience: "EMPLOYER",
    title: "공고",
    postingId: POSTING,
  }), { "content-type": "application/json" }), env(), deps(async (sql, next) => {
    if (sql.includes("access_tokens")) return { rows: [authRow], rowCount: 1 };
    if (sql.includes("rate_limits")) return { rows: [{ hits: 1 }], rowCount: 1 };
    if (sql.includes("idempotency_keys") && sql.includes("INSERT")) return { rows: [{ id: "idem" }], rowCount: 1 };
    if (sql.includes("idempotency_keys") && sql.includes("UPDATE")) return { rows: [], rowCount: 1 };
    if (sql.includes("FROM job_postings") || sql.includes("FROM applications")) {
      return { rows: [{ id: POSTING }], rowCount: 1 };
    }
    if (sql.includes("company_members")) {
      return { rows: [{ company_id: COMPANY, verified_at: NOW.toISOString(), plan: null, role: "MEMBER" }], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO conversations")) {
      params = next ?? [];
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }));
  assert.equal(res.status, 201);
  assert.equal(params.includes(COMPANY), true);
  assert.equal(params.includes(POSTING), true);
});

test("BASIC pdf upload is 403 PLAN_REQUIRED", async () => {
  resetLimits();
  const sqls: string[] = [];
  const form = new FormData();
  form.append("file", new File(["%PDF-1.4"], "resume.pdf", { type: "application/pdf" }));
  const res = await handle(post("/api/v1/conversations/" + CONV + "/attachments", form), env(), deps(async (sql) => {
    sqls.push(sql);
    if (sql.includes("access_tokens")) return { rows: [authRow], rowCount: 1 };
    if (sql.includes("rate_limits")) return { rows: [{ hits: 1 }], rowCount: 1 };
    if (sql.includes("idempotency_keys") && sql.includes("INSERT")) return { rows: [{ id: "idem" }], rowCount: 1 };
    if (sql.includes("FROM conversations") || sql.includes("company_members")) {
      return { rows: [{ id: CONV, company_id: COMPANY, plan: "BASIC", verified_at: NOW.toISOString() }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }));
  assert.equal(res.status, 403);
  const body = await res.json() as { error: { code: string; details: { requiredPlan: string } } };
  assert.equal(body.error.code, "PLAN_REQUIRED");
  assert.equal(body.error.details.requiredPlan, "ULTRA");
  assert.equal(sqls.some((sql) => sql.includes("INSERT INTO conversation_attachments")), false);
});

test("a null company plan is not ULTRA for pdf upload", async () => {
  resetLimits();
  const form = new FormData();
  form.append("file", new File(["%PDF-1.4"], "resume.pdf", { type: "application/pdf" }));
  const res = await handle(post("/api/v1/conversations/" + CONV + "/attachments", form), env(), deps(async (sql) => {
    if (sql.includes("access_tokens")) return { rows: [authRow], rowCount: 1 };
    if (sql.includes("rate_limits")) return { rows: [{ hits: 1 }], rowCount: 1 };
    if (sql.includes("idempotency_keys") && sql.includes("INSERT")) return { rows: [{ id: "idem-null" }], rowCount: 1 };
    if (sql.includes("FROM conversations") || sql.includes("company_members")) {
      return { rows: [{ id: CONV, company_id: COMPANY, plan: null, verified_at: NOW.toISOString() }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }));
  assert.equal(res.status, 403);
  assert.equal((await res.json() as { error: { details: { requiredPlan: string } } }).error.details.requiredPlan, "ULTRA");
});

test("ULTRA pdf upload stores a conversation_attachments row", async () => {
  resetLimits();
  let params: unknown[] = [];
  const bytes = new TextEncoder().encode("%PDF-1.4");
  const form = new FormData();
  form.append("file", new File([bytes], "resume.pdf", { type: "application/pdf" }));
  const res = await handle(post("/api/v1/conversations/" + CONV + "/attachments", form), env(), deps(async (sql, next) => {
    if (sql.includes("access_tokens")) return { rows: [authRow], rowCount: 1 };
    if (sql.includes("rate_limits")) return { rows: [{ hits: 1 }], rowCount: 1 };
    if (sql.includes("idempotency_keys") && sql.includes("INSERT")) return { rows: [{ id: "idem-pdf" }], rowCount: 1 };
    if (sql.includes("idempotency_keys") && sql.includes("UPDATE")) return { rows: [], rowCount: 1 };
    if (sql.includes("INSERT INTO conversation_attachments")) {
      params = next ?? [];
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("FROM conversations") || sql.includes("company_members")) {
      return { rows: [{ id: CONV, company_id: COMPANY, plan: "ULTRA", verified_at: NOW.toISOString() }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }));
  assert.equal(res.status, 201);
  const body = await res.json() as { data: { id: string; fileName: string; mimeType: string } };
  assert.equal(typeof body.data.id, "string");
  assert.equal(body.data.fileName, "resume.pdf");
  assert.equal(body.data.mimeType, "application/pdf");
  assert.equal(params.includes(COMPANY), true);
  assert.equal(params.includes(CONV), true);
  assert.equal(params.includes("resume.pdf"), true);
  assert.equal(params.includes("application/pdf"), true);
  const stored = params.find((item) => item instanceof Uint8Array) as Uint8Array | undefined;
  assert.equal(stored?.byteLength, bytes.byteLength);
});

test("a message intent is stored on the chat job payload", async () => {
  resetLimits();
  let payload = "";
  const res = await handle(post("/api/v1/conversations/" + CONV + "/messages", JSON.stringify({
    text: "면접 준비",
    accessMode: "SUGGEST",
    intent: "interview",
    applicationId: POSTING,
  }), { "content-type": "application/json" }), env(), deps(async (sql, next) => {
    if (sql.includes("access_tokens")) return { rows: [authRow], rowCount: 1 };
    if (sql.includes("rate_limits")) return { rows: [{ hits: 1 }], rowCount: 1 };
    if (sql.includes("idempotency_keys") && sql.includes("INSERT")) return { rows: [{ id: "idem-msg" }], rowCount: 1 };
    if (sql.includes("idempotency_keys") && sql.includes("UPDATE")) return { rows: [], rowCount: 1 };
    if (sql.includes("chat_jobs")) {
      payload = String(next?.[3]);
      return { rows: [{ id: "job-1" }], rowCount: 1 };
    }
    if (sql.includes("user_consents")) return { rows: [{ reference_data: true }], rowCount: 1 };
    if (sql.includes("co.verified_at")) return { rows: [{ company_id: null, plan: null, verified_at: null }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  }));
  assert.equal(res.status, 202);
  const stored = JSON.parse(payload) as { intent: string; applicationId: string };
  assert.equal(stored.intent, "interview");
  assert.equal(stored.applicationId, POSTING);
});

test("archiving an employer conversation deletes its attachments", async () => {
  resetLimits();
  const sqls: string[] = [];
  const res = await handle(post("/api/v1/conversations/" + CONV + "/archive", JSON.stringify({
    expectedRevision: 1,
  }), { "content-type": "application/json" }), env(), deps(async (sql) => {
    sqls.push(sql);
    if (sql.includes("access_tokens")) return { rows: [authRow], rowCount: 1 };
    if (sql.includes("rate_limits")) return { rows: [{ hits: 1 }], rowCount: 1 };
    if (sql.includes("idempotency_keys") && sql.includes("INSERT")) return { rows: [{ id: "idem-arc" }], rowCount: 1 };
    if (sql.includes("idempotency_keys") && sql.includes("UPDATE")) return { rows: [], rowCount: 1 };
    if (sql.includes("FROM conversations")) {
      return {
        rows: [{
          id: CONV, revision: 1, application_id: null, title: "공고", pinned: false,
          company_id: COMPANY, created_at: "2026-01-02T03:04:05Z",
        }],
        rowCount: 1,
      };
    }
    if (sql.startsWith("UPDATE conversations")) {
      return {
        rows: [{
          id: CONV, revision: 2, application_id: null, title: "공고", pinned: false,
          created_at: "2026-01-02T03:04:05Z", updated_at: NOW.toISOString(),
        }],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 0 };
  }));
  assert.equal(res.status, 200);
  assert.equal(sqls.some((sql) => sql.includes("DELETE FROM conversation_attachments") && sql.includes("conversation_id")), true);
});

const messageBody = (intent: string) => JSON.stringify({
  text: "면접 준비",
  accessMode: "SUGGEST",
  intent,
});

test("a company member posts on a conversation they did not create", async () => {
  resetLimits();
  const res = await handle(post("/api/v1/conversations/" + CONV + "/messages", messageBody("general"), {
    "content-type": "application/json",
    "idempotency-key": "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeee1",
  }), env(), deps(async (sql) => {
    if (sql.includes("access_tokens")) return { rows: [authRow], rowCount: 1 };
    if (sql.includes("rate_limits")) return { rows: [{ hits: 1 }], rowCount: 1 };
    if (sql.includes("idempotency_keys") && sql.includes("INSERT")) return { rows: [{ id: "idem-team" }], rowCount: 1 };
    if (sql.includes("idempotency_keys") && sql.includes("UPDATE")) return { rows: [], rowCount: 1 };
    if (sql.includes("chat_jobs")) {
      if (!sql.includes("company_members")) return { rows: [], rowCount: 0 };
      return { rows: [{ id: "job-team" }], rowCount: 1 };
    }
    if (sql.includes("co.verified_at")) {
      return { rows: [{ company_id: COMPANY, plan: "PRO", verified_at: NOW.toISOString() }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }));
  assert.equal(res.status, 202);
});

test("a company member archives a conversation they did not create", async () => {
  resetLimits();
  const sqls: string[] = [];
  const res = await handle(post("/api/v1/conversations/" + CONV + "/archive", JSON.stringify({
    expectedRevision: 1,
  }), {
    "content-type": "application/json",
    "idempotency-key": "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeee2",
  }), env(), deps(async (sql) => {
    sqls.push(sql);
    if (sql.includes("access_tokens")) return { rows: [authRow], rowCount: 1 };
    if (sql.includes("rate_limits")) return { rows: [{ hits: 1 }], rowCount: 1 };
    if (sql.includes("idempotency_keys") && sql.includes("INSERT")) return { rows: [{ id: "idem-team-arc" }], rowCount: 1 };
    if (sql.includes("idempotency_keys") && sql.includes("UPDATE")) return { rows: [], rowCount: 1 };
    if (sql.includes("FROM conversations") && !sql.includes("company_members")) return { rows: [], rowCount: 0 };
    if (sql.startsWith("UPDATE conversations") && !sql.includes("company_members")) return { rows: [], rowCount: 0 };
    if (sql.includes("FROM conversations")) {
      return {
        rows: [{
          id: CONV, revision: 1, application_id: null, title: "공고", pinned: false,
          company_id: COMPANY, created_at: "2026-01-02T03:04:05Z",
        }],
        rowCount: 1,
      };
    }
    if (sql.startsWith("UPDATE conversations")) {
      return {
        rows: [{
          id: CONV, revision: 2, application_id: null, title: "공고", pinned: false,
          created_at: "2026-01-02T03:04:05Z", updated_at: NOW.toISOString(),
        }],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 0 };
  }));
  assert.equal(res.status, 200);
  assert.equal(sqls.some((sql) => sql.includes("DELETE FROM conversation_attachments")), true);
});

test("a non member cannot post or archive a company conversation", async () => {
  resetLimits();
  const query = async (sql: string) => {
    if (sql.includes("access_tokens")) return { rows: [authRow], rowCount: 1 };
    if (sql.includes("rate_limits")) return { rows: [{ hits: 1 }], rowCount: 1 };
    if (sql.includes("idempotency_keys") && sql.includes("INSERT")) return { rows: [{ id: "idem-out" }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
  const posted = await handle(post("/api/v1/conversations/" + CONV + "/messages", messageBody("general"), {
    "content-type": "application/json",
    "idempotency-key": "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeee3",
  }), env(), deps(query));
  assert.equal(posted.status, 404);
  assert.equal((await posted.json() as { error: { code: string } }).error.code, "NOT_FOUND");
  const archived = await handle(post("/api/v1/conversations/" + CONV + "/archive", JSON.stringify({
    expectedRevision: 1,
  }), {
    "content-type": "application/json",
    "idempotency-key": "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeee4",
  }), env(), deps(query));
  assert.equal(archived.status, 404);
});

const interviewOnPlan = async (plan: string | null, key: string) => {
  let inserted = false;
  const res = await handle(post("/api/v1/conversations/" + CONV + "/messages", messageBody("interview"), {
    "content-type": "application/json",
    "idempotency-key": key,
  }), env(), deps(async (sql) => {
    if (sql.includes("access_tokens")) return { rows: [authRow], rowCount: 1 };
    if (sql.includes("rate_limits")) return { rows: [{ hits: 1 }], rowCount: 1 };
    if (sql.includes("idempotency_keys") && sql.includes("INSERT")) return { rows: [{ id: key }], rowCount: 1 };
    if (sql.includes("chat_jobs")) {
      inserted = true;
      return { rows: [{ id: "job-locked" }], rowCount: 1 };
    }
    if (sql.includes("FROM conversations") || sql.includes("JOIN companies")) {
      return { rows: [{ id: CONV, company_id: COMPANY, plan, verified_at: NOW.toISOString() }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }));
  assert.equal(res.status, 403);
  const body = await res.json() as { error: { code: string; details: { requiredPlan: string } } };
  assert.equal(body.error.code, "PLAN_REQUIRED");
  assert.equal(body.error.details.requiredPlan, "PRO");
  assert.equal(inserted, false);
};

test("interview without ai on a BASIC company plan is 403 before enqueue", async () => {
  resetLimits();
  await interviewOnPlan("BASIC", "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeee5");
});

test("interview without ai on a null company plan is 403 before enqueue", async () => {
  resetLimits();
  await interviewOnPlan(null, "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeee6");
});

test("interview without ai on a PRO company plan is queued", async () => {
  resetLimits();
  let inserted = false;
  const res = await handle(post("/api/v1/conversations/" + CONV + "/messages", messageBody("interview"), {
    "content-type": "application/json",
    "idempotency-key": "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeee10",
  }), env(), deps(async (sql) => {
    if (sql.includes("access_tokens")) return { rows: [authRow], rowCount: 1 };
    if (sql.includes("rate_limits")) return { rows: [{ hits: 1 }], rowCount: 1 };
    if (sql.includes("idempotency_keys") && sql.includes("INSERT")) return { rows: [{ id: "idem-pro" }], rowCount: 1 };
    if (sql.includes("idempotency_keys") && sql.includes("UPDATE")) return { rows: [], rowCount: 1 };
    if (sql.includes("chat_jobs")) {
      inserted = true;
      return { rows: [{ id: "job-pro" }], rowCount: 1 };
    }
    if (sql.includes("FROM conversations") || sql.includes("JOIN companies")) {
      return { rows: [{ id: CONV, company_id: COMPANY, plan: "PRO", verified_at: NOW.toISOString() }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }));
  assert.equal(res.status, 202);
  assert.equal(inserted, true);
});

test("a missing posting id is 404 and a posting from another company still creates", async () => {
  resetLimits();
  let inserted = false;
  const missing = await handle(post("/api/v1/conversations", JSON.stringify({
    audience: "EMPLOYER",
    title: "공고",
    postingId: POSTING,
  }), {
    "content-type": "application/json",
    "idempotency-key": "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeee7",
  }), env(), deps(async (sql) => {
    if (sql.includes("access_tokens")) return { rows: [authRow], rowCount: 1 };
    if (sql.includes("rate_limits")) return { rows: [{ hits: 1 }], rowCount: 1 };
    if (sql.includes("idempotency_keys") && sql.includes("INSERT")) return { rows: [{ id: "idem-miss" }], rowCount: 1 };
    if (sql.includes("company_members")) {
      return { rows: [{ company_id: COMPANY, verified_at: NOW.toISOString(), plan: "PRO", role: "MEMBER" }], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO conversations")) {
      inserted = true;
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }));
  assert.equal(missing.status, 404);
  assert.equal((await missing.json() as { error: { code: string } }).error.code, "NOT_FOUND");
  assert.equal(inserted, false);

  let postingSql = "";
  const other = await handle(post("/api/v1/conversations", JSON.stringify({
    audience: "EMPLOYER",
    title: "참고 공고",
    postingId: POSTING,
  }), {
    "content-type": "application/json",
    "idempotency-key": "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeee8",
  }), env(), deps(async (sql, next) => {
    if (sql.includes("access_tokens")) return { rows: [authRow], rowCount: 1 };
    if (sql.includes("rate_limits")) return { rows: [{ hits: 1 }], rowCount: 1 };
    if (sql.includes("idempotency_keys") && sql.includes("INSERT")) return { rows: [{ id: "idem-other" }], rowCount: 1 };
    if (sql.includes("idempotency_keys") && sql.includes("UPDATE")) return { rows: [], rowCount: 1 };
    if (sql.includes("FROM job_postings")) {
      postingSql = sql;
      return { rows: [{ id: POSTING }], rowCount: 1 };
    }
    if (sql.includes("company_members")) {
      return { rows: [{ company_id: COMPANY, verified_at: NOW.toISOString(), plan: "PRO", role: "MEMBER" }], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO conversations")) {
      assert.equal((next ?? []).includes(POSTING), true);
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }));
  assert.equal(other.status, 201);
  assert.match(postingSql, /FROM job_postings/);
  assert.doesNotMatch(postingSql, /company_id/);
});

test("a missing application id on employer create is 404", async () => {
  resetLimits();
  let inserted = false;
  const res = await handle(post("/api/v1/conversations", JSON.stringify({
    audience: "EMPLOYER",
    title: "공고",
    applicationId: POSTING,
  }), {
    "content-type": "application/json",
    "idempotency-key": "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeee9",
  }), env(), deps(async (sql) => {
    if (sql.includes("access_tokens")) return { rows: [authRow], rowCount: 1 };
    if (sql.includes("rate_limits")) return { rows: [{ hits: 1 }], rowCount: 1 };
    if (sql.includes("idempotency_keys") && sql.includes("INSERT")) return { rows: [{ id: "idem-app" }], rowCount: 1 };
    if (sql.includes("company_members")) {
      return { rows: [{ company_id: COMPANY, verified_at: NOW.toISOString(), plan: "PRO", role: "MEMBER" }], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO conversations")) {
      inserted = true;
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }));
  assert.equal(res.status, 404);
  assert.equal(inserted, false);
});

test("an employer conversation cannot link an application outside the company", async () => {
  resetLimits();
  let applicationSql: { sql: string; params: unknown[] } | null = null;
  let inserted = false;
  const res = await handle(post("/api/v1/conversations", JSON.stringify({
    audience: "EMPLOYER",
    title: "지원자",
    applicationId: POSTING,
  }), {
    "content-type": "application/json",
    "idempotency-key": "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeea",
  }), env(), deps(async (sql, next) => {
    if (sql.includes("access_tokens")) return { rows: [authRow], rowCount: 1 };
    if (sql.includes("rate_limits")) return { rows: [{ hits: 1 }], rowCount: 1 };
    if (sql.includes("idempotency_keys") && sql.includes("INSERT")) return { rows: [{ id: "idem-scope" }], rowCount: 1 };
    if (sql.includes("FROM applications")) {
      applicationSql = { sql, params: next ?? [] };
      const scoped = sql.includes("p.company_id = $2") && (next ?? [])[1] === COMPANY;
      return scoped ? { rows: [], rowCount: 0 } : { rows: [{ id: POSTING }], rowCount: 1 };
    }
    if (sql.includes("company_members")) {
      return { rows: [{ company_id: COMPANY, verified_at: NOW.toISOString(), plan: "PRO", role: "MEMBER" }], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO conversations")) {
      inserted = true;
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }));
  assert.equal(res.status, 404);
  assert.equal(inserted, false);
  assert.ok(applicationSql);
});

test("delete removes the owner's conversation in one statement and hides another user's", async () => {
  resetLimits();
  const sqls: string[] = [];
  const res = await handle(new Request("https://core.example/api/v1/conversations/" + CONV, {
    method: "DELETE",
    headers: headers(),
  }), env(), deps(async (sql, params = []) => {
    sqls.push(sql);
    if (sql.includes("access_tokens")) return { rows: [authRow], rowCount: 1 };
    if (sql.includes("rate_limits")) return { rows: [{ hits: 1 }], rowCount: 1 };
    if (sql.includes("SELECT user_id, company_id")) {
      return { rows: [{ user_id: USER, company_id: null }], rowCount: 1 };
    }
    if (sql.startsWith("WITH owned AS")) {
      assert.equal(params[0], CONV);
      assert.equal(params[1], USER);
      return { rows: [{ id: CONV }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }));
  assert.equal(res.status, 204);
  const gone = sqls.find((sql) => sql.startsWith("WITH owned AS")) ?? "";
  assert.match(gone, /DELETE FROM chat_jobs/);
  assert.match(gone, /DELETE FROM messages/);
  assert.match(gone, /DELETE FROM workspace_files/);
  assert.match(gone, /DELETE FROM conversations/);
  assert.match(gone, /user_id = \$2/);

  resetLimits();
  const missing = await handle(new Request("https://core.example/api/v1/conversations/" + CONV, {
    method: "DELETE",
    headers: headers(),
  }), env(), deps(async (sql) => {
    if (sql.includes("access_tokens")) return { rows: [authRow], rowCount: 1 };
    if (sql.includes("rate_limits")) return { rows: [{ hits: 1 }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  }));
  assert.equal(missing.status, 404);
});

const deleteCall = (role: string | null, owner: string, sqls: string[]) => handle(new Request("https://core.example/api/v1/conversations/" + CONV, {
  method: "DELETE",
  headers: headers(),
}), env(), deps(async (sql) => {
  sqls.push(sql);
  if (sql.includes("access_tokens")) return { rows: [authRow], rowCount: 1 };
  if (sql.includes("rate_limits")) return { rows: [{ hits: 1 }], rowCount: 1 };
  if (sql.includes("SELECT user_id, company_id")) {
    return { rows: [{ user_id: owner, company_id: COMPANY }], rowCount: 1 };
  }
  if (sql.includes("SELECT role FROM company_members")) {
    return role ? { rows: [{ role }], rowCount: 1 } : { rows: [], rowCount: 0 };
  }
  if (sql.startsWith("WITH owned AS")) return { rows: [{ id: CONV }], rowCount: 1 };
  return { rows: [], rowCount: 0 };
}));

test("a company admin deletes a conversation they did not create", async () => {
  resetLimits();
  const sqls: string[] = [];
  const other = "99999999-9999-4999-8999-999999999999";
  const res = await deleteCall("ADMIN", other, sqls);
  assert.equal(res.status, 204);
  const gone = sqls.find((sql) => sql.startsWith("WITH owned AS")) ?? "";
  assert.match(gone, /company_id IS NOT NULL/);
  assert.equal(gone.includes("user_id = $2"), false);
});

test("the member who created a company conversation cannot delete it", async () => {
  resetLimits();
  const sqls: string[] = [];
  const res = await deleteCall("MEMBER", USER, sqls);
  assert.equal(res.status, 403);
  assert.equal((await res.json() as { error: { code: string } }).error.code, "FORBIDDEN");
  assert.equal(sqls.some((sql) => sql.startsWith("WITH owned AS")), false);
});

test("another company member cannot delete a company conversation", async () => {
  resetLimits();
  const sqls: string[] = [];
  const other = "99999999-9999-4999-8999-999999999999";
  const res = await deleteCall("MEMBER", other, sqls);
  assert.equal(res.status, 403);
  assert.equal((await res.json() as { error: { code: string } }).error.code, "FORBIDDEN");
  assert.equal(sqls.some((sql) => sql.startsWith("WITH owned AS")), false);
});

test("unarchive clears the flag and does not archive evidence", async () => {
  resetLimits();
  const sqls: string[] = [];
  const res = await handle(post("/api/v1/conversations/" + CONV + "/unarchive", JSON.stringify({
    expectedRevision: 1,
  }), { "content-type": "application/json", "idempotency-key": "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeec" }), env(), deps(async (sql) => {
    sqls.push(sql);
    if (sql.includes("access_tokens")) return { rows: [authRow], rowCount: 1 };
    if (sql.includes("rate_limits")) return { rows: [{ hits: 1 }], rowCount: 1 };
    if (sql.includes("idempotency_keys") && sql.includes("INSERT")) return { rows: [{ id: "idem-un" }], rowCount: 1 };
    if (sql.includes("FROM conversations")) {
      return { rows: [{ id: CONV, revision: 1, application_id: null, title: "t", pinned: false, company_id: COMPANY, created_at: "2026-01-02T03:04:05Z" }], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE conversations")) {
      return { rows: [{ id: CONV, revision: 2, application_id: null, title: "t", pinned: false, created_at: "2026-01-02T03:04:05Z", updated_at: NOW.toISOString() }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }));
  assert.equal(res.status, 200);
  const update = sqls.find((sql) => sql.startsWith("UPDATE conversations")) ?? "";
  assert.match(update, /archived = false/);
  assert.equal(sqls.some((sql) => sql.includes("career_evidence") || sql.includes("conversation_attachments")), false);
});

test("archiving archives orphaned evidence in one statement", async () => {
  resetLimits();
  const sqls: string[] = [];
  const res = await handle(post("/api/v1/conversations/" + CONV + "/archive", JSON.stringify({
    expectedRevision: 1,
  }), { "content-type": "application/json", "idempotency-key": "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeeb" }), env(), deps(async (sql) => {
    sqls.push(sql);
    if (sql.includes("access_tokens")) return { rows: [authRow], rowCount: 1 };
    if (sql.includes("rate_limits")) return { rows: [{ hits: 1 }], rowCount: 1 };
    if (sql.includes("idempotency_keys") && sql.includes("INSERT")) return { rows: [{ id: "idem-ev" }], rowCount: 1 };
    if (sql.includes("FROM conversations")) {
      return { rows: [{ id: CONV, revision: 1, application_id: null, title: "t", pinned: false, company_id: null, created_at: "2026-01-02T03:04:05Z" }], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE conversations")) {
      return { rows: [{ id: CONV, revision: 2, application_id: null, title: "t", pinned: false, created_at: "2026-01-02T03:04:05Z", updated_at: NOW.toISOString() }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }));
  assert.equal(res.status, 200);
  const evidence = sqls.filter((sql) => sql.includes("career_evidence"));
  assert.equal(evidence.length, 1);
  assert.match(evidence[0] ?? "", /^UPDATE career_evidence e SET archived = true/);
  assert.match(evidence[0] ?? "", /NOT IN/);
});

const withFetch = (query: Deps["query"]): Deps => ({ ...deps(query), fetch: (async () => new Response("{}")) as typeof fetch });

test("a personal message checks consent before usage", async () => {
  resetLimits();
  const sqls: string[] = [];
  const res = await handle(post("/api/v1/conversations/" + CONV + "/messages", JSON.stringify({
    text: "hi",
    ai: { provider: "OPENAI", model: "gpt", effort: "LOW" },
  }), { "content-type": "application/json", "idempotency-key": "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeec" }), env(), withFetch(async (sql) => {
    sqls.push(sql);
    if (sql.includes("access_tokens")) return { rows: [authRow], rowCount: 1 };
    if (sql.includes("rate_limits")) return { rows: [{ hits: 1 }], rowCount: 1 };
    if (sql.includes("idempotency_keys") && sql.includes("INSERT")) return { rows: [{ id: "idem-par" }], rowCount: 1 };
    if (sql.includes("user_consents")) return { rows: [{ reference_data: true }], rowCount: 1 };
    if (sql.includes("co.verified_at")) return { rows: [{ company_id: null, plan: null, verified_at: null }], rowCount: 1 };
    if (sql.includes("chat_jobs")) return { rows: [{ id: "job" }], rowCount: 1 };
    if (sql.includes("FROM users")) return { rows: [{ plan: "FREE" }], rowCount: 1 };
    if (sql.includes("ai_usage")) return { rows: [{ spent: 0 }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  }));
  assert.equal(res.status, 202);
  const consentAt = sqls.findIndex((sql) => sql.includes("user_consents"));
  const usageAt = sqls.findIndex((sql) => sql.includes("ai_usage"));
  assert.ok(consentAt >= 0 && usageAt > consentAt);
});

test("a personal user with no credits and no consent gets CONSENT_REQUIRED", async () => {
  resetLimits();
  const sqls: string[] = [];
  const res = await handle(post("/api/v1/conversations/" + CONV + "/messages", JSON.stringify({
    text: "hi",
    ai: { provider: "OPENAI", model: "gpt", effort: "LOW" },
  }), { "content-type": "application/json", "idempotency-key": "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeef" }), env(), deps(async (sql) => {
    sqls.push(sql);
    if (sql.includes("access_tokens")) return { rows: [authRow], rowCount: 1 };
    if (sql.includes("rate_limits")) return { rows: [{ hits: 1 }], rowCount: 1 };
    if (sql.includes("idempotency_keys") && sql.includes("INSERT")) return { rows: [{ id: "idem-broke" }], rowCount: 1 };
    if (sql.includes("co.verified_at")) return { rows: [{ company_id: null, plan: "FREE", verified_at: null }], rowCount: 1 };
    if (sql.includes("FROM users")) return { rows: [{ plan: "FREE" }], rowCount: 1 };
    if (sql.includes("ai_usage")) return { rows: [{ spent: 1_800_000 }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  }));
  assert.equal(res.status, 403);
  assert.equal((await res.json() as { error: { code: string } }).error.code, "CONSENT_REQUIRED");
  assert.equal(sqls.some((sql) => sql.includes("ai_usage")), false);
});

test("an oversized pdf upload is 413 before the form is parsed", async () => {
  resetLimits();
  const sqls: string[] = [];
  const res = await handle(post("/api/v1/conversations/" + CONV + "/attachments", "x", {
    "content-type": "multipart/form-data; boundary=b",
    "content-length": String(11 * 1024 * 1024),
    "idempotency-key": "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeed",
  }), env(), deps(async (sql) => {
    sqls.push(sql);
    if (sql.includes("access_tokens")) return { rows: [authRow], rowCount: 1 };
    if (sql.includes("rate_limits")) return { rows: [{ hits: 1 }], rowCount: 1 };
    if (sql.includes("idempotency_keys") && sql.includes("INSERT")) return { rows: [{ id: "idem-big" }], rowCount: 1 };
    if (sql.includes("FROM conversations")) return { rows: [{ id: CONV, company_id: COMPANY, plan: "ULTRA", verified_at: NOW.toISOString() }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  }));
  assert.equal(res.status, 413);
  assert.equal(sqls.some((sql) => sql.includes("INSERT INTO conversation_attachments")), false);
});
