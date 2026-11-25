// Who hears about an agent job in a company conversation, on a migrated Postgres (BILLING_PG_URL).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import type { Row } from "../src/db.ts";
import { handle } from '../src/handler.ts';
import { botsPg } from '../test-support/bots-pg.ts';
import type { BotsPg } from '../test-support/bots-pg.ts';

const URL_ = process.env.BILLING_PG_URL;
const SKIP = "set BILLING_PG_URL to a migrated Postgres";

let db: BotsPg | undefined;
before(async () => { if (URL_) {db = await botsPg(URL_);} });
after(async () => { await db?.close(); });

const rows = async (sql: string, params: Array<unknown>): Promise<Array<Row>> => (await db!.pg.query(sql, params)).rows;

const notify = async (userId: string, conversationId: string, outcome: string) => {
  const res = await handle(new Request("https://core.example/api/v1/internal/notifications/ai-done", {
    method: "POST",
    headers: { authorization: "Bearer job-secret", "content-type": "application/json" },
    body: JSON.stringify({ userId, conversationId, jobId: crypto.randomUUID(), outcome }),
  }), { APP_ENV: "production", INTERNAL_JOB_TOKEN: "job-secret", QUEUE_BACKEND: "", DISPATCH_ORIGIN: "" }, {
    query: db!.pg.query, transaction: db!.pg.transaction, now: () => new Date(), fetch: async () => new Response("{}"),
  });
  const body: { data: { id: string | null } } = await res.json();
  return body.data.id;
};

test("the member who ran a company job hears when it waits, and an outsider never does", async (t) => {
  if (!db) {return t.skip(SKIP);}
  const opener = await db.person("PRO");
  const teammate = await db.person("PRO");
  const outsider = await db.person("PRO");
  const posting = await db.posting("모아페이");
  const [{ company_id: company }] = await rows("SELECT company_id FROM job_postings WHERE id = $1::uuid", [posting]);
  for (const user of [opener, teammate]) {
    await rows("INSERT INTO company_members (company_id, user_id, role) VALUES ($1::uuid, $2::uuid, 'MEMBER')", [company, user.id]);
  }
  const thread = crypto.randomUUID();
  await rows("INSERT INTO conversations (id, user_id, title, company_id) VALUES ($1::uuid, $2::uuid, '공고 마감', $3::uuid)",
    [thread, opener.id, company]);

  const id = await notify(teammate.id, thread, "waiting");
  assert.ok(id, "the teammate is notified");
  const [notice] = await rows("SELECT user_id, title FROM notifications WHERE id = $1::uuid", [id]);
  assert.equal(notice.user_id, teammate.id);
  assert.equal(notice.title, "에이전트가 확인을 기다려요");

  assert.equal(await notify(outsider.id, thread, "waiting"), null, "not a member");
});
