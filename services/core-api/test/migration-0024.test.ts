import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const sql = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../../db/migrations/0024_vectors_1024.sql"), "utf8");

test("migration 0024 creates rag_nodes with a 1024 HNSW index, trigram index and a tenant check", () => {
  assert.match(sql, /CREATE EXTENSION IF NOT EXISTS pg_trgm/);
  assert.match(sql, /CREATE TABLE rag_nodes \(/);
  assert.match(sql, /embedding vector\(1024\) NOT NULL/);
  assert.match(sql, /embedding_model text NOT NULL/);
  assert.match(sql, /CHECK \(user_id IS NOT NULL OR company_id IS NOT NULL\)/);
  assert.match(sql, /USING hnsw \(embedding vector_cosine_ops\)/);
  assert.match(sql, /USING gin \(text gin_trgm_ops\)/);
  assert.match(sql, /AFTER DELETE ON sources/);
  assert.match(sql, /CREATE TABLE upload_images \(/);
});
