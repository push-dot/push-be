import assert from "node:assert/strict";
import { test } from "node:test";

import { postJson, recorder } from "../test-support/recorder.ts";

const NOW = new Date("2026-10-21T00:00:00Z");
const ENV = { APP_ENV: "production" };

const E1 = "e0000000-0000-4000-8000-000000000001";
const E2 = "e0000000-0000-4000-8000-000000000002";
const E3 = "e0000000-0000-4000-8000-000000000003";

test("create accepts HUB_PROFILE and a hub profile exports its latest version", async () => {
  const { handle } = await import("../src/handler.ts");
  const APP = "a0000000-0000-4000-8000-000000000001";
  const DOC = "d0000000-0000-4000-8000-000000000010";
  const VER = "d0000000-0000-4000-8000-000000000011";
  const { calls, query } = recorder((sql) => {
    if (sql.includes("FROM applications")) return [{ id: APP }];
    if (sql.includes("FROM documents WHERE id")) return [{
      id: DOC, revision: 1, application_id: null, title: "Push 프로필", kind: "HUB_PROFILE",
      template: "SIMPLE", language: "ko", status: "DRAFT", latest_version_id: VER,
      finalized_version_id: null, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z",
    }];
    if (sql.includes("FROM document_versions")) return [{
      id: VER, document_id: DOC, number: 1, content: { type: "doc" },
      blocks: [{ id: "b1", text: "허브 본문" }], created_at: "2026-10-01T00:00:00Z",
    }];
    return null;
  });
  const created = await handle(postJson("/api/v1/documents", {
    applicationId: APP, title: "Push 프로필", kind: "HUB_PROFILE", template: "SIMPLE", language: "ko",
  }, "00000000-0000-4000-8000-000000000010"), ENV, { query, now: () => NOW });
  assert.equal(created.status, 201);
  const exported = await handle(postJson(`/api/v1/documents/${DOC}/exports`, {
    versionId: VER, format: "PDF", rendererVersion: "1",
  }, "00000000-0000-4000-8000-000000000011"), ENV, { query, now: () => NOW });
  assert.equal(exported.status, 201);
  assert.equal(calls.some((call) => call.sql.includes("INSERT INTO document_exports")), true);

  const { query: resumeQuery } = recorder((sql) => {
    if (sql.includes("FROM documents WHERE id")) return [{
      id: DOC, revision: 1, application_id: APP, title: "이력서", kind: "RESUME",
      template: "SIMPLE", language: "ko", status: "DRAFT", latest_version_id: VER,
      finalized_version_id: null, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z",
    }];
    if (sql.includes("FROM document_versions")) return [{
      id: VER, document_id: DOC, number: 1, content: {}, blocks: [], created_at: "2026-10-01T00:00:00Z",
    }];
    return null;
  });
  const blocked = await handle(postJson(`/api/v1/documents/${DOC}/exports`, {
    versionId: VER, format: "PDF", rendererVersion: "1",
  }, "00000000-0000-4000-8000-000000000012"), ENV, { query: resumeQuery, now: () => NOW });
  assert.equal(blocked.status, 422);
});

test("a hub profile converts to the default profile or an application profile", async () => {
  const { handle } = await import("../src/handler.ts");
  const DOC = "d0000000-0000-4000-8000-000000000020";
  const VER = "d0000000-0000-4000-8000-000000000021";
  const APP = "a0000000-0000-4000-8000-000000000021";
  const doc = {
    id: DOC, revision: 2, application_id: null, title: "Push 프로필", kind: "HUB_PROFILE",
    template: "SIMPLE", language: "ko", status: "DRAFT", latest_version_id: VER,
    finalized_version_id: null, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z",
  };
  const { calls, query } = recorder((sql) => {
    if (sql.includes("FROM documents WHERE id")) return [doc];
    if (sql.includes("FROM document_versions")) return [{
      id: VER, document_id: DOC, number: 1, content: {}, blocks: [{ id: "b1", text: "백엔드" }],
      created_at: "2026-10-01T00:00:00Z",
    }];
    if (sql.includes("FROM profiles")) return [{ display_name: "Ada", skills: ["Go"] }];
    return null;
  });
  const hub = await handle(postJson(`/api/v1/documents/${DOC}/profile`, {
    target: "hub",
  }, "00000000-0000-4000-8000-000000000021"), ENV, { query, now: () => NOW });
  assert.equal(hub.status, 200);
  const hubBody = await hub.json() as { data: { target: string; documentId: string; profileUserId: string } };
  assert.equal(hubBody.data.target, "hub");
  assert.equal(hubBody.data.documentId, DOC);
  assert.equal(typeof hubBody.data.profileUserId, "string");
  const update = calls.find((call) => call.sql.includes("UPDATE profiles SET headline"));
  assert.equal(update?.params[1], "Push 프로필");
  assert.equal(update?.params[2], "백엔드");
  assert.equal(update?.sql.includes("careers"), false);

  const { calls: appCalls, query: appQuery } = recorder((sql) => {
    if (sql.includes("FROM documents WHERE id")) return [{ ...doc, revision: 2 }];
    if (sql.includes("FROM applications")) return [{ id: APP }];
    if (sql.startsWith("UPDATE documents")) return [{ id: DOC }];
    return null;
  });
  const linked = await handle(postJson(`/api/v1/documents/${DOC}/profile`, {
    target: "application", applicationId: APP, expectedRevision: 2,
  }, "00000000-0000-4000-8000-000000000022"), ENV, { query: appQuery, now: () => NOW });
  assert.equal(linked.status, 200);
  const linkedBody = await linked.json() as { data: { target: string; applicationId: string } };
  assert.equal(linkedBody.data.target, "application");
  assert.equal(linkedBody.data.applicationId, APP);
  const wrote = appCalls.find((call) => call.sql.startsWith("UPDATE documents"));
  assert.equal(wrote?.params.includes(APP), true);
  assert.equal(wrote?.sql.includes("kind"), false);
});

test("create accepts CAREER_STATEMENT and rejects an unknown kind", async () => {
  const { handle } = await import("../src/handler.ts");
  const APP = "a0000000-0000-4000-8000-000000000001";
  const { calls, query } = recorder((sql) => {
    if (sql.includes("FROM applications")) return [{ id: APP }];
    return null;
  });
  const created = await handle(postJson("/api/v1/documents", {
    applicationId: APP, title: "경력기술서", kind: "CAREER_STATEMENT", template: "SIMPLE", language: "ko",
  }, "00000000-0000-4000-8000-000000000008"), ENV, { query, now: () => NOW });
  assert.equal(created.status, 201);
  const body = await created.json() as { data: { kind: string } };
  assert.equal(body.data.kind, "CAREER_STATEMENT");
  const insert = calls.find((call) => call.sql.includes("INSERT INTO documents"));
  assert.equal(insert?.params.includes("CAREER_STATEMENT"), true);

  const { query: rejectQuery } = recorder((sql) => {
    if (sql.includes("FROM applications")) return [{ id: APP }];
    return null;
  });
  const rejected = await handle(postJson("/api/v1/documents", {
    applicationId: APP, title: "경력기술서", kind: "LETTER", template: "SIMPLE", language: "ko",
  }, "00000000-0000-4000-8000-000000000009"), ENV, { query: rejectQuery, now: () => NOW });
  assert.equal(rejected.status, 400);
});

test("an export result can be recorded only once even when two reports race", async () => {
  const { handle } = await import("../src/handler.ts");
  const DOC = "d0000000-0000-4000-8000-000000000001";
  const EXP = "d0000000-0000-4000-8000-000000000002";
  const { query } = recorder((sql) => {
    if (sql.startsWith("SELECT") && sql.includes("FROM document_exports")) {
      return [{ id: EXP, document_id: DOC, version_id: E1, format: "PDF", template: "SIMPLE", content: {}, blocks: [], content_hash: "h", status: "READY_TO_RENDER", renderer_version: "1", created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z" }];
    }
    // The other report already moved the row out of READY_TO_RENDER.
    if (sql.startsWith("UPDATE document_exports")) return sql.includes("status = 'READY_TO_RENDER'") ? [] : [{ id: EXP }];
    return null;
  });
  const res = await handle(postJson(`/api/v1/documents/${DOC}/exports/${EXP}/result`, {
    sha256: "x", byteLength: 1, status: "SUCCEEDED",
  }, "00000000-0000-4000-8000-000000000006"), ENV, { query, now: () => NOW });
  assert.equal(res.status, 409);
});

test("a new document version verifies all cited evidence in one query", async () => {
  const { handle } = await import("../src/handler.ts");
  const DOC = "d0000000-0000-4000-8000-000000000003";
  const { calls, query } = recorder((sql, params) => {
    if (sql.startsWith("SELECT") && sql.includes("FROM documents WHERE id = $1")) return [{ id: DOC, revision: 1, status: "DRAFT", title: "t", kind: "RESUME", template: "SIMPLE", created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z" }];
    if (sql.includes("FROM career_evidence")) return [E1, E2, E3].map((id) => ({ id, source_text: "Go and Postgres", archived: false }));
    if (sql.startsWith("WITH upd AS")) return [{ number: 2 }];
    if (sql.includes("INSERT INTO ai_jobs")) return [{ id: params[0], queue: params[2] }];
    return null;
  });
  const blocks = [E1, E2, E3].map((eid, i) => ({ id: "b" + i, text: "Go", evidenceRefs: [{ evidenceId: eid, start: 0, end: 2 }, { evidenceId: E1, start: 3, end: 6 }] }));
  const content = { type: "doc", content: blocks.map((b) => ({ type: "paragraph", attrs: { blockId: b.id }, content: [{ type: "text", text: b.text }] })) };
  const res = await handle(postJson(`/api/v1/documents/${DOC}/versions`, { expectedRevision: 1, content, blocks }, "00000000-0000-4000-8000-000000000007"),
    ENV, { query, now: () => NOW });
  assert.equal(res.status, 201);
  assert.equal(calls.filter((c) => c.sql.includes("FROM career_evidence")).length, 1);
});
