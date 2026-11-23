import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

const sql = readFileSync(resolve(import.meta.dirname, "../../../db/migrations/0038_user_links_soft_delete.sql"), "utf8");

test("migration 0038 adds a nullable deleted_at to user_links and nothing else", () => {
  assert.equal(sql.trim(), "ALTER TABLE user_links ADD COLUMN deleted_at timestamptz;");
});
