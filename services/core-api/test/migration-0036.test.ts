import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const sql = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../../db/migrations/0036_design_api_fields.sql"), "utf8");

test("migration 0036 adds stage times, event location, and source kind", () => {
  assert.match(sql, /ALTER TABLE applications ADD COLUMN stage_entered_at jsonb NOT NULL DEFAULT '\{\}'::jsonb/);
  assert.match(sql, /UPDATE applications SET stage_entered_at = jsonb_build_object\(stage, created_at\) WHERE stage_entered_at = '\{\}'::jsonb/);
  assert.match(sql, /ALTER TABLE calendar_events ADD COLUMN location text/);
  assert.match(sql, /char_length\(location\) <= 200/);
  assert.match(sql, /ALTER TABLE sources ADD COLUMN doc_kind text/);
  assert.match(sql, /char_length\(doc_kind\) <= 40/);
});
