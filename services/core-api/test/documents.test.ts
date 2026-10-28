import assert from "node:assert/strict";
import { test } from "node:test";

import { postJson, recorder } from "../test-support/recorder.ts";

const NOW = new Date("2026-10-21T00:00:00Z");
const ENV = { APP_ENV: "production" };

const E1 = "e0000000-0000-4000-8000-000000000001";
const E2 = "e0000000-0000-4000-8000-000000000002";
const E3 = "e0000000-0000-4000-8000-000000000003";

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
  const { calls, query } = recorder((sql) => {
    if (sql.startsWith("SELECT") && sql.includes("FROM documents WHERE id = $1")) return [{ id: DOC, revision: 1, status: "DRAFT", title: "t", kind: "RESUME", template: "SIMPLE", created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z" }];
    if (sql.includes("FROM career_evidence")) return [E1, E2, E3].map((id) => ({ id, source_text: "Go and Postgres", archived: false }));
    if (sql.startsWith("WITH upd AS")) return [{ number: 2 }];
    return null;
  });
  const blocks = [E1, E2, E3].map((eid, i) => ({ id: "b" + i, text: "Go", evidenceRefs: [{ evidenceId: eid, start: 0, end: 2 }, { evidenceId: E1, start: 3, end: 6 }] }));
  const content = { type: "doc", content: blocks.map((b) => ({ type: "paragraph", attrs: { blockId: b.id }, content: [{ type: "text", text: b.text }] })) };
  const res = await handle(postJson(`/api/v1/documents/${DOC}/versions`, { expectedRevision: 1, content, blocks }, "00000000-0000-4000-8000-000000000007"),
    ENV, { query, now: () => NOW });
  assert.equal(res.status, 201);
  assert.equal(calls.filter((c) => c.sql.includes("FROM career_evidence")).length, 1);
});
