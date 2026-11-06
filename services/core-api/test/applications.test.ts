import assert from "node:assert/strict";
import { test } from "node:test";

import { postJson, recorder } from "../test-support/recorder.ts";

const NOW = new Date("2026-10-21T00:00:00Z");
const ENV = { APP_ENV: "production" };

const APP = "22222222-2222-4222-8222-222222222222";
const E1 = "e0000000-0000-4000-8000-000000000001";
const E2 = "e0000000-0000-4000-8000-000000000002";
const E3 = "e0000000-0000-4000-8000-000000000003";

test("a submission draft loads every document version in one query", async () => {
  const { handle } = await import("../src/handler.ts");
  const { calls, query } = recorder((sql) => {
    if (sql.includes("FROM applications WHERE id = $1")) return [{ id: APP, revision: 1, stage: "READY" }];
    if (sql.includes("FROM document_versions v")) {
      return [E1, E2, E3].map((id) => ({ id, application_id: APP, finalized_version_id: id }));
    }
    return null;
  });
  const res = await handle(postJson(`/api/v1/applications/${APP}/submission-drafts`, {
    expectedRevision: 1, mode: "MANUAL_RECORD", documentVersionIds: [E1, E2, E3],
  }, "00000000-0000-4000-8000-000000000005"), ENV, { query, now: () => NOW });
  assert.equal(res.status, 201);
  assert.equal(calls.filter((c) => c.sql.includes("FROM document_versions v")).length, 1);
});

test("application stage update falls back when stage_entered_at is missing", async () => {
  const { handle } = await import("../src/handler.ts");
  const missing = Object.assign(new Error('column "stage_entered_at" of relation "applications" does not exist'), { code: "42703" });
  const app = {
    id: APP, revision: 1, job_id: E1, company: "Acme", title: "Backend", stage: "DISCOVERED", notes: "",
    applied_at: null, next_action_at: null, imported: false, created_at: "2026-10-21T00:00:00Z", updated_at: "2026-10-21T00:00:00Z",
  };
  const { calls, query } = recorder((sql) => {
    if (sql.includes("FROM applications WHERE id = $1")) return [app];
    if (sql.includes("UPDATE applications") && sql.includes("stage_entered_at")) throw missing;
    if (sql.includes("UPDATE applications")) return [{ id: APP }];
    return null;
  });
  const res = await handle(new Request(`https://core.example/api/v1/applications/${APP}`, {
    method: "PATCH",
    headers: { authorization: "Bearer t", "content-type": "application/json" },
    body: JSON.stringify({ expectedRevision: 1, stage: "PREPARING" }),
  }), ENV, { query, now: () => NOW });
  assert.equal(res.status, 200);
  const updates = calls.filter((c) => c.sql.includes("UPDATE applications"));
  assert.equal(updates.length, 2);
  assert.match(updates[0].sql, /stage_entered_at/);
  assert.equal(updates[1].sql.includes("stage_entered_at"), false);
  const body = await res.json() as { data: { stage: string; stageEnteredAt: Record<string, string> } };
  assert.equal(body.data.stage, "PREPARING");
  assert.deepEqual(body.data.stageEnteredAt, {
    DISCOVERED: "2026-10-21T00:00:00Z",
    PREPARING: "2026-10-21T00:00:00Z",
  });
});

const FIT_APP = "22222222-2222-4222-8222-222222222223";
const FIT_DOC = "22222222-2222-4222-8222-222222222224";
const FIT_POSTING = "22222222-2222-4222-8222-222222222225";

const applicationRow = {
  id: FIT_APP, revision: 3, job_id: "22222222-2222-4222-8222-222222222226", company: "Acme", title: "Backend",
  stage: "APPLIED", notes: "", applied_at: "2026-10-01T00:00:00Z", next_action_at: null, imported: false,
  created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-02T00:00:00Z", fit_score: 80, user_id: "12345678-1234-4678-9234-567812345678",
};

const linkedFit = {
  fit_score: 6.9,
  parts: { techStack: 7, experienceLink: 6, careerLevel: 8, keyword: 5.5, domain: 7 },
  top_gap: "기술 스택",
  plan: "FREE",
  document_id: FIT_DOC,
  document_title: "이력서",
};

const getApp = (path: string): Request => new Request("https://core.example" + path, { headers: { authorization: "Bearer t" } });

test("returns fit from the document linked to the application", async () => {
  const { handle } = await import("../src/handler.ts");
  const { calls, query } = recorder((sql) => {
    if (sql.includes("posting_fit_cache") && sql.includes("d.application_id = a.id")) return [linkedFit];
    if (sql.includes("FROM applications")) return [applicationRow];
    return null;
  });
  const res = await handle(getApp(`/api/v1/applications/${FIT_APP}`), ENV, { query, now: () => NOW });
  assert.equal(res.status, 200);
  const body = await res.json() as { data: { fitScore: number; fit: { fitScore: number; parts: Record<string, number>; topGap: string; plan: string; reachable: number; documentId: string; documentTitle: string } } };
  assert.equal(body.data.fitScore, 80);
  assert.equal(body.data.fit.fitScore, 6.9);
  assert.deepEqual(body.data.fit.parts, { techStack: 7, experienceLink: 6, careerLevel: 8, keyword: 5.5, domain: 7 });
  assert.equal(body.data.fit.topGap, "기술 스택");
  assert.equal(body.data.fit.plan, "FREE");
  assert.equal(body.data.fit.reachable, 7.4);
  assert.equal(body.data.fit.documentId, FIT_DOC);
  assert.equal(body.data.fit.documentTitle, "이력서");
  assert.equal(calls.some((call) => call.sql.includes("INSERT INTO chat_jobs") || call.sql.includes("INSERT INTO posting_fit_cache")), false);
});

test("falls back to the latest user posting cache row when no document is linked", async () => {
  const { handle } = await import("../src/handler.ts");
  const { query } = recorder((sql) => {
    if (sql.includes("posting_fit_cache") && sql.includes("d.application_id = a.id")) return [];
    if (sql.includes("posting_fit_cache")) return [{ ...linkedFit, document_title: null, top_gap: "" }];
    if (sql.includes("FROM applications")) return [applicationRow];
    return null;
  });
  const res = await handle(getApp(`/api/v1/applications/${FIT_APP}`), ENV, { query, now: () => NOW });
  assert.equal(res.status, 200);
  const body = await res.json() as { data: { fit: { documentTitle: string | null; topGap: string; reachable: number } } };
  assert.equal(body.data.fit.documentTitle, null);
  assert.equal(body.data.fit.topGap, "");
  assert.equal(body.data.fit.reachable, 7.4);
});

test("omits fit when no cache row and keeps integer fitScore", async () => {
  const { handle } = await import("../src/handler.ts");
  const { query } = recorder((sql) => {
    if (sql.includes("posting_fit_cache")) return [];
    if (sql.includes("FROM applications")) return [applicationRow];
    return null;
  });
  const res = await handle(getApp(`/api/v1/applications/${FIT_APP}`), ENV, { query, now: () => NOW });
  assert.equal(res.status, 200);
  const body = await res.json() as { data: { fitScore: number; fit?: unknown } };
  assert.equal(body.data.fitScore, 80);
  assert.equal("fit" in body.data, false);
});

test("missing posting_fit_cache still returns the application", async () => {
  const { handle } = await import("../src/handler.ts");
  const missing = Object.assign(new Error('relation "posting_fit_cache" does not exist'), { code: "42P01" });
  const { query } = recorder((sql) => {
    if (sql.includes("posting_fit_cache")) throw missing;
    if (sql.includes("FROM applications")) return [applicationRow];
    return null;
  });
  const res = await handle(getApp(`/api/v1/applications/${FIT_APP}`), ENV, { query, now: () => NOW });
  assert.equal(res.status, 200);
  const body = await res.json() as { data: { id: string; fit?: unknown } };
  assert.equal(body.data.id, FIT_APP);
  assert.equal("fit" in body.data, false);
});

test("employer applicant payload has no fit", async () => {
  const { handle } = await import("../src/handler.ts");
  const posting = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const { calls, query } = recorder((sql) => {
    if (sql.includes("company_members")) return [{ id: posting }];
    if (sql.includes("FROM applications") || sql.includes("applications a")) return [{ ...applicationRow, fit_score: 80 }];
    return null;
  });
  const res = await handle(getApp(`/api/v1/postings/${posting}/applicants/${FIT_APP}`), ENV, { query, now: () => NOW });
  assert.equal(res.status, 200);
  const body = await res.json() as { data: { application: Record<string, unknown> } };
  assert.equal("fit" in body.data.application, false);
  assert.equal(calls.some((call) => call.sql.includes("posting_fit_cache")), false);
});

test("GET does not insert an ai job", async () => {
  const { handle } = await import("../src/handler.ts");
  const { calls, query } = recorder((sql) => {
    if (sql.includes("posting_fit_cache")) return [linkedFit];
    if (sql.includes("FROM applications")) return [applicationRow];
    return null;
  });
  const res = await handle(getApp(`/api/v1/applications/${FIT_APP}`), ENV, { query, now: () => NOW });
  assert.equal(res.status, 200);
  assert.equal(calls.some((call) => call.sql.includes("INSERT INTO chat_jobs") || call.sql.includes("INSERT INTO ai_jobs") || call.sql.includes("INSERT INTO posting_fit_cache")), false);
});

test("applied=true keeps submitted applications and returns the full total", async () => {
  const { handle } = await import("../src/handler.ts");
  const { calls, query } = recorder((sql) => {
    if (sql.includes("count(*)::int AS total")) return [{ total: 7 }];
    if (sql.includes("FROM applications")) return [{
      id: APP, revision: 1, job_id: E1, company: "Acme", title: "Backend", stage: "APPLIED", notes: "",
      applied_at: "2026-10-20T00:00:00Z", next_action_at: null, imported: false,
      created_at: "2026-10-21T00:00:00Z", updated_at: "2026-10-21T00:00:00Z",
    }];
    return null;
  });
  const res = await handle(new Request("https://core.example/api/v1/applications?applied=true", {
    headers: { authorization: "Bearer t" },
  }), ENV, { query, now: () => NOW });
  assert.equal(res.status, 200);
  const body = await res.json() as { data: unknown[]; page: { total: number } };
  assert.equal(body.data.length, 1);
  assert.equal(body.page.total, 7);
  const list = calls.find((c) => c.sql.includes("ORDER BY created_at DESC"));
  assert.match(list!.sql, /applied_at IS NOT NULL OR stage = ANY/);
  assert.deepEqual(list!.params[1], ["APPLIED", "SCREENING", "INTERVIEW", "OFFER", "ACCEPTED", "REJECTED", "WITHDRAWN"]);
});

test("without applied the list is unchanged and has no total", async () => {
  const { handle } = await import("../src/handler.ts");
  const { calls, query } = recorder();
  const res = await handle(new Request("https://core.example/api/v1/applications?applied=false", {
    headers: { authorization: "Bearer t" },
  }), ENV, { query, now: () => NOW });
  const body = await res.json() as { page: Record<string, unknown> };
  assert.equal("total" in body.page, false);
  assert.equal(calls.some((c) => c.sql.includes("count(*)")), false);
  const bad = await handle(new Request("https://core.example/api/v1/applications?applied=1", {
    headers: { authorization: "Bearer t" },
  }), ENV, { query, now: () => NOW });
  assert.equal(bad.status, 400);
});
