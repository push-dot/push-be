import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { handle, type CoreEnv, type Deps } from "../src/handler.ts";
import { resetLimits } from "../src/ratelimit.ts";

const USER = "12345678-1234-5678-1234-567812345678";
const CONV = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const POSTING = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const NOW = new Date("2026-10-21T00:00:00Z");

type Call = { sql: string; params: unknown[] };

const env = (extra: Partial<CoreEnv> = {}): CoreEnv => ({
  APP_ENV: "production",
  INTERNAL_JOB_TOKEN: "job-secret",
  EXPO_ACCESS_TOKEN: "expo-secret",
  QUEUE_BACKEND: "redis",
  DISPATCH_ORIGIN: "http://dispatch.internal",
  DISPATCH_SECRET: "kick-secret",
  ...extra,
});

const recording = (seen: Call[], rows: (sql: string, params: unknown[]) => Record<string, unknown>[] = () => []): Deps["query"] =>
  async (sql, params = []) => {
    seen.push({ sql, params });
    if (sql.includes("INSERT INTO ai_jobs")) return { rows: [{ id: params[0], queue: params[2] }], rowCount: 1 };
    if (sql.includes("user_settings")) return { rows: [{ enabled: true }], rowCount: 1 };
    if (sql.includes("user_devices")) return { rows: [{ token: "ExponentPushToken[abc]" }], rowCount: 1 };
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
  const seen: Call[] = [];
  const fetched: string[] = [];
  const res = await handle(internal("/api/v1/internal/notifications/ai-done", { userId: USER, conversationId: CONV }), env(), {
    query: recording(seen),
    now: () => NOW,
    fetch: async (input, init) => {
      fetched.push(String(input) + " " + String(init?.body ?? ""));
      return new Response("{}", { status: 200 });
    },
  });
  assert.equal(res.status, 201);
  const { data } = await res.json() as { data: { id: string } };
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
  });
  assert.equal(seen.some((call) => call.sql.includes("INSERT INTO notifications")), false);
  assert.equal(seen.some((call) => call.sql.includes("credit_reservations") && call.sql.includes("INSERT")), false);
  assert.equal(fetched.some((hit) => hit.includes("exp.host")), false);
  assert.deepEqual(fetched, ['http://dispatch.internal/internal/kick {"queue":"q:notify"}']);
});

test("the hourly cron only creates deadline notify jobs", async () => {
  resetLimits();
  const seen: Call[] = [];
  const res = await handle(internal("/api/v1/internal/notifications/run"), env({ DISPATCH_ORIGIN: "" }), {
    query: recording(seen, (sql, params) => {
      if (sql.includes("FROM bookmarks")) return [{ user_id: USER, id: POSTING, title: "Backend" }];
      if (sql.includes("notification_dedupes")) return [{ dedupe_key: params[0] }];
      return [];
    }),
    now: () => NOW,
  });
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json() as { data: unknown }).data, { deadlines: 1, reminders: 0 });
  const jobs = seen.filter((call) => call.sql.includes("INSERT INTO ai_jobs"));
  assert.equal(jobs.length, 1);
  assert.equal(JSON.parse(String(jobs[0].params[7])).kind, "DEADLINE");
  assert.equal(seen.some((call) => call.sql.includes("INSERT INTO notifications")), false);
});

test("postgres backend keeps the inline insert and push for rollback", async () => {
  resetLimits();
  const seen: Call[] = [];
  const fetched: string[] = [];
  const res = await handle(internal("/api/v1/internal/notifications/ai-done", { userId: USER, conversationId: CONV }), env({ QUEUE_BACKEND: "postgres" }), {
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
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(resolve(here, "../src/routes/email-auth.ts"), "utf8");
  assert.match(source, /mailerOf\(ctx\)\.send\(/);
  assert.doesNotMatch(source, /enqueueJob|sendNotification/);
});
