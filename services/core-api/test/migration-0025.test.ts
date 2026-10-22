import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const migrationPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../db/migrations/0025_ai_harness.sql",
);

const sql = () => readFileSync(migrationPath, "utf8");

test("migration 0025 adds harness columns", () => {
  const text = sql();
  assert.match(text, /ADD COLUMN IF NOT EXISTS tool_name text/);
  assert.match(text, /ADD COLUMN IF NOT EXISTS tool_args jsonb/);
  assert.match(text, /ADD COLUMN IF NOT EXISTS tool_call_id text/);
  assert.match(text, /ADD COLUMN IF NOT EXISTS job_id uuid/);
  assert.match(text, /ADD COLUMN IF NOT EXISTS expires_at timestamptz/);
  assert.match(text, /TOOL_ACTION/);
  assert.match(text, /RESUME_GATE/);
  assert.match(text, /EXPIRED/);
  assert.match(text, /REJECTED/);
  assert.match(
    text,
    /CREATE UNIQUE INDEX IF NOT EXISTS approvals_job_tool_call_uidx[\s\S]*\(job_id, tool_call_id\)[\s\S]*WHERE tool_call_id IS NOT NULL/,
  );
  assert.match(text, /ai_access_mode text NOT NULL DEFAULT 'AUTO'/);
  assert.match(text, /ai_access_mode IN \('ALWAYS_ASK','AUTO','BYPASS'\)/);
  assert.doesNotMatch(text, /'FOO'/);
  assert.match(text, /ADD COLUMN IF NOT EXISTS harness text/);
  assert.match(text, /harness IN \('personal','employer'\)/);
  assert.match(text, /ADD COLUMN IF NOT EXISTS resume_state jsonb/);
  assert.match(text, /DROP CONSTRAINT IF EXISTS approvals_kind_chk/);
  assert.match(text, /DROP CONSTRAINT IF EXISTS approvals_status_chk/);
  assert.match(text, /DROP CONSTRAINT IF EXISTS user_settings_ai_access_mode_chk/);
});
