import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const sql = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../../db/migrations/0037_document_shares.sql"), "utf8");

test("migration 0037 file declares document_shares and the partial unique index", () => {
  assert.match(sql, /CREATE TABLE document_shares/);
  assert.match(sql, /version_id uuid NOT NULL REFERENCES document_versions\(id\) ON DELETE CASCADE/);
  assert.match(sql, /created_by uuid NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/);
  assert.match(sql, /token_hash text NOT NULL UNIQUE/);
  assert.match(sql, /CREATE UNIQUE INDEX document_shares_one_active/);
  assert.match(sql, /ON document_shares \(document_id\)/);
  assert.match(sql, /WHERE revoked_at IS NULL/);
});
