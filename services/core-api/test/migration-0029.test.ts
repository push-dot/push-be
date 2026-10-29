import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const sql = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../../db/migrations/0029_user_consent_terms.sql"), "utf8");

test("migration 0029 stores signup terms on user_consents", () => {
  assert.match(sql, /ADD COLUMN terms_version text/);
  assert.match(sql, /ADD COLUMN age14_at timestamptz/);
  assert.match(sql, /ADD COLUMN service_terms_at timestamptz/);
  assert.match(sql, /ADD COLUMN privacy_at timestamptz/);
  assert.match(sql, /ADD COLUMN marketing boolean NOT NULL DEFAULT false/);
  assert.match(sql, /ADD COLUMN marketing_at timestamptz/);
  assert.match(sql, /user_consents_terms_chk/);
  assert.match(sql, /terms_version IS NOT NULL AND age14_at IS NOT NULL AND service_terms_at IS NOT NULL AND privacy_at IS NOT NULL/);
});
