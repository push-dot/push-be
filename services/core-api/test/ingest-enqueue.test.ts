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

const JOB = "10000000-0000-4000-8000-000000000001";
const POSTING = "20000000-0000-4000-8000-000000000001";
const APP = "30000000-0000-4000-8000-000000000001";

const savedJob = {
  id: JOB, revision: 1, company: "Acme", title: "Backend", source_kind: "TEXT", source_url: null,
  source_text: "TypeScript", requirements: [], preferred: [], keywords: [], risks: [], deadline: null,
  language: "ko", archived: false, created_at: "2026-10-21T00:00:00Z", updated_at: "2026-10-21T00:00:00Z",
};

const patchJson = (path: string, body: unknown): Request => new Request("https://core.example" + path, {
  method: "PATCH",
  headers: { authorization: "Bearer t", "content-type": "application/json" },
  body: JSON.stringify(body),
});

test("patching a saved job enqueues an ingest job", async () => {
  resetLimits();
  const { calls, query } = recorder((sql, params) => {
    if (sql.startsWith("SELECT") && sql.includes("FROM jobs WHERE id")) return [savedJob];
    if (sql.startsWith("UPDATE jobs")) return [{ ...savedJob, revision: 2, title: "Staff" }];
    if (sql.includes("INSERT INTO ai_jobs")) return [{ id: params[0], queue: params[2] }];
    return null;
  });
  const res = await handle(patchJson(`/api/v1/jobs/${JOB}`, { expectedRevision: 1, title: "Staff" }), ENV, {
    query, now: () => new Date("2026-10-21T00:00:00Z"),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(jobPayload(calls), { jobId: JOB });
});

test("applying to a posting enqueues ingest for the created job only", async () => {
  resetLimits();
  const posting = { company: "Acme", title: "Backend", description: "Build", requirements: [], deadline: null };
  let applied = false;
  const { calls, query } = recorder((sql, params) => {
    if (sql.includes("FROM job_postings p WHERE p.id = $1")) return [posting];
    if (sql.includes("FROM applications a JOIN jobs j") && !sql.includes("INSERT")) {
      if (!applied) return [];
      return [{
        id: APP, revision: 1, job_id: JOB, company: "Acme", title: "Backend", stage: "APPLIED", notes: "",
        applied_at: "2026-10-21T00:00:00Z", next_action_at: null, imported: false,
        created_at: "2026-10-21T00:00:00Z", updated_at: "2026-10-21T00:00:00Z",
      }];
    }
    if (sql.startsWith("WITH job AS")) {
      applied = true;
      return [{ id: APP }];
    }
    if (sql.includes("INSERT INTO ai_jobs")) return [{ id: params[0], queue: params[2] }];
    return null;
  });
  const first = await handle(postJson(`/api/v1/postings/${POSTING}/apply`, {}, "00000000-0000-4000-8000-000000000021"), ENV, {
    query, now: () => new Date("2026-10-21T00:00:00Z"),
  });
  assert.equal(first.status, 201);
  const body = await first.json() as { data: { jobId: string } };
  assert.deepEqual(jobPayload(calls), { jobId: body.data.jobId });
  const before = calls.filter((call) => call.sql.includes("INSERT INTO ai_jobs")).length;
  const second = await handle(postJson(`/api/v1/postings/${POSTING}/apply`, {}, "00000000-0000-4000-8000-000000000022"), ENV, {
    query, now: () => new Date("2026-10-21T00:00:00Z"),
  });
  assert.equal(second.status, 201);
  assert.equal(calls.filter((call) => call.sql.includes("INSERT INTO ai_jobs")).length, before);
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
