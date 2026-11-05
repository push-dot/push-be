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
