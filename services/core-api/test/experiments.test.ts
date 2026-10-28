import assert from "node:assert/strict";
import { test } from "node:test";

import { recorder } from "../test-support/recorder.ts";

const NOW = new Date("2026-10-21T00:00:00Z");
const ENV = { APP_ENV: "production" };

{
const path = "/api/v1/experiments/%E0%A4%A/assignment";
  test(`a malformed percent-encoding in ${path.split("/")[3]} is a 400, not a 500`, async () => {
    const { handle } = await import("../src/handler.ts");
    const { query } = recorder();
    const res = await handle(new Request("https://core.example" + path, { headers: { authorization: "Bearer t" } }), ENV, { query, now: () => NOW });
    assert.equal(res.status, 400);
  });
}

test("a first experiment assignment is written and read back in one statement", async () => {
  const { handle } = await import("../src/handler.ts");
  const { calls, query } = recorder((sql) => {
    if (sql.startsWith("SELECT key, variants")) return [{ key: "onboarding", variants: ["a", "b"], status: "active", exclusion_group: "" }];
    if (sql.startsWith("WITH ins AS")) return [{ experiment_key: "onboarding", variant: "b", created_at: "2026-10-21T00:00:00Z" }];
    return null;
  });
  const res = await handle(new Request("https://core.example/api/v1/experiments/onboarding/assignment", { headers: { authorization: "Bearer t" } }),
    ENV, { query, now: () => NOW });
  assert.equal(res.status, 200);
  assert.equal(calls.filter((c) => c.sql.includes("experiment_assignments")).length, 1);
});
