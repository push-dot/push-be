import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const migrationPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../db/migrations/0023_jobs_outbox.sql",
);

const JOB_STATUSES = ["QUEUED", "RUNNING", "RETRY", "DONE", "FAILED", "DEAD", "CANCELLED"];
const RESERVATION_STATUSES = ["RESERVED", "SETTLED", "RELEASED"];

test("migration 0023 creates jobs, outbox, credit_reservations and keeps chat_jobs readable", () => {
  const sql = readFileSync(migrationPath, "utf8");
  assert.match(sql, /CREATE TABLE jobs \(/);
  assert.match(sql, /CREATE TABLE outbox \(/);
  assert.match(sql, /CREATE TABLE credit_reservations \(/);
  assert.match(sql, /UNIQUE \(user_id, idempotency_key\)/);
  assert.match(sql, /dispatched_at IS NULL/);
  assert.match(sql, /CREATE (OR REPLACE )?FUNCTION notify_outbox\(\)/);
  assert.match(sql, /pg_notify\('outbox', NEW\.id::text\)/);
  assert.match(sql, /ALTER TABLE ai_usage ADD COLUMN job_id uuid/);
  assert.match(sql, /INSERT INTO jobs \([\s\S]*FROM chat_jobs/);
  assert.match(sql, /CREATE VIEW chat_jobs AS/);
  const jobCheck = sql.match(/jobs[\s\S]*?CHECK \(status IN \(([^)]+)\)\)/);
  assert.ok(jobCheck);
  const jobStatuses = [...jobCheck[1].matchAll(/'([A-Z]+)'/g)].map((hit) => hit[1]);
  assert.deepEqual(jobStatuses, JOB_STATUSES);
  const reservationCheck = sql.match(/credit_reservations[\s\S]*?CHECK \(status IN \(([^)]+)\)\)/);
  assert.ok(reservationCheck);
  const reservationStatuses = [...reservationCheck[1].matchAll(/'([A-Z]+)'/g)].map((hit) => hit[1]);
  assert.deepEqual(reservationStatuses, RESERVATION_STATUSES);
});
