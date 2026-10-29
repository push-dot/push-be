import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const sql = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../../db/migrations/0030_users_phone.sql"), "utf8");

test("migration 0030 adds a personal phone and hashed codes", () => {
  assert.match(sql, /ADD COLUMN phone text/);
  assert.match(sql, /users_personal_phone_idx/);
  assert.match(sql, /WHERE phone IS NOT NULL AND is_employer = false/);
  assert.match(sql, /CREATE TABLE phone_codes/);
  assert.match(sql, /code_hash text NOT NULL/);
  assert.match(sql, /CREATE TABLE user_identities/);
  assert.match(sql, /PRIMARY KEY \(provider, provider_subject\)/);
  assert.doesNotMatch(sql, /0029_/);
});
