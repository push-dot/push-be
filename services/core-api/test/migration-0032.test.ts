import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

const sql = readFileSync(resolve(import.meta.dirname, "../../../db/migrations/0032_posting_fit_plan.sql"), "utf8");

test("migration 0032 keys the fit cache by posting, document and plan", () => {
  assert.match(sql, /posting_fit_cache_pkey/);
  assert.match(sql, /PRIMARY KEY \(user_id, posting_id, document_id, plan\)/);
  assert.match(sql, /SET plan = 'FREE'/);
  assert.doesNotMatch(sql, /CREATE TABLE posting_fit_cache/);
});
