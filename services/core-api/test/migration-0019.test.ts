import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const migrationPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../db/migrations/0019_fo_web_employer.sql",
);

const REQUIRED = [
  "companies",
  "company_members",
  "company_invites",
  "email_signups",
  "email_tokens",
  "application_snapshots",
  "reference_samples",
  "user_consents",
  "iap_subscriptions",
  "conversation_attachments",
  "DROP COLUMN company_user_id",
  "notify_application_stage",
  "APPLICATION_STAGE",
  "company_id",
  "password_hash",
  "email_verified_at",
  "ALTER COLUMN user_id DROP NOT NULL",
  "provider_subject",
  "email_verified boolean",
];

test("fo-web employer migration defines the schema later tasks select", () => {
  const sql = readFileSync(migrationPath, "utf8");
  for (const token of REQUIRED) {
    assert.ok(sql.includes(token), `missing ${token}`);
  }
});
