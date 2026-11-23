import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

const sql = readFileSync(resolve(import.meta.dirname, "../../../db/migrations/0035_iap_subscription_sandbox.sql"), "utf8");

test("migration 0035 marks an in-app purchase as sandbox", () => {
  assert.match(sql, /ALTER TABLE iap_subscriptions ADD COLUMN sandbox boolean NOT NULL DEFAULT false/);
});
