// The personal chat enqueue and the RESUME_GATE answer on a migrated Postgres (BILLING_PG_URL).
// The AI harness reads these rows, so the test pins the shapes core really writes.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import type { Row } from "../src/db.ts";
import { handle } from "../src/handler.ts";
import { resetLimits } from "../src/ratelimit.ts";
import { botsPg } from '../test-support/bots-pg.ts';
import type { BotsPg, Person } from '../test-support/bots-pg.ts';

const URL_ = process.env.BILLING_PG_URL;
const SKIP = "set BILLING_PG_URL to a migrated Postgres";
const TOKEN = "resume-gate-pg";

let db: BotsPg | undefined;
before(async () => { if (URL_) {db = await botsPg(URL_);} });
after(async () => { await db?.close(); });

const isRow = (value: unknown): value is Row => typeof value === "object" && value !== null && !Array.isArray(value);
const objectOf = (value: unknown): Row => (isRow(value) ? value : {});
const rows = async (sql: string, params: Array<unknown>): Promise<Array<Row>> => (await db!.pg.query(sql, params)).rows;

/** A real sign-in path (dev token) and the legacy chat_jobs queue; the VPS wake is faked. */
const post = async (user: Person, path: string, body: unknown): Promise<{ status: number; body: Row }> => {
  resetLimits();
  const res = await handle(
    new Request("https://core.example/api/v1" + path, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify(body),
    }),
    { APP_ENV: "development", DEV_AUTH_TOKEN: TOKEN, DEV_USER_ID: user.id, AI_ORIGIN: "https://ai.example.test" },
    { query: db!.pg.query, transaction: db!.pg.transaction, now: () => new Date(), fetch: async () => new Response("{}") },
  );
  const parsed: Row = await res.json();
  return { status: res.status, body: parsed };
};

const thread = async (user: Person): Promise<string> => {
  const id = crypto.randomUUID();
  await rows("INSERT INTO conversations (id, user_id, title) VALUES ($1::uuid, $2::uuid, 'resume gate')", [id, user.id]);
  return id;
};

/** A RESUME_GATE card exactly as services/ai harness/approvals.py insert_chat_approval stores it: no job_id, no expiry. */
const gateCard = async (user: Person, conversation: string): Promise<string> => {
  const id = crypto.randomUUID();
  const options = JSON.stringify([{ id: "continue", label: "계속" }, { id: "stop", label: "그만" }]);
  await rows(
    `INSERT INTO approvals (id, user_id, kind, target_id, payload_hash, status, conversation_id, title, options)
     VALUES ($1::uuid, $2::uuid, 'RESUME_GATE', $1::uuid, md5($4), 'PENDING', $3::uuid, '이어서 쓸까요?', $4::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [id, user.id, conversation, options]);
  return id;
};

const jobs = async (conversation: string): Promise<Array<Row>> =>
  rows("SELECT id, user_id, status, payload FROM chat_jobs WHERE conversation_id = $1::uuid ORDER BY created_at", [conversation]);
const card = async (id: string): Promise<Row> =>
  (await rows("SELECT status, option_id, decided_at IS NOT NULL AS decided FROM approvals WHERE id = $1::uuid", [id]))[0];

test("a personal message queues one PENDING chat_jobs row with text, context, access_mode and intent", async (t) => {
  if (!db) {return t.skip(SKIP);}
  const user = await db.person("PRO");
  const conversation = await thread(user);
  const evidence = crypto.randomUUID();
  const text = "이 공고에 맞춰 써줘 https://careers.example.com/jobs/1";

  const sent = await post(user, `/conversations/${conversation}/messages`, {
    text, context: { evidenceIds: [evidence] }, accessMode: "CONFIRM_ACTIONS", intent: null,
  });
  assert.equal(sent.status, 202);

  const queued = await jobs(conversation);
  assert.equal(queued.length, 1);
  assert.deepEqual([queued[0].status, queued[0].user_id], ["PENDING", user.id]);
  assert.deepEqual(queued[0].payload, {
    text,
    context: { documentId: null, versionId: null, evidenceIds: [evidence] },
    ai: null,
    accessMode: "ALWAYS_ASK",
    access_mode: "ALWAYS_ASK",
    intent: null,
    applicationId: null,
  }, "CONFIRM_ACTIONS is stored as its canonical ALWAYS_ASK; a URL travels only inside text");
  assert.equal((await rows("SELECT type, queue FROM ai_jobs WHERE id = $1::uuid", [queued[0].id]))[0].queue, "q:chat");
  const [message] = await rows("SELECT role, text FROM messages WHERE conversation_id = $1::uuid", [conversation]);
  assert.deepEqual(message, { role: "USER", text });
});

test("context.urls is not part of core's contract: the message is refused and nothing is queued", async (t) => {
  if (!db) {return t.skip(SKIP);}
  const user = await db.person("PRO");
  const conversation = await thread(user);

  const sent = await post(user, `/conversations/${conversation}/messages`, {
    text: "읽어줘", context: { evidenceIds: [], urls: ["https://careers.example.com/jobs/1"] },
  });
  assert.equal(sent.status, 400);
  assert.equal((await jobs(conversation)).length, 0);
});

test("a RESUME_GATE answer by optionId approves the card and queues a resume job that carries the turn settings", async (t) => {
  if (!db) {return t.skip(SKIP);}
  const user = await db.person("PRO");
  const conversation = await thread(user);
  assert.equal((await post(user, `/conversations/${conversation}/messages`, { text: "써줘", accessMode: "AUTO", intent: null })).status, 202);
  const id = await gateCard(user, conversation);

  const answered = await post(user, `/conversations/${conversation}/approvals/${id}`, { optionId: "continue" });
  assert.equal(answered.status, 202);
  const { jobId, ...rest } = objectOf(answered.body.data);
  assert.deepEqual(rest, { id, status: "APPROVED", optionId: "continue" });
  assert.deepEqual(await card(id), { status: "APPROVED", option_id: "continue", decided: true });

  const queued = await jobs(conversation);
  assert.equal(queued.length, 2);
  const resume = queued.find((job) => job.id === jobId);
  assert.ok(resume, "the answer returns the queued job id");
  assert.equal(resume.status, "PENDING");
  assert.deepEqual(resume.payload, {
    text: "", accessMode: "AUTO", access_mode: "AUTO", resume: { approvalId: id, optionId: "continue" },
  }, "access_mode carries from the last chat job; a null ai or intent is not carried");

  const again = await post(user, `/conversations/${conversation}/approvals/${id}`, { optionId: "stop" });
  assert.equal(again.status, 409);
  assert.equal(objectOf(again.body.error).code, "APPROVAL_ALREADY_RESOLVED");
  assert.equal((await jobs(conversation)).length, 2, "a second answer queues nothing");
});

test("a RESUME_GATE answer by optionIds stores the first id and queues resume.optionIds", async (t) => {
  if (!db) {return t.skip(SKIP);}
  const user = await db.person("PRO");
  const conversation = await thread(user);
  const id = await gateCard(user, conversation);

  const answered = await post(user, `/conversations/${conversation}/approvals/${id}`, { optionIds: ["stop", "continue"] });
  assert.equal(answered.status, 202);
  const { jobId, ...rest } = objectOf(answered.body.data);
  assert.deepEqual(rest, { id, status: "APPROVED", optionId: "stop", optionIds: ["stop", "continue"] });
  assert.deepEqual(await card(id), { status: "APPROVED", option_id: "stop", decided: true });

  const [resume] = await jobs(conversation);
  assert.equal(resume.id, jobId);
  assert.deepEqual(resume.payload, { text: "", resume: { approvalId: id, optionId: "stop", optionIds: ["stop", "continue"] } },
    "with no earlier chat job nothing is carried");

  assert.equal((await post(user, `/conversations/${conversation}/approvals/${id}`, { optionIds: ["continue"] })).status, 409);
  assert.equal((await post(user, `/conversations/${conversation}/approvals/${id}`, { optionIds: ["nope"] })).status, 400,
    "an unknown option is refused before the resolved check");
});
