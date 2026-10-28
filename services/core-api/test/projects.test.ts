import assert from "node:assert/strict";
import { test } from "node:test";

import { recorder } from "../test-support/recorder.ts";

const NOW = new Date("2026-10-21T00:00:00Z");
const ENV = { APP_ENV: "production" };

const APP = "22222222-2222-4222-8222-222222222222";

test("a run is not inserted when moving its selected blueprint loses the revision race", async () => {
  const { handle } = await import("../src/handler.ts");
  const BP = "44444444-4444-4444-8444-444444444444";
  let stored = 0;
  const { query } = recorder((sql) => {
    if (sql.startsWith("SELECT") && sql.includes("FROM project_blueprints WHERE id = $1")) {
      return [{ id: BP, revision: 2, application_id: APP, state: "SELECTED", title: "t", created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z" }];
    }
    if (sql.includes("INSERT INTO cli_runs")) {
      // Another request moved the blueprint first: no row passes a revision guard.
      const guarded = sql.includes("revision = $11") && sql.indexOf("revision = $11") < sql.indexOf("INSERT INTO cli_runs");
      if (!guarded) stored += 1;
      return [{ runs: guarded ? 0 : 1, moved: 0 }];
    }
    if (sql.startsWith("SELECT revision FROM project_blueprints")) return [{ revision: 3 }];
    return null;
  });
  const res = await handle(new Request(`https://core.example/api/v1/projects/${BP}/runs`, {
    method: "POST",
    headers: { authorization: "Bearer t", "idempotency-key": "00000000-0000-4000-8000-000000000003", "content-type": "application/json" },
    body: JSON.stringify({ provider: "CODEX", workingDirectory: "/w", prompt: "go" }),
  }), ENV, { query, now: () => NOW });
  assert.equal(res.status, 409);
  assert.equal(stored, 0);
});
