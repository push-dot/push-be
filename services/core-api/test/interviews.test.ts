import assert from "node:assert/strict";
import { test } from "node:test";

import { postJson, recorder } from "../test-support/recorder.ts";

const NOW = new Date("2026-10-21T00:00:00Z");
const ENV = { APP_ENV: "production" };

const APP = "22222222-2222-4222-8222-222222222222";
const E1 = "e0000000-0000-4000-8000-000000000001";
const E2 = "e0000000-0000-4000-8000-000000000002";
const E3 = "e0000000-0000-4000-8000-000000000003";

test("interview evidence ids are checked in one query and the first missing id is reported", async () => {
  const { handle } = await import("../src/handler.ts");
  const { calls, query } = recorder((sql) => {
    if (sql.startsWith("SELECT id FROM applications")) return [{ id: APP }];
    if (sql.includes("FROM career_evidence")) return [{ id: E1 }, { id: E3 }];
    return null;
  });
  const res = await handle(postJson("/api/v1/interviews", {
    applicationId: APP, title: "t", scheduledAt: "2026-11-01T00:00:00Z", timeZone: "UTC", evidenceIds: [E1, E2, E3],
  }, "00000000-0000-4000-8000-000000000004"), ENV, { query, now: () => NOW });
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as { error: { message: string } }).error.message, new RegExp(E2));
  assert.equal(calls.filter((c) => c.sql.includes("FROM career_evidence")).length, 1);
});
