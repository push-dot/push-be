import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const sql = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../../db/migrations/0049_user_consent_history.sql"), "utf8");

test("migration 0049 keeps a replaced terms agreement with the user", () => {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS user_consent_history/);
  assert.match(sql, /user_id uuid NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/);
  assert.match(sql, /terms_version text/);
  assert.match(sql, /age14_at timestamptz/);
  assert.match(sql, /service_terms_at timestamptz/);
  assert.match(sql, /privacy_at timestamptz/);
  assert.match(sql, /replaced_at timestamptz NOT NULL DEFAULT now\(\)/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_user_consent_history_user ON user_consent_history \(user_id, replaced_at DESC\)/);
  assert.match(sql, /DROP TABLE user_consent_history/);
});
