import assert from "node:assert/strict";
import { test } from "node:test";

import { enqueueResumeJob } from "../src/ai-jobs.ts";
import { handle, type CoreEnv, type Deps } from "../src/handler.ts";
import { resetLimits } from "../src/ratelimit.ts";
import type { Ctx } from "../src/types.ts";

const USER = "12345678-1234-5678-1234-567812345678";
const CONV = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const BOT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const JOB = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const NOW = new Date("2026-10-21T00:00:00.000Z");
const PREVIEW = "급여 명세는 비밀";

type Call = { sql: string; params: unknown[] };
type Thread = {
  bot_id: string | null;
  notifications_muted: boolean | null;
  display_name: string | null;
  last_message_preview: string | null;
  unread: boolean | null;
  allowed: boolean;
};

const env = (extra: Partial<CoreEnv> = {}): CoreEnv => ({
  APP_ENV: "production",
  INTERNAL_JOB_TOKEN: "job-secret",
  EXPO_ACCESS_TOKEN: "expo-secret",
  QUEUE_BACKEND: "redis",
  DISPATCH_ORIGIN: "",
  ...extra,
});

const done = (body: Record<string, unknown>) => new Request("https://core.example/api/v1/internal/notifications/ai-done", {
  method: "POST",
  headers: { authorization: "Bearer job-secret", "content-type": "application/json" },
  body: JSON.stringify({ userId: USER, conversationId: CONV, jobId: JOB, ...body }),
});

const recording = (thread: Thread | null) => {
  const seen: Call[] = [];
  const claimed = new Set<string>();
  const pushed: string[] = [];
  const query: Deps["query"] = async (sql, params = []) => {
    seen.push({ sql, params });
    if (sql.includes("INSERT INTO ai_jobs")) return { rows: [{ id: params[0], queue: params[2] }], rowCount: 1 };
    if (sql.includes("INSERT INTO notification_dedupes")) {
      const key = String(params[0]);
      if (claimed.has(key)) return { rows: [], rowCount: 0 };
      claimed.add(key);
      return { rows: [{ dedupe_key: key }], rowCount: 1 };
    }
    if (sql.includes("FROM conversations")) return { rows: thread ? [thread] : [], rowCount: thread ? 1 : 0 };
    if (sql.includes("user_devices")) return { rows: [{ token: "ExponentPushToken[abc]" }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
  const fetchImpl: typeof fetch = async (_input, init) => {
    pushed.push(String(init?.body ?? ""));
    return new Response("{}", { status: 200 });
  };
  return { seen, pushed, query, fetchImpl };
};

const web: Thread = {
  bot_id: null, notifications_muted: null, display_name: null, last_message_preview: null, unread: null, allowed: true,
};

const bot = (extra: Partial<Thread> = {}): Thread => ({
  bot_id: BOT, notifications_muted: false, display_name: "Push Bot", last_message_preview: PREVIEW, unread: true, allowed: true, ...extra,
});

const payloadOf = (seen: Call[]): Record<string, unknown> =>
  JSON.parse(String(seen.find((call) => call.sql.includes("INSERT INTO ai_jobs"))?.params[7]));

const idOf = async (res: Response): Promise<string | null> =>
  (await res.json() as { data: { id: string | null } }).data.id;

test("a muted bot sends nothing and does not claim the job", async () => {
  resetLimits();
  const rec = recording(bot({ notifications_muted: true }));
  const res = await handle(done({}), env(), { query: rec.query, now: () => NOW, fetch: rec.fetchImpl });
  assert.equal(res.status, 201);
  assert.equal(await idOf(res), null);
  assert.equal(rec.seen.some((call) => call.sql.includes("INSERT INTO ai_jobs")), false);
  assert.equal(rec.seen.some((call) => call.sql.includes("INSERT INTO notifications")), false);
  assert.equal(rec.seen.some((call) => call.sql.includes("INSERT INTO notification_dedupes")), false);
  assert.equal(rec.pushed.length, 0);
});

test("the same job twice sends once", async () => {
  resetLimits();
  const rec = recording(bot());
  const first = await handle(done({}), env(), { query: rec.query, now: () => NOW, fetch: rec.fetchImpl });
  const second = await handle(done({}), env(), { query: rec.query, now: () => NOW, fetch: rec.fetchImpl });
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.equal(typeof await idOf(first), "string");
  assert.equal(await idOf(second), null);
  assert.equal(rec.seen.filter((call) => call.sql.includes("INSERT INTO ai_jobs")).length, 1);
});

test("a web conversation keeps the old target and stores the conversation", async () => {
  resetLimits();
  const rec = recording(web);
  const res = await handle(done({ title: "맞춤 제목" }), env(), { query: rec.query, now: () => NOW, fetch: rec.fetchImpl });
  assert.equal(res.status, 201);
  const payload = payloadOf(rec.seen);
  assert.equal(payload.title, "맞춤 제목");
  assert.equal(payload.body, "");
  assert.equal("pushBody" in payload, false);
  assert.deepEqual(payload.target, { kind: "conversation", id: CONV });
  assert.equal(payload.conversationId, CONV);
  assert.equal(JSON.stringify(payload).includes("봇"), false);
  const job = rec.seen.find((call) => call.sql.includes("INSERT INTO ai_jobs"));
  assert.equal(job?.params[9], CONV);
});

test("a bot thread stores the preview and pushes a fixed sentence", async () => {
  resetLimits();
  const rec = recording(bot());
  const res = await handle(done({ title: "클라이언트가 적은 제목" }), env(), { query: rec.query, now: () => NOW, fetch: rec.fetchImpl });
  assert.equal(res.status, 201);
  const payload = payloadOf(rec.seen);
  assert.equal(payload.title, "봇 작업 완료");
  assert.equal(payload.body, PREVIEW);
  assert.equal(payload.pushBody, "Push Bot이 작업을 마쳤어요");
  assert.equal(String(payload.pushBody).includes(PREVIEW), false);
  assert.deepEqual(payload.target, { kind: "bot", id: BOT });
  assert.equal(payload.conversationId, CONV);
  const job = rec.seen.find((call) => call.sql.includes("INSERT INTO ai_jobs"));
  assert.equal(job?.params[9], CONV);
});

test("a company bot names itself in the push sentence", async () => {
  resetLimits();
  const rec = recording(bot({ display_name: "모아페이" }));
  const res = await handle(done({}), env(), { query: rec.query, now: () => NOW, fetch: rec.fetchImpl });
  assert.equal(res.status, 201);
  assert.equal(payloadOf(rec.seen).pushBody, "모아페이 봇이 작업을 마쳤어요");
});

test("a bot with no name still says 봇", async () => {
  resetLimits();
  const rec = recording(bot({ display_name: "  " }));
  const res = await handle(done({}), env(), { query: rec.query, now: () => NOW, fetch: rec.fetchImpl });
  assert.equal(res.status, 201);
  assert.equal(payloadOf(rec.seen).pushBody, "봇이 작업을 마쳤어요");
});

test("an already read bot thread sends nothing and does not claim the job", async () => {
  resetLimits();
  const rec = recording(bot({ unread: false }));
  const res = await handle(done({}), env(), { query: rec.query, now: () => NOW, fetch: rec.fetchImpl });
  assert.equal(res.status, 201);
  assert.equal(await idOf(res), null);
  assert.equal(rec.seen.some((call) => call.sql.includes("INSERT INTO notification_dedupes")), false);
  assert.equal(rec.seen.some((call) => call.sql.includes("INSERT INTO ai_jobs")), false);
});

test("notify_ai_done off sends nothing and does not claim the job", async () => {
  resetLimits();
  const rec = recording(bot({ allowed: false }));
  const res = await handle(done({}), env(), { query: rec.query, now: () => NOW, fetch: rec.fetchImpl });
  assert.equal(res.status, 201);
  assert.equal(await idOf(res), null);
  assert.equal(rec.seen.some((call) => call.sql.includes("INSERT INTO notification_dedupes")), false);
});

test("a missing conversation sends nothing", async () => {
  resetLimits();
  const rec = recording(null);
  const res = await handle(done({}), env(), { query: rec.query, now: () => NOW, fetch: rec.fetchImpl });
  assert.equal(res.status, 201);
  assert.equal(await idOf(res), null);
  assert.equal(rec.seen.some((call) => call.sql.includes("INSERT INTO notification_dedupes")), false);
});

test("ai-done requires a job id", async () => {
  resetLimits();
  const rec = recording(web);
  const res = await handle(new Request("https://core.example/api/v1/internal/notifications/ai-done", {
    method: "POST",
    headers: { authorization: "Bearer job-secret", "content-type": "application/json" },
    body: JSON.stringify({ userId: USER, conversationId: CONV }),
  }), env(), { query: rec.query, now: () => NOW });
  assert.equal(res.status, 400);
});

test("postgres stores the conversation and pushes the fixed sentence, not the preview", async () => {
  resetLimits();
  const rec = recording(bot());
  const res = await handle(done({}), env({ QUEUE_BACKEND: "postgres" }), { query: rec.query, now: () => NOW, fetch: rec.fetchImpl });
  assert.equal(res.status, 201);
  const insert = rec.seen.find((call) => call.sql.includes("INSERT INTO notifications"));
  assert.ok(insert);
  assert.equal(insert.params.includes(CONV), true);
  assert.equal(insert.params.includes(PREVIEW), true);
  assert.equal(insert.params.includes("봇 작업 완료"), true);
  assert.equal(rec.seen.some((call) => call.sql.includes("INSERT INTO ai_jobs")), false);
  assert.equal(rec.pushed.length, 1);
  assert.equal(rec.pushed[0].includes(PREVIEW), false);
  assert.equal(rec.pushed[0].includes("Push Bot이 작업을 마쳤어요"), true);
});

test("resume enqueue reads the last chat job, not a newer notify job", async () => {
  resetLimits();
  const seen: Call[] = [];
  const query: Deps["query"] = async (sql, params = []) => {
    seen.push({ sql, params });
    if (sql.includes("FROM conversations")) {
      const chat = /type IN \('chat', 'employer_ai'\)/.test(sql);
      const last = chat ? { ai: "kept", text: "old" } : { body: PREVIEW };
      return { rows: [{ company_id: null, company_plan: null, user_plan: "FREE", last }], rowCount: 1 };
    }
    if (sql.includes("balance_after FROM billing_ledger")) return { rows: [{ balance_after: "1000000000000" }], rowCount: 1 };
    if (sql.includes("INSERT INTO ai_jobs")) return { rows: [{ id: params[0], queue: params[2] }], rowCount: 1 };
    if (sql.includes("INSERT INTO chat_events")) return { rows: [{ job_id: "job" }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
  const ctx = {
    request: new Request("https://core.example"),
    env: { QUEUE_BACKEND: "redis", DISPATCH_ORIGIN: "" },
    deps: { query },
    rid: "r",
    url: new URL("https://core.example"),
    now: NOW,
  } as Ctx;
  await enqueueResumeJob(ctx, { conversationId: CONV, userId: USER, payload: { text: "" } });
  const payload = payloadOf(seen);
  assert.equal(payload.ai, "kept");
  assert.equal(JSON.stringify(payload).includes(PREVIEW), false);
});
