// The queue position a queued run's status carries, on a migrated Postgres (BILLING_PG_URL). The bot state view
// defines it once (bot_state_v.job_ahead, 0054); the status row core writes at enqueue reads that view.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { handle, type CoreEnv } from "../src/handler.ts";
import { botsPg, type BotsPg, type Person } from "../test-support/bots-pg.ts";

const URL_ = process.env.BILLING_PG_URL;
const SKIP = "set BILLING_PG_URL to a migrated Postgres";

let db: BotsPg | undefined;
before(async () => { if (URL_) db = await botsPg(URL_); });
after(async () => { await db?.close(); });

type Answer = { status: number; data: Record<string, unknown> };

const call = async (user: Person, method: string, path: string, body?: unknown): Promise<Answer> => {
  const env: CoreEnv = { APP_ENV: "development", DEV_AUTH_TOKEN: "dev", DEV_USER_ID: user.id, QUEUE_BACKEND: "redis" };
  const res = await handle(new Request("https://core.example/api/v1" + path, {
    method,
    headers: {
      authorization: "Bearer dev",
      "content-type": "application/json",
      ...(method === "POST" ? { "idempotency-key": crypto.randomUUID() } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env, { query: db!.pg.query, transaction: db!.pg.transaction, now: () => new Date() });
  const json = await res.json() as { data?: Record<string, unknown> };
  return { status: res.status, data: json.data ?? {} };
};

const queuedStatus = async (send: Answer): Promise<Record<string, unknown>> => {
  const jobId = String((send.data.result as { value: { jobId: string } }).value.jobId);
  const rows = (await db!.pg.query("SELECT payload FROM chat_events WHERE job_id = $1::uuid AND type = 'status'", [jobId])).rows;
  assert.equal(rows.length, 1);
  return rows[0].payload as Record<string, unknown>;
};

test("a queued run's status says the queue position the bot list says, and 0 outside a bot thread", async (t) => {
  if (!db) return t.skip(SKIP);
  const user = await db.person("PRO");
  const bots: string[] = [];
  for (const company of ["모아페이", "누리클라우드"]) {
    const made = await call(user, "POST", "/bots", { postingId: await db.posting(company) });
    assert.equal(made.status, 201);
    bots.push(String(made.data.id));
  }

  const statuses: Record<string, unknown>[] = [];
  for (const bot of bots) {
    const sent = await call(user, "POST", `/bots/${bot}/messages/stream`, { text: "공고 봐 줘" });
    assert.equal(sent.status, 202);
    statuses.push(await queuedStatus(sent));
  }
  const listed = (await call(user, "GET", "/bots")).data as unknown as { id: string; activity: unknown }[];
  const activity = (bot: string) => listed.find((item) => item.id === bot)?.activity;

  assert.deepEqual(statuses.map((status) => status.ahead), [0, 1]);
  bots.forEach((bot, index) => {
    const { text: _text, ...run } = statuses[index];
    assert.deepEqual(activity(bot), run, "the stream and the list read one definition");
  });

  const web = await call(user, "POST", "/conversations", { title: "웹 대화" });
  assert.equal(web.status, 201);
  const sent = await call(user, "POST", `/conversations/${String(web.data.id)}/messages`, { text: "안녕" });
  assert.equal(sent.status, 202);
  assert.equal((await queuedStatus(sent)).ahead, 0);
});
