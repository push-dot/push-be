// The queue position a queued run's status carries, on a migrated Postgres (BILLING_PG_URL). The bot state view
// defines it once (bot_state_v.job_ahead, 0054); the status row core writes at enqueue reads that view.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import type { Json, JsonObject } from "../src/json.ts";
import { handle } from '../src/handler.ts';
import type { CoreEnv } from '../src/handler.ts';
import { botsPg } from '../test-support/bots-pg.ts';
import type { BotsPg, Person } from '../test-support/bots-pg.ts';

const jsonOf = <T>(res: Response): Promise<T> => res.json();

const isJsonObject = (value: unknown): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);

const URL_ = process.env.BILLING_PG_URL;
const SKIP = "set BILLING_PG_URL to a migrated Postgres";

let db: BotsPg | undefined;
before(async () => { if (URL_) {db = await botsPg(URL_);} });
after(async () => { await db?.close(); });

type Answer = { status: number; data: JsonObject; list: Array<Json> };

const call = async (user: Person, method: string, path: string, body?: unknown): Promise<Answer> => {
  const env: CoreEnv = { APP_ENV: "development", DEV_AUTH_TOKEN: "dev", DEV_USER_ID: user.id, QUEUE_BACKEND: "redis" };
  const res = await handle(new Request("https://core.example/api/v1" + path, {
    method,
    headers: {
      authorization: "Bearer dev",
      "content-type": "application/json",
      ...(method === "POST" ? { "idempotency-key": crypto.randomUUID() } : undefined),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env, { query: db!.pg.query, transaction: db!.pg.transaction, now: () => new Date() });
  const json = await jsonOf<{ data?: Json }>(res);
  return { status: res.status, data: isJsonObject(json.data) ? json.data : {}, list: Array.isArray(json.data) ? json.data : [] };
};

const queuedStatus = async (send: Answer): Promise<JsonObject> => {
  const result = send.data.result;
  const value = isJsonObject(result) ? result.value : undefined;
  assert.ok(isJsonObject(value));
  const jobId = String(value.jobId);
  const rows = (await db!.pg.query("SELECT payload FROM chat_events WHERE job_id = $1::uuid AND type = 'status'", [jobId])).rows;
  assert.equal(rows.length, 1);
  const payload = rows[0].payload;
  assert.ok(isJsonObject(payload));
  return payload;
};

test("a queued run's status says the queue position the bot list says, and 0 outside a bot thread", async (t) => {
  if (!db) {return t.skip(SKIP);}
  const user = await db.person("PRO");
  const bots: Array<string> = [];
  for (const company of ["모아페이", "누리클라우드"]) {
    const made = await call(user, "POST", "/bots", { postingId: await db.posting(company) });
    assert.equal(made.status, 201);
    bots.push(String(made.data.id));
  }

  const statuses: Array<JsonObject> = [];
  for (const bot of bots) {
    const sent = await call(user, "POST", `/bots/${bot}/messages/stream`, { text: "공고 봐 줘" });
    assert.equal(sent.status, 202);
    statuses.push(await queuedStatus(sent));
  }
  const listed = (await call(user, "GET", "/bots")).list;
  const activity = (bot: string) => {
    const item = listed.find((entry) => isJsonObject(entry) && entry.id === bot);
    return isJsonObject(item) ? item.activity : undefined;
  };

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
