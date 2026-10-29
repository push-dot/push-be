import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const sql = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../../db/migrations/0031_employer_harness.sql"), "utf8");

test("migration 0031 stores employer research, reviews and interview kits per conversation", () => {
  assert.match(sql, /ADD COLUMN IF NOT EXISTS profile jsonb/);
  assert.match(sql, /CREATE TABLE employer_reviews/);
  assert.match(sql, /CREATE TABLE employer_interview_kits/);
  const cascades = sql.match(/conversation_id uuid NOT NULL REFERENCES conversations\(id\) ON DELETE CASCADE/g) ?? [];
  assert.equal(cascades.length, 2, "reports and kits must go away with their conversation");
  assert.match(sql, /'RESUME_GATE',\s*'EMPLOYER_GATE'/);
  assert.doesNotMatch(sql, /0030_/);
});
