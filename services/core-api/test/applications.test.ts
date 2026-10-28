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
