import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

import { handle, type CoreEnv } from "../src/handler.ts";
import { resetLimits } from "../src/ratelimit.ts";
import { recorder } from "../test-support/recorder.ts";

const env = (): CoreEnv => ({ APP_ENV: "production", MANAGED_AI: "1" });

const ask = async (path: string) => {
  resetLimits();
  const { calls, query } = recorder();
  const res = await handle(new Request("https://core.example/api/v1" + path, { headers: { authorization: "Bearer t" } }), env(), { query });
  assert.equal(res.status, 200);
  return calls;
};

test("the popular sort orders by the view_count column, not a JSON copy of every row", async () => {
  const calls = await ask("/postings?sort=popular");
  const list = calls.find((c) => c.sql.includes("FROM job_postings") && c.sql.includes("ORDER BY"));
  assert.ok(list);
  assert.match(list.sql, /ORDER BY p\.view_count DESC, p\.created_at DESC, p\.id DESC/);
  assert.doesNotMatch(list.sql, /to_jsonb/);
});

test("people search filters accounts in their deletion grace period on the column", async () => {
  const calls = await ask("/search?type=people&q=kim");
  const hits = calls.filter((c) => c.sql.includes("FROM profiles"));
  assert.ok(hits.length > 0);
  for (const hit of hits) {
    assert.match(hit.sql, /u\.deletion_requested_at IS NULL/);
    assert.doesNotMatch(hit.sql, /to_jsonb\(u\)/);
  }
});

test("no route reads view_count or deletion_requested_at through to_jsonb", () => {
  const dir = new URL("../src/routes/", import.meta.url);
  for (const name of readdirSync(dir)) {
    const text = readFileSync(new URL(name, dir), "utf8");
    assert.doesNotMatch(text, /to_jsonb\(\w+\)\s*->>\s*'(view_count|deletion_requested_at)'/, name);
  }
});
