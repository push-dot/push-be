import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

import type { Row } from "../src/db.ts";
import { handle } from '../src/handler.ts';
import type { CoreEnv, Deps } from '../src/handler.ts';
import { resetLimits } from "../src/ratelimit.ts";
import type { Json } from "../src/json.ts";

const USER = "12345678-1234-5678-1234-567812345678";
const CONV = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const JOB = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const POSTING = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const NOW = new Date("2026-10-21T00:00:00Z");

type Call = { sql: string; params: Array<unknown> };

const env = (extra: Partial<CoreEnv> = {}): CoreEnv => ({
  APP_ENV: "production",
  INTERNAL_JOB_TOKEN: "job-secret",
  EXPO_ACCESS_TOKEN: "expo-secret",
  QUEUE_BACKEND: "redis",
  DISPATCH_ORIGIN: "http://dispatch.internal",
  DISPATCH_SECRET: "kick-secret",
  ...extra,
});

const recording = (seen: Array<Call>, rows: (sql: string, params: Array<unknown>) => Array<Row> = () => []): Deps["query"] =>
  async (sql, params = []) => {
    seen.push({ sql, params });
    if (sql.includes("INSERT INTO ai_jobs")) {return { rows: [{ id: String(params[0]), queue: String(params[2]) }], rowCount: 1 };}
    if (sql.includes("FROM conversations")) {
      return { rows: [{ bot_id: null, notifications_muted: null, display_name: null, last_message_preview: null, unread: null, allowed: true }], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO notification_dedupes") && !sql.includes("FROM bookmarks") && !sql.includes("FROM calendar_events")) {
      return { rows: [{ dedupe_key: String(params[0]) }], rowCount: 1 };
    }
    if (sql.includes("user_settings") && !sql.includes("notification_dedupes")) {return { rows: [{ enabled: true }], rowCount: 1 };}
    if (sql.includes("user_devices")) {return { rows: [{ token: "ExponentPushToken[abc]" }], rowCount: 1 };}
    const out = rows(sql, params);
    return { rows: out, rowCount: out.length };
  };

const internal = (path: string, body?: unknown) => new Request("https://core.example" + path, {
  method: "POST",
  headers: { authorization: "Bearer job-secret", "content-type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
});

test("notify enqueues instead of sending push inline", async () => {
  resetLimits();
  const seen: Array<Call> = [];
  const fetched: Array<string> = [];
  const res = await handle(internal("/api/v1/internal/notifications/ai-done", { userId: USER, conversationId: CONV, jobId: JOB }), env(), {
    query: recording(seen),
    now: () => NOW,
    fetch: async (input, init) => {
      fetched.push(String(input) + " " + String(init?.body ?? ""));
      return new Response("{}", { status: 200 });
    },
  });
  assert.equal(res.status, 201);
  const data = { id: member(member(await readJson(res), "data"), "id") };
  const job = seen.find((call) => call.sql.includes("INSERT INTO ai_jobs"));
  assert.ok(job);
  assert.equal(job.params[1], "notify");
  assert.equal(job.params[2], "q:notify");
  assert.deepEqual(JSON.parse(String(job.params[7])), {
    notificationId: data.id,
    userId: USER,
    kind: "AI_DONE",
    title: "AI 작업이 끝났어요",
    body: "",
    target: { kind: "conversation", id: CONV },
    createdAt: NOW.toISOString(),
    conversationId: CONV,
  });
  assert.equal(job.params[9], CONV);
  assert.equal(seen.some((call) => call.sql.includes("INSERT INTO notifications")), false);
  assert.equal(seen.some((call) => call.sql.includes("credit_reservations") && call.sql.includes("INSERT")), false);
  assert.equal(fetched.some((hit) => hit.includes("exp.host")), false);
  assert.deepEqual(fetched, ['http://dispatch.internal/internal/kick {"queue":"q:notify"}']);
});

test("the hourly cron only creates deadline notify jobs", async () => {
  resetLimits();
  const seen: Array<Call> = [];
  const res = await handle(internal("/api/v1/internal/notifications/run"), env({ DISPATCH_ORIGIN: "" }), {
    query: recording(seen, (sql, params) => {
      if (sql.includes("FROM bookmarks")) {return [{ user_id: USER, id: POSTING, title: "Backend" }];}
      if (sql.includes("FROM calendar_events")) {return [];}
      if (sql.includes("notification_dedupes")) {return [{ dedupe_key: String(params[0]) }];}
      return [];
    }),
    now: () => NOW,
  });
  assert.equal(res.status, 200);
  assert.deepEqual(member(await readJson(res), "data"), { deadlines: 1, reminders: 0 });
  const jobs = seen.filter((call) => call.sql.includes("INSERT INTO ai_jobs"));
  assert.equal(jobs.length, 1);
  assert.equal(JSON.parse(String(jobs[0].params[7])).kind, "DEADLINE");
  assert.equal(seen.some((call) => call.sql.includes("INSERT INTO notifications")), false);
});

test("postgres backend keeps the inline insert and push for rollback", async () => {
  resetLimits();
  const seen: Array<Call> = [];
  const fetched: Array<string> = [];
  const res = await handle(internal("/api/v1/internal/notifications/ai-done", { userId: USER, conversationId: CONV, jobId: JOB }), env({ QUEUE_BACKEND: "postgres" }), {
    query: recording(seen),
    now: () => NOW,
    fetch: async (input) => {
      fetched.push(String(input));
      return new Response("{}", { status: 200 });
    },
  });
  assert.equal(res.status, 201);
  assert.ok(seen.some((call) => call.sql.includes("INSERT INTO notifications")));
  assert.equal(seen.some((call) => call.sql.includes("INSERT INTO ai_jobs")), false);
  assert.deepEqual(fetched, ["https://exp.host/--/api/v2/push/send"]);
});

test("verification mail is still sent directly by core", () => {
  const here = import.meta.dirname;
  const source = readFileSync(resolve(here, "../src/routes/email-auth.ts"), "utf8");
  assert.match(source, /mailerOf\(ctx\)\.send\(/);
  assert.doesNotMatch(source, /enqueueJob|sendNotification/);
});

// One typed boundary for response bodies in this test file.
async function readJson(res: Pick<Response, "json">): Promise<Json> {
  const body: Json = await res.json();
  return body;
}

function member(value: Json, key: string): Json {
  if (typeof value === "object" && value !== null && !Array.isArray(value) && key in value) {return value[key] ?? null;}
  throw new Error(`missing ${key}`);
}
