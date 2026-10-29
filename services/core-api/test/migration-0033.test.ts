import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const sql = readFileSync(resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../db/migrations/0033_posting_fit_revision.sql",
), "utf8");

test("migration 0033 stores the posting revision on a cached fit", () => {
  assert.match(sql, /ALTER TABLE posting_fit_cache/);
  assert.match(sql, /ADD COLUMN posting_revision bigint NOT NULL DEFAULT 0/);
  assert.doesNotMatch(sql, /DROP TABLE/);
});
