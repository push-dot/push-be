import assert from "node:assert/strict";
import { test } from "node:test";

import { handle } from "../src/handler.ts";
import { postJson, recorder } from "../test-support/recorder.ts";

const POSTING = "11111111-1111-4111-8111-111111111111";
const APP = "22222222-2222-4222-8222-222222222222";
const ENV = { APP_ENV: "production" };
const NOW = new Date("2026-10-21T00:00:00Z");
const postingRow = { id: POSTING, company: "Acme", title: "Backend", description: "Build", requirements: ["Go"], deadline: "2026-10-30" };

const missing = (column: string, table: string) =>
  Object.assign(new Error(`column "${column}" of relation "${table}" does not exist`), { code: "42703" });
const noCalendar = () => { throw missing("posting_id", "calendar_events"); };
const ofCalendar = (sql: string): boolean => sql.includes("calendar_events");
const request = (method: string, path: string, key: string): Request =>
  method === "POST" ? postJson(path, {}, key) : new Request("https://core.example" + path, { method, headers: { authorization: "Bearer t" } });
const call = (method: string, path: string, key: string, query: ReturnType<typeof recorder>["query"]) =>
  handle(request(method, path, key), ENV, { query, now: () => NOW });

test("bookmark reruns as a plain insert when calendar_events has no posting_id", async () => {
  const { calls, query } = recorder((sql) => {
    if (sql.includes("closed_at IS NULL")) return [{ id: POSTING }];
    if (ofCalendar(sql)) return noCalendar();
    return null;
  });
  const res = await call("POST", `/api/v1/postings/${POSTING}/bookmark`, "00000000-0000-4000-8000-000000000001", query);
  assert.equal(res.status, 204);
  const writes = calls.filter((c) => c.sql.includes("INSERT INTO bookmarks"));
  assert.equal(writes.length, 2);
  assert.equal(ofCalendar(writes[0].sql), true);
  assert.equal(ofCalendar(writes[1].sql), false);
});

test("unbookmark reruns as a plain delete when calendar_events has no posting_id", async () => {
  const { calls, query } = recorder((sql) => {
    if (sql.startsWith("SELECT id FROM job_postings")) return [{ id: POSTING }];
    if (ofCalendar(sql)) return noCalendar();
    return null;
  });
  const res = await call("DELETE", `/api/v1/postings/${POSTING}/bookmark`, "", query);
  assert.equal(res.status, 204);
  const writes = calls.filter((c) => c.sql.includes("DELETE FROM bookmarks"));
  assert.equal(writes.length, 2);
  assert.equal(ofCalendar(writes[1].sql), false);
});

test("an error that does not name posting_id is not retried", async () => {
  const { calls, query } = recorder((sql) => {
    if (sql.includes("closed_at IS NULL")) return [{ id: POSTING }];
    if (ofCalendar(sql)) throw missing("starts_at", "calendar_events");
    return null;
  });
  const res = await call("POST", `/api/v1/postings/${POSTING}/bookmark`, "00000000-0000-4000-8000-000000000002", query);
  assert.equal(res.status >= 500, true);
  assert.equal(calls.filter((c) => c.sql.includes("INSERT INTO bookmarks")).length, 1);
});

const applyAnswers = (failures: (sql: string) => void) => recorder((sql) => {
  if (sql.includes("FROM job_postings p WHERE p.id = $1")) return [postingRow];
  if (sql.startsWith("WITH job AS")) {
    failures(sql);
    return [{ id: APP }];
  }
  if (sql.includes("INSERT INTO ai_jobs")) return [{ id: "00000000-0000-4000-8000-000000000099", queue: "q:ingest" }];
  return null;
});

test("apply reruns without the calendar part and keeps the stamp and the snapshot", async () => {
  const { calls, query } = applyAnswers((sql) => { if (ofCalendar(sql)) noCalendar(); });
  const res = await call("POST", `/api/v1/postings/${POSTING}/apply`, "00000000-0000-4000-8000-000000000003", query);
  assert.equal(res.status, 201);
  const writes = calls.filter((c) => c.sql.startsWith("WITH job AS"));
  assert.equal(writes.length, 2);
  assert.equal(((await res.json()) as { data: { id: string } }).data.id, writes[1].params[11]);
  assert.equal(ofCalendar(writes[1].sql), false);
  assert.match(writes[1].sql, /stage_entered_at/);
  assert.match(writes[1].sql, /applicant_snapshot/);
});

test("apply on a database behind on posting_id and applicant_snapshot keeps only the stamp", async () => {
  const { calls, query } = applyAnswers((sql) => {
    if (ofCalendar(sql)) noCalendar();
    if (sql.includes("applicant_snapshot")) throw missing("applicant_snapshot", "applications");
  });
  const res = await call("POST", `/api/v1/postings/${POSTING}/apply`, "00000000-0000-4000-8000-000000000004", query);
  assert.equal(res.status, 201);
  const writes = calls.filter((c) => c.sql.startsWith("WITH job AS"));
  assert.equal(writes.length, 3);
  assert.equal(ofCalendar(writes[2].sql), false);
  assert.match(writes[2].sql, /stage_entered_at/);
  assert.equal(writes[2].sql.includes("applicant_snapshot"), false);
});

const materialCalls = (rule: (sql: string) => Record<string, unknown>[] | null) => recorder((sql) => {
  if (sql.includes("INSERT INTO material_bin") || sql.includes("DELETE FROM material_bin")) {
    if (ofCalendar(sql)) noCalendar();
    return [{ id: POSTING }];
  }
  return rule(sql);
});

test("deleting a bookmarked posting from the materials rebins without the calendar clause", async () => {
  const { calls, query } = materialCalls(() => null);
  const res = await call("DELETE", `/api/v1/materials/posting/${POSTING}`, "", query);
  assert.equal(res.status, 204);
  const writes = calls.filter((c) => c.sql.includes("INSERT INTO material_bin"));
  assert.equal(writes.length, 2);
  assert.equal(ofCalendar(writes[1].sql), false);
});

test("restoring a bookmarked posting reruns without the calendar insert", async () => {
  const { calls, query } = materialCalls((sql) => sql.includes("x.id = ANY") ? [{ id: POSTING, title: "Backend", company: "Acme", at: NOW.toISOString() }] : null);
  const res = await call("POST", `/api/v1/materials/posting/${POSTING}/restore`, "00000000-0000-4000-8000-000000000005", query);
  assert.equal(res.status, 200);
  const writes = calls.filter((c) => c.sql.includes("DELETE FROM material_bin"));
  assert.equal(writes.length, 2);
  assert.equal(ofCalendar(writes[1].sql), false);
  assert.match(writes[1].sql, /INSERT INTO bookmarks/);
});
