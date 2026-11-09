import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const sql = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../../db/migrations/0040_web_v2_fields.sql"), "utf8");

test("migration 0040 only adds nullable columns and their checks", () => {
  assert.match(sql, /ALTER TABLE companies ADD COLUMN legal_name text;/);
  assert.match(sql, /char_length\(legal_name\) <= 120/);
  assert.match(sql, /ALTER TABLE offers ADD COLUMN responded_at timestamptz;/);
  assert.match(sql, /ALTER TABLE job_postings ADD COLUMN draft_source text;/);
  assert.match(sql, /draft_source IN \('AGENT', 'MANUAL'\)/);
  assert.doesNotMatch(sql, /\b(DROP|UPDATE|DELETE|NOT NULL)\b/);
});
