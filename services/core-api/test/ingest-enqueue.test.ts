import assert from "node:assert/strict";
import { test } from "node:test";

import { handle } from "../src/handler.ts";
import { resetLimits } from "../src/ratelimit.ts";
import { postJson, recorder } from "../test-support/recorder.ts";

const ENV = { APP_ENV: "production" };
const DOC = "d0000000-0000-4000-8000-000000000003";
const COMPANY = "c0000000-0000-4000-8000-000000000001";

const jobPayload = (calls: { sql: string; params: unknown[] }[]) => {
  const job = calls.find((call) => call.sql.includes("INSERT INTO ai_jobs"));
  assert.ok(job);
  assert.equal(job.params[1], "ingest");
  assert.equal(job.params[2], "q:ingest");
  assert.equal(calls.some((call) => call.sql.includes("INSERT INTO credit_reservations")), false);
  return JSON.parse(String(job.params[7])) as Record<string, string>;
};

test("creating career evidence enqueues an ingest job", async () => {
  resetLimits();
  const { calls, query } = recorder((sql, params) => {
    if (sql.includes("INSERT INTO ai_jobs")) return [{ id: params[0], queue: params[2] }];
    return null;
  });
  const res = await handle(postJson("/api/v1/career-evidence", {
    kind: "CAREER", title: "결제 장애", sourceText: "서버 타임아웃을 줄였다",
  }, "00000000-0000-4000-8000-000000000011"), ENV, { query, now: () => new Date("2026-10-21T00:00:00Z") });
  assert.equal(res.status, 201);
  const body = await res.json() as { data: { id: string } };
  assert.deepEqual(jobPayload(calls), { evidenceId: body.data.id });
});

test("creating a job enqueues an ingest job", async () => {
  resetLimits();
  const { calls, query } = recorder((sql, params) => {
    if (sql.includes("INSERT INTO ai_jobs")) return [{ id: params[0], queue: params[2] }];
    return null;
  });
  const res = await handle(postJson("/api/v1/jobs", {
    company: "Acme", title: "Backend", sourceKind: "TEXT", sourceText: "TypeScript", language: "ko",
  }, "00000000-0000-4000-8000-000000000012"), ENV, { query, now: () => new Date("2026-10-21T00:00:00Z") });
  assert.equal(res.status, 201);
  const body = await res.json() as { data: { id: string } };
  assert.deepEqual(jobPayload(calls), { jobId: body.data.id });
});

test("saving a document version enqueues an ingest job", async () => {
  resetLimits();
  const { calls, query } = recorder((sql, params) => {
    if (sql.startsWith("SELECT") && sql.includes("FROM documents WHERE id = $1")) {
      return [{
        id: DOC, revision: 1, status: "DRAFT", title: "이력서", kind: "RESUME",
        template: "SIMPLE", created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z",
      }];
    }
    if (sql.startsWith("WITH upd AS")) return [{ number: 2 }];
    if (sql.includes("INSERT INTO ai_jobs")) return [{ id: params[0], queue: params[2] }];
    return null;
  });
  const blocks = [{ id: "b1", text: "결제 서버를 운영했다", evidenceRefs: [] }];
  const content = {
    type: "doc",
    content: [{ type: "paragraph", attrs: { blockId: "b1" }, content: [{ type: "text", text: blocks[0].text }] }],
  };
  const res = await handle(postJson(`/api/v1/documents/${DOC}/versions`, {
    expectedRevision: 1, content, blocks,
  }, "00000000-0000-4000-8000-000000000013"), ENV, { query, now: () => new Date("2026-10-21T00:00:00Z") });
  assert.equal(res.status, 201);
  assert.deepEqual(jobPayload(calls), { documentId: DOC });
});

test("creating a posting enqueues an ingest job", async () => {
  resetLimits();
  const { calls, query } = recorder((sql, params) => {
    if (sql.includes("verified_at IS NOT NULL")) return [{ id: COMPANY, name: "Acme" }];
    if (sql.includes("INSERT INTO ai_jobs")) return [{ id: params[0], queue: params[2] }];
    return null;
  });
  const res = await handle(postJson("/api/v1/postings", {
    title: "Backend", jobCategory: "dev", careerMin: 1, careerMax: 3, location: "서울",
    employmentType: "full_time", description: "결제 API",
  }, "00000000-0000-4000-8000-000000000014"), ENV, { query, now: () => new Date("2026-10-21T00:00:00Z") });
  assert.equal(res.status, 201);
  const body = await res.json() as { data: { id: string } };
  assert.deepEqual(jobPayload(calls), { postingId: body.data.id });
});
