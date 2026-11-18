import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { after, before, test } from "node:test";
import { promisify } from "node:util";

import { enqueueResumeJob } from "../src/ai-jobs.ts";
import { handle, type CoreEnv } from "../src/handler.ts";
import { botsPg, type BotsPg, type Person } from "../test-support/bots-pg.ts";
import type { Ctx } from "../src/types.ts";

const exec = promisify(execFile);
const URL_ = process.env.BILLING_PG_URL;
const SKIP = "set BILLING_PG_URL to a migrated Postgres";
const PREVIEW = `급여 명세는 비밀 ${crypto.randomUUID()}`;

let db: BotsPg | undefined;
before(async () => { if (URL_) db = await botsPg(URL_); });
after(async () => { await db?.close(); });

const env = (backend: string): CoreEnv => ({
  APP_ENV: "production",
  INTERNAL_JOB_TOKEN: "job-secret",
  EXPO_ACCESS_TOKEN: "expo-secret",
  QUEUE_BACKEND: backend,
  DISPATCH_ORIGIN: "",
});

const aiDone = async (userId: string, conversationId: string, jobId: string, backend: string) => {
  const pushed: string[] = [];
  const res = await handle(new Request("https://core.example/api/v1/internal/notifications/ai-done", {
    method: "POST",
    headers: { authorization: "Bearer job-secret", "content-type": "application/json" },
    body: JSON.stringify({ userId, conversationId, jobId }),
  }), env(backend), {
    query: db!.pg.query,
    transaction: db!.pg.transaction,
    now: () => new Date("2026-11-13T00:00:00.000Z"),
    fetch: async (_input, init) => {
      pushed.push(String(init?.body ?? ""));
      return new Response("{}", { status: 200 });
    },
  });
  const body = await res.json() as { data: { id: string | null } };
  return { status: res.status, id: body.data.id, pushed };
};

const threadFor = async (user: Person, botId: string): Promise<string> => {
  const id = crypto.randomUUID();
  await db!.pg.query(
    "INSERT INTO conversations (id, user_id, title, bot_id) VALUES ($1::uuid, $2::uuid, '봇', $3::uuid)",
    [id, user.id, botId]);
  await db!.pg.query(
    "INSERT INTO messages (id, user_id, conversation_id, role, text) VALUES ($1::uuid, $2::uuid, $3::uuid, 'ASSISTANT', $4)",
    [crypto.randomUUID(), user.id, id, PREVIEW]);
  await db!.pg.query(
    "INSERT INTO user_devices (user_id, token, platform) VALUES ($1::uuid, $2, 'ios')",
    [user.id, "ExponentPushToken[s7]"]);
  return id;
};

const applyQueued = async (payload: unknown): Promise<void> => {
  const script = `
import asyncio, json, os
import asyncpg
from app.workers.handlers.notify import make_notify

async def main():
    conn = await asyncpg.connect(os.environ["BILLING_PG_URL"])
    for kind in ("json", "jsonb"):
        await conn.set_type_codec(kind, encoder=json.dumps, decoder=json.loads, schema="pg_catalog")
    class Q:
        async def fetchval(self, sql, *args):
            return await conn.fetchval(sql, *args)
        async def fetch(self, sql, *args):
            return [dict(row) for row in await conn.fetch(sql, *args)]
    payload = json.loads(os.environ["PAYLOAD"])
    await make_notify(lambda: Q(), lambda messages: asyncio.sleep(0, result=0))(type("C", (), {"job": {"payload": payload}})())
    await conn.close()

asyncio.run(main())
`;
  await exec("uv", ["run", "--no-sync", "python", "-c", script], {
    cwd: new URL("../../ai", import.meta.url).pathname,
    env: { ...process.env, BILLING_PG_URL: URL_, PAYLOAD: JSON.stringify(payload), DB_DRIVER: "asyncpg" },
  });
};

test("a muted bot sends nothing, one job sends once, and erase drops the row", async (t) => {
  if (!db) return t.skip(SKIP);
  const user = await db.person("PRO");
  const bot = await db.call(user, "POST", "/bots", { postingId: await db.posting("모아페이") });
  assert.equal(bot.status, 201);
  const botId = String(bot.data.id);
  const thread = await threadFor(user, botId);
  await db.pg.query("UPDATE bots SET notifications_muted = true WHERE id = $1::uuid", [botId]);
  const muted = await aiDone(user.id, thread, crypto.randomUUID(), "postgres");
  assert.equal(muted.status, 201);
  assert.equal(muted.id, null);
  assert.equal(Number((await db.pg.query("SELECT count(*)::int AS n FROM notifications WHERE conversation_id = $1::uuid", [thread])).rows[0].n), 0);

  await db.pg.query("UPDATE bots SET notifications_muted = false WHERE id = $1::uuid", [botId]);
  const jobId = crypto.randomUUID();
  const first = await aiDone(user.id, thread, jobId, "postgres");
  const second = await aiDone(user.id, thread, jobId, "postgres");
  assert.equal(first.id !== null, true);
  assert.equal(second.id, null);
  const row = (await db.pg.query(
    "SELECT title, body, target, conversation_id FROM notifications WHERE id = $1::uuid", [first.id])).rows[0];
  assert.equal(row.title, "Bot 작업 완료");
  assert.equal(row.body, PREVIEW);
  assert.equal(String(row.conversation_id), thread);
  assert.deepEqual(row.target, { kind: "bot", id: botId });
  assert.equal(first.pushed.length, 1);
  assert.equal(first.pushed[0].includes(PREVIEW), false);
  assert.equal(first.pushed[0].includes("모아페이 Bot이 작업을 마쳤어요"), true);
  assert.equal((await db.call(user, "DELETE", `/bots/${botId}`)).status, 204);
  assert.equal(Number((await db.pg.query("SELECT count(*)::int AS n FROM notifications WHERE conversation_id = $1::uuid", [thread])).rows[0].n), 0);
});

test("a web conversation keeps the conversation target", async (t) => {
  if (!db) return t.skip(SKIP);
  const user = await db.person("FREE");
  const thread = crypto.randomUUID();
  await db.pg.query("INSERT INTO conversations (id, user_id, title) VALUES ($1::uuid, $2::uuid, '웹')", [thread, user.id]);
  await db.pg.query("INSERT INTO user_devices (user_id, token, platform) VALUES ($1::uuid, 'ExponentPushToken[web]', 'ios')", [user.id]);
  const sent = await aiDone(user.id, thread, crypto.randomUUID(), "postgres");
  const row = (await db.pg.query("SELECT title, body, target, conversation_id FROM notifications WHERE id = $1::uuid", [sent.id])).rows[0];
  assert.equal(row.title, "AI 작업이 끝났어요");
  assert.equal(row.body, "");
  assert.deepEqual(row.target, { kind: "conversation", id: thread });
  assert.equal(String(row.conversation_id), thread);
  assert.equal(sent.pushed[0].includes("Bot"), false);
});

test("redis stores the job, the worker row, and erase removes both", async (t) => {
  if (!db) return t.skip(SKIP);
  const user = await db.person("PRO");
  const bot = await db.call(user, "POST", "/bots", { postingId: await db.posting("모아페이") });
  const botId = String(bot.data.id);
  const thread = await threadFor(user, botId);
  const chatId = crypto.randomUUID();
  await db.pg.query(
    `INSERT INTO ai_jobs (id, type, queue, user_id, plan, status, max_attempts, payload, conversation_id, created_at)
     VALUES ($1::uuid, 'chat', 'q:chat', $2::uuid, 'PRO', 'DONE', 3, $3::jsonb, $4::uuid, now() - interval '1 hour')`,
    [chatId, user.id, JSON.stringify({ ai: "kept-marker", text: "old" }), thread]);
  const sent = await aiDone(user.id, thread, crypto.randomUUID(), "redis");
  assert.equal(sent.id !== null, true);
  const job = (await db.pg.query(
    "SELECT id, type, conversation_id, payload FROM ai_jobs WHERE conversation_id = $1::uuid AND type = 'notify'", [thread])).rows[0] as {
    id: string; type: string; conversation_id: string;
    payload: { body: string; pushBody: string; notificationId: string };
  };
  assert.equal(job.type, "notify");
  assert.equal(String(job.conversation_id), thread);
  assert.equal(job.payload.body, PREVIEW);
  assert.equal(String(job.payload.pushBody).includes(PREVIEW), false);
  const listed = await db.pg.query("SELECT id FROM chat_jobs WHERE conversation_id = $1::uuid", [thread]);
  assert.equal(listed.rows.some((row) => String(row.id) === String(job.id)), false);
  assert.equal(listed.rows.some((row) => String(row.id) === chatId), true);
  const active = await db.pg.query(
    "SELECT id FROM chat_jobs WHERE user_id = $1::uuid AND conversation_id = $2::uuid AND status IN ('PENDING', 'RUNNING')",
    [user.id, thread]);
  assert.equal(active.rows.some((row) => String(row.id) === String(job.id)), false);
  const ctx = {
    request: new Request("https://core.example"),
    env: env("redis"),
    deps: { query: db.pg.query, transaction: db.pg.transaction },
    rid: "r",
    url: new URL("https://core.example"),
    now: new Date("2026-11-13T00:00:00.000Z"),
  } as Ctx;
  const resumed = await enqueueResumeJob(ctx, { conversationId: thread, userId: user.id, payload: { text: "" } });
  const resumedPayload = (await db.pg.query("SELECT payload FROM ai_jobs WHERE id = $1::uuid", [resumed])).rows[0].payload as { ai: string };
  assert.equal(resumedPayload.ai, "kept-marker");
  assert.equal(JSON.stringify(resumedPayload).includes(PREVIEW), false);
  await applyQueued(job.payload);
  const note = await db.pg.query("SELECT body, conversation_id FROM notifications WHERE id = $1::uuid", [job.payload.notificationId]);
  assert.equal(note.rows[0].body, PREVIEW);
  assert.equal(String(note.rows[0].conversation_id), thread);
  assert.equal((await db.call(user, "DELETE", `/bots/${botId}`)).status, 204);
  const left = await db.pg.query(
    "SELECT (SELECT count(*)::int FROM notifications WHERE conversation_id = $1::uuid) AS notes, (SELECT count(*)::int FROM ai_jobs WHERE conversation_id = $1::uuid) AS jobs",
    [thread]);
  assert.deepEqual(left.rows[0], { notes: 0, jobs: 0 });
});
