import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

const sql = readFileSync(resolve(import.meta.dirname, "../../../db/migrations/0026_drop_ai_keys.sql"), "utf8");

test("migration 0026 drops ai_keys idempotently", () => {
  assert.match(sql, /DROP TABLE IF EXISTS ai_keys;/);
});
