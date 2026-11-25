// Who may answer a card in a company conversation, on a migrated Postgres (BILLING_PG_URL).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import type { Row } from "../src/db.ts";
import { handle } from "../src/handler.ts";
import { botsPg } from '../test-support/bots-pg.ts';
import type { BotsPg, Person } from '../test-support/bots-pg.ts';

const URL_ = process.env.BILLING_PG_URL;
const SKIP = "set BILLING_PG_URL to a migrated Postgres";

let db: BotsPg | undefined;
before(async () => { if (URL_) {db = await botsPg(URL_);} });
after(async () => { await db?.close(); });

const rows = async (sql: string, params: Array<unknown>): Promise<Array<Row>> => (await db!.pg.query(sql, params)).rows;

const answer = async (user: Person, thread: string, card: string, optionId: string): Promise<number> => (await handle(
  new Request(`https://core.example/api/v1/conversations/${thread}/approvals/${card}`, {
    method: "POST",
    headers: { authorization: "Bearer dev", "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify({ optionId }),
  }),
  { APP_ENV: "development", DEV_AUTH_TOKEN: "dev", DEV_USER_ID: user.id, QUEUE_BACKEND: "redis" },
  { query: db!.pg.query, transaction: db!.pg.transaction, now: () => new Date() },
)).status;

test("any member of the company answers a company card, and the card keeps who did", async (t) => {
  if (!db) {return t.skip(SKIP);}
  const opener = await db.person("PRO");
  const teammate = await db.person("PRO");
  const outsider = await db.person("PRO");
  const posting = await db.posting("모아페이");
  const [{ company_id: company }] = await rows("SELECT company_id FROM job_postings WHERE id = $1::uuid", [posting]);
  for (const [user, role] of [[opener, "ADMIN"], [teammate, "MEMBER"]] as const) {
    await rows("INSERT INTO company_members (company_id, user_id, role) VALUES ($1::uuid, $2::uuid, $3)", [company, user.id, role]);
  }
  const rival = await db.person("PRO");
  const otherPosting = await db.posting("다른회사");
  const [{ company_id: otherCompany }] = await rows("SELECT company_id FROM job_postings WHERE id = $1::uuid", [otherPosting]);
  await rows("INSERT INTO company_members (company_id, user_id, role) VALUES ($1::uuid, $2::uuid, 'ADMIN')", [otherCompany, rival.id]);
  const thread = crypto.randomUUID();
  await rows("INSERT INTO conversations (id, user_id, title, company_id) VALUES ($1::uuid, $2::uuid, '공고 마감', $3::uuid)",
    [thread, opener.id, company]);
  const card = crypto.randomUUID();
  await rows(
    `INSERT INTO approvals (id, user_id, kind, target_id, payload_hash, status, conversation_id, title, options, tool_name, job_id, expires_at)
     VALUES ($1::uuid, $2::uuid, 'TOOL_ACTION', $1::uuid, 'h', 'PENDING', $3::uuid, '공고를 마감해요', $4::jsonb, 'close_posting', gen_random_uuid(),
             now() - interval '1 minute')`,
    [card, opener.id, thread, JSON.stringify([{ id: "approve" }, { id: "reject" }])]);

  assert.equal(await answer(outsider, thread, card, "reject"), 404, "not a member of any company");
  assert.equal(await answer(rival, thread, card, "reject"), 404, "a member of another company");
  const [untouched] = await rows("SELECT status, decided_by FROM approvals WHERE id = $1::uuid", [card]);
  assert.equal(untouched.status, "PENDING");
  assert.equal(untouched.decided_by, null);
  // An expired card's 닫기 closes it without queueing a resume, so this checks who may answer only.
  assert.equal(await answer(teammate, thread, card, "reject"), 200, "a teammate answers");
  const [row] = await rows("SELECT status, decided_by FROM approvals WHERE id = $1::uuid", [card]);
  assert.equal(row.status, "REJECTED");
  assert.equal(row.decided_by, teammate.id);
});

test("a teammate's approval resumes the run as the teammate", async (t) => {
  if (!db) {return t.skip(SKIP);}
  const opener = await db.person("PRO");
  const teammate = await db.person("PRO");
  const posting = await db.posting("모아페이");
  const [{ company_id: company }] = await rows("SELECT company_id FROM job_postings WHERE id = $1::uuid", [posting]);
  for (const user of [opener, teammate]) {
    await rows("INSERT INTO company_members (company_id, user_id, role) VALUES ($1::uuid, $2::uuid, 'MEMBER')", [company, user.id]);
  }
  const thread = crypto.randomUUID();
  await rows("INSERT INTO conversations (id, user_id, title, company_id) VALUES ($1::uuid, $2::uuid, '공고 마감', $3::uuid)",
    [thread, opener.id, company]);
  const card = crypto.randomUUID();
  await rows(
    `INSERT INTO approvals (id, user_id, kind, target_id, payload_hash, status, conversation_id, title, options, tool_name, job_id)
     VALUES ($1::uuid, $2::uuid, 'TOOL_ACTION', $1::uuid, 'h', 'PENDING', $3::uuid, '공고를 마감해요', $4::jsonb, 'close_posting', gen_random_uuid())`,
    [card, opener.id, thread, JSON.stringify([{ id: "approve" }, { id: "reject" }])]);

  const res = await handle(
    new Request(`https://core.example/api/v1/conversations/${thread}/approvals/${card}`, {
      method: "POST",
      headers: { authorization: "Bearer dev", "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({ optionId: "approve" }),
    }),
    { APP_ENV: "development", DEV_AUTH_TOKEN: "dev", DEV_USER_ID: teammate.id, AI_ORIGIN: "https://ai.example.test" },
    { query: db.pg.query, transaction: db.pg.transaction, now: () => new Date(), fetch: async () => new Response("{}") },
  );
  assert.equal(res.status, 202, "approved and resumed");
  const [row] = await rows("SELECT status, decided_by FROM approvals WHERE id = $1::uuid", [card]);
  assert.equal(row.status, "APPROVED");
  assert.equal(row.decided_by, teammate.id);
  const jobs = await rows("SELECT user_id FROM chat_jobs WHERE conversation_id = $1::uuid", [thread]);
  assert.deepEqual(jobs.map((job) => job.user_id), [teammate.id], "the resume job runs as the teammate");
});
