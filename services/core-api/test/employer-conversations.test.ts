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
