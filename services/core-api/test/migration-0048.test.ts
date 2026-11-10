import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const sql = readFileSync(resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../db/migrations/0048_documents_purge_index_fit_cache_fk.sql",
), "utf8");

test("migration 0048 indexes archived documents and cascades fit-cache rows", () => {
  assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_documents_archived ON documents \(updated_at\) WHERE status = 'ARCHIVED'/);
  assert.match(sql, /DELETE FROM posting_fit_cache c/);
  assert.match(sql, /NOT EXISTS \(SELECT 1 FROM documents d WHERE d\.id = c\.document_id\)/);
  assert.match(sql, /NOT EXISTS \(SELECT 1 FROM job_postings p WHERE p\.id = c\.posting_id\)/);
  assert.match(sql, /ADD CONSTRAINT posting_fit_cache_document_fk\s+FOREIGN KEY \(document_id\) REFERENCES documents\(id\) ON DELETE CASCADE NOT VALID/);
  assert.match(sql, /VALIDATE CONSTRAINT posting_fit_cache_document_fk/);
  assert.match(sql, /ADD CONSTRAINT posting_fit_cache_posting_fk\s+FOREIGN KEY \(posting_id\) REFERENCES job_postings\(id\) ON DELETE CASCADE NOT VALID/);
  assert.match(sql, /VALIDATE CONSTRAINT posting_fit_cache_posting_fk/);
  assert.match(sql, /DROP INDEX IF EXISTS idx_documents_archived/);
  assert.match(sql, /DROP CONSTRAINT posting_fit_cache_document_fk/);
  assert.match(sql, /DROP CONSTRAINT posting_fit_cache_posting_fk/);
  assert.doesNotMatch(sql, /^\s*BEGIN\b/m);
  assert.doesNotMatch(sql, /^\s*COMMIT\b/m);
});
