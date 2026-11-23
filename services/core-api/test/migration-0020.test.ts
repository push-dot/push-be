import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

const migrationPath = resolve(
  import.meta.dirname,
  "../../../db/migrations/0020_fo_web_employer_profile.sql",
);

const REQUIRED = [
  "job_postings",
  "status",
  "DRAFT",
  "OPEN",
  "CLOSED",
  "job_postings_status_chk",
  "closed_at",
  "logo_key",
  "industry",
  "website",
  "intro",
  "representative_name",
  "inviter_user_id",
  "ON DELETE SET NULL",
];

test("fo-web employer profile migration defines posting status and company fields", () => {
  const sql = readFileSync(migrationPath, "utf8");
  for (const token of REQUIRED) {
    assert.ok(sql.includes(token), `missing ${token}`);
  }
});
