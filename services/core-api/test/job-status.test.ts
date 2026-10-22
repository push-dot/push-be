import assert from "node:assert/strict";
import { test } from "node:test";

import { handle, type CoreEnv, type Deps } from "../src/handler.ts";
import { resetLimits } from "../src/ratelimit.ts";

const USER = "12345678-1234-5678-1234-567812345678";
const JOB = "abababab-abab-4bab-8bab-abababababab";
const DOC = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const POSTING = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const EVIDENCE = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const KEY = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const NOW = new Date("2026-10-22T00:00:00Z");

const env: CoreEnv = { APP_ENV: "production" };

const authRow = {
  id: USER,
  display_name: "Ada",
  locale: "ko",
  plan: "FREE",
  created_at: "2026-01-02T03:04:05Z",
  token_expires_at: "2099-01-01T00:00:00Z",
};

type Row = Record<string, unknown>;

const scripted = (rows: (sql: string, params: unknown[]) => Row | null, sqls: string[] = []): Deps => ({
  now: () => NOW,
  query: async (sql, params = []) => {
    sqls.push(sql);
    if (sql.includes("access_tokens")) return { rows: [authRow], rowCount: 1 };
    if (sql.includes("rate_limits")) return { rows: [{ hits: 1 }], rowCount: 1 };
    if (sql.includes("idempotency_keys") && sql.includes("INSERT")) return { rows: [{ id: "idem" }], rowCount: 1 };
    if (sql.includes("idempotency_keys")) return { rows: [], rowCount: 1 };
    const row = rows(sql, params);
    return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
  },
});

const funded = (sql: string, params: unknown[]): Row | null => {
  if (sql.includes("count(*)") && sql.includes("FROM ai_jobs")) return { n: 0 };
  if (sql.includes("idempotency_key") && sql.includes("FROM ai_jobs")) return null;
  if (sql.includes("billing_ledger")) return { balance_after: "100000000" };
  if (sql.includes("ai_usage")) return { settled: "0" };
  if (sql.includes("SUM") && sql.includes("credit_reservations")) return { reserved: "0" };
  if (sql.includes("INSERT INTO ai_jobs")) return { id: String(params[0]), queue: String(params[2]) };
  return null;
};

const request = (method: string, path: string, body?: unknown) => new Request("https://core.example" + path, {
  method,
  headers: { authorization: "Bearer t", "idempotency-key": KEY, "content-type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
});

test("job status hides other users' jobs with 404", async () => {
  resetLimits();
  const params: unknown[][] = [];
  const res = await handle(request("GET", `/api/v1/ai/jobs/${JOB}`), env, scripted((sql, p) => {
    if (sql.includes("FROM ai_jobs")) params.push(p);
    return null;
  }));
  assert.equal(res.status, 404);
  assert.deepEqual(params[0], [JOB, USER]);
});

test("job status returns the owner's job body", async () => {
  resetLimits();
  const res = await handle(request("GET", `/api/v1/ai/jobs/${JOB}`), env, scripted((sql) => {
    if (!sql.includes("FROM ai_jobs")) return null;
    return {
      id: JOB,
      type: "fit",
      status: "DONE",
      payload: { progress: { step: 2 } },
      result: { fitScore: 80 },
      error: null,
      created_at: "2026-10-22T00:00:00Z",
      updated_at: "2026-10-22T00:00:01Z",
    };
  }));
  assert.equal(res.status, 200);
  const body = await res.json() as { data: Row };
  assert.equal(body.data.status, "DONE");
  assert.deepEqual(body.data.result, { fitScore: 80 });
  assert.deepEqual(body.data.progress, { step: 2 });
});

test("posting fit returns 202 with jobId on the document queue", async () => {
  resetLimits();
  const sqls: string[] = [];
  const res = await handle(request("POST", `/api/v1/postings/${POSTING}/fit`, { documentId: DOC }), env, scripted((sql, p) => {
    if (sql.includes("FROM documents d JOIN job_postings")) return { id: DOC };
    return funded(sql, p);
  }, sqls));
  assert.equal(res.status, 202);
  const body = await res.json() as { data: { jobId: string } };
  assert.match(body.data.jobId, /^[0-9a-f-]{36}$/);
  assert.ok(sqls.some((sql) => sql.includes("INSERT INTO outbox")));
});

test("posting fit for someone else's document is 404 and enqueues nothing", async () => {
  resetLimits();
  const sqls: string[] = [];
  const res = await handle(request("POST", `/api/v1/postings/${POSTING}/fit`, { documentId: DOC }), env, scripted(funded, sqls));
  assert.equal(res.status, 404);
  assert.equal(sqls.some((sql) => sql.includes("INSERT INTO ai_jobs")), false);
});

test("document generate returns 202 with jobId and keeps the request body for the worker", async () => {
  resetLimits();
  const payloads: string[] = [];
  const res = await handle(request("POST", `/api/v1/documents/${DOC}/generate`, {
    expectedRevision: 3,
    evidenceIds: [EVIDENCE],
  }), env, scripted((sql, p) => {
    if (sql.includes("FROM documents WHERE id")) return { id: DOC };
    if (sql.includes("INSERT INTO ai_jobs")) payloads.push(String(p[7]));
    return funded(sql, p);
  }));
  assert.equal(res.status, 202);
  assert.deepEqual(JSON.parse(payloads[0]), {
    documentId: DOC,
    kind: "generate",
    body: { expectedRevision: 3, evidenceIds: [EVIDENCE] },
  });
});

test("document generate rejects a missing expectedRevision with 400", async () => {
  resetLimits();
  const res = await handle(request("POST", `/api/v1/documents/${DOC}/generate`, { evidenceIds: [] }), env, scripted(funded));
  assert.equal(res.status, 400);
});

test("queue over threshold answers 429 QUEUE_BUSY with Retry-After", async () => {
  resetLimits();
  const res = await handle(request("POST", `/api/v1/postings/${POSTING}/fit`, { documentId: DOC }), env, scripted((sql, p) => {
    if (sql.includes("FROM documents d JOIN job_postings")) return { id: DOC };
    if (sql.includes("count(*)")) return { n: 10_000 };
    return funded(sql, p);
  }));
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("retry-after"), "30");
  assert.equal((await res.json() as { error: { code: string } }).error.code, "QUEUE_BUSY");
});
