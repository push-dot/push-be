import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

const migrationPath = resolve(
  import.meta.dirname,
  "../../../db/migrations/0021_fo_web_design_gaps.sql",
);

const REQUIRED = [
  "application_files",
  "file_name",
  "mime_type",
  "page_count",
  "storage_key",
  "bytea",
  "view_count",
  "posting_views",
  "viewed_on",
  "parent_id",
  "remind_at",
  "default_effort",
  "MEDIUM",
  "user_settings_effort_chk",
  "confirm_before_edit",
  "company_seen_at",
  "created_by",
  "profiles",
  "contact",
  "notification_dedupes",
  "search_queries",
];

test("design gap migration adds files, views, replies, reminders, and settings", () => {
  const sql = readFileSync(migrationPath, "utf8");
  for (const token of REQUIRED) {
    assert.ok(sql.includes(token), `missing ${token}`);
  }
});
