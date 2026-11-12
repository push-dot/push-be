// Closing, asking again and the site grants of a bot's cards, on a migrated Postgres (BILLING_PG_URL).
// Expiry, the span a retry keeps and "a newer message passed the card" are rules of the stored rows.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { handle } from "../src/handler.ts";
import { botsPg, type BotsPg, type Person } from "../test-support/bots-pg.ts";

const URL_ = process.env.BILLING_PG_URL;
const SKIP = "set BILLING_PG_URL to a migrated Postgres";
const TEN_MINUTES = 10 * 60 * 1000;

let db: BotsPg | undefined;
before(async () => { if (URL_) db = await botsPg(URL_); });
after(async () => { await db?.close(); });

const rows = async (sql: string, params: unknown[]): Promise<Record<string, unknown>[]> => (await db!.pg.query(sql, params)).rows;

const botWithThread = async (user: Person, company = "모아페이"): Promise<{ bot: string; thread: string }> => {
  const created = await db!.call(user, "POST", "/bots", { postingId: await db!.posting(company) });
  assert.equal(created.status, 201);
  const thread = crypto.randomUUID();
  await rows("INSERT INTO conversations (id, user_id, title, bot_id) VALUES ($1::uuid, $2::uuid, $3, $4::uuid)",
    [thread, user.id, company, created.data.id]);
  return { bot: String(created.data.id), thread };
};

/** A page-read card asked `askedMinutesAgo` minutes ago with a 10 minute life, as the AI service stores it. */
const pageCard = async (user: Person, thread: string, askedMinutesAgo: number, kind = "TOOL_ACTION"): Promise<string> => {
  const id = crypto.randomUUID();
  await rows(
    `INSERT INTO approvals (id, user_id, kind, target_id, payload_hash, status, conversation_id, title, options, tool_name, job_id, created_at, expires_at)
     VALUES ($1::uuid, $2::uuid, $4, $1::uuid, 'h', 'PENDING', $3::uuid, '모아페이 채용 페이지를 열어도 될까요?', $5::jsonb, 'read_page', gen_random_uuid(),
             now() - make_interval(mins => $6), now() - make_interval(mins => $6) + interval '10 minutes')`,
    [id, user.id, thread, kind, JSON.stringify([{ id: "approve" }, { id: "approve_always" }, { id: "reject" }]), askedMinutesAgo]);
  return id;
};

const card = async (id: string) => (await rows("SELECT status, option_id, created_at, expires_at FROM approvals WHERE id = $1::uuid", [id]))[0];
const jobsOf = async (thread: string) => (await rows("SELECT count(*)::int AS n FROM ai_jobs WHERE conversation_id = $1::uuid", [thread]))[0].n;
/** An answer that resumes a run queues a job, so it signs in like the bot chat tests, with the queue configured. */
const answer = async (user: Person, path: string, optionId: string): Promise<number> => (await handle(
  new Request("https://core.example/api/v1" + path, {
    method: "POST",
    headers: { authorization: "Bearer dev", "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify({ optionId }),
  }),
  { APP_ENV: "development", DEV_AUTH_TOKEN: "dev", DEV_USER_ID: user.id, QUEUE_BACKEND: "redis" },
  { query: db!.pg.query, transaction: db!.pg.transaction, now: () => new Date() },
)).status;

const span = (retry: Record<string, unknown>) => Date.parse(String(retry.expiresAt)) - Date.parse(String(retry.openedAt));

test("닫기 closes an expired card with reject and resumes nothing, and any other answer is 410", async (t) => {
  if (!db) return t.skip(SKIP);
  const user = await db.person("PRO");
  const { bot, thread } = await botWithThread(user);
  const id = await pageCard(user, thread, 11);

  const late = await db.call(user, "POST", `/bots/${bot}/approvals/${id}`, { optionId: "approve" });
  assert.equal(late.status, 410);
  assert.equal(late.error?.code, "APPROVAL_EXPIRED");
  assert.equal((await card(id)).status, "EXPIRED");

  const closed = await db.call(user, "POST", `/bots/${bot}/approvals/${id}`, { optionId: "reject" });
  assert.equal(closed.status, 200);
  assert.deepEqual(closed.data, { id, status: "REJECTED", optionId: "reject" });
  assert.deepEqual([(await card(id)).status, (await card(id)).option_id], ["REJECTED", "reject"]);
  assert.equal(await jobsOf(thread), 0, "closing an expired card queues no run");

  const again = await db.call(user, "POST", `/bots/${bot}/approvals/${id}/retry`);
  assert.equal(again.status, 409);
  assert.equal(again.error?.code, "APPROVAL_ALREADY_RESOLVED");
});

test("다시 요청 asks an expired card again with its whole lifetime, every time", async (t) => {
  if (!db) return t.skip(SKIP);
  const user = await db.person("PRO");
  const { bot, thread } = await botWithThread(user);
  const id = await pageCard(user, thread, 11);

  const first = await db.call(user, "POST", `/bots/${bot}/approvals/${id}/retry`);
  assert.equal(first.status, 200);
  assert.deepEqual([first.data.id, first.data.status, span(first.data)], [id, "PENDING", TEN_MINUTES]);
  assert.ok(Math.abs(Date.parse(String(first.data.openedAt)) - Date.now()) < 60_000, "asked again now");
  assert.equal((await card(id)).status, "PENDING");
  assert.equal(await jobsOf(thread), 0, "a retry queues no run: the run still waits on this card");

  const tap = await db.call(user, "POST", `/bots/${bot}/approvals/${id}/retry`);
  assert.deepEqual([tap.status, tap.data], [200, first.data], "a second tap on an open card changes nothing");

  await rows("UPDATE approvals SET created_at = created_at - interval '15 minutes', expires_at = expires_at - interval '15 minutes' WHERE id = $1::uuid", [id]);
  const second = await db.call(user, "POST", `/bots/${bot}/approvals/${id}/retry`);
  assert.deepEqual([second.status, span(second.data)], [200, TEN_MINUTES]);

  assert.equal(await answer(user, `/bots/${bot}/approvals/${id}`, "approve_always"), 202, "a card asked again takes an answer and resumes the run");
  const resumed = await rows("SELECT payload->'resume' AS resume FROM ai_jobs WHERE conversation_id = $1::uuid", [thread]);
  assert.deepEqual(resumed, [{ resume: { approvalId: id, optionId: "approve_always" } }]);
});

test("a retry after a newer message is 409 APPROVAL_SUPERSEDED", async (t) => {
  if (!db) return t.skip(SKIP);
  const user = await db.person("PRO");
  const { bot, thread } = await botWithThread(user);
  const id = await pageCard(user, thread, 11);
  await rows(
    `INSERT INTO ai_jobs (id, type, queue, user_id, status, max_attempts, payload, conversation_id)
     VALUES (gen_random_uuid(), 'chat', 'q:chat', $1::uuid, 'QUEUED', 3, '{}'::jsonb, $2::uuid)`, [user.id, thread]);

  const retry = await db.call(user, "POST", `/bots/${bot}/approvals/${id}/retry`);

  assert.equal(retry.status, 409);
  assert.equal(retry.error?.code, "APPROVAL_SUPERSEDED");
  assert.equal((await card(id)).status, "PENDING");
});

test("only an expiring tool card of the bot's own thread can be asked again", async (t) => {
  if (!db) return t.skip(SKIP);
  const user = await db.person("PRO");
  const mine = await botWithThread(user, "모아페이");
  const other = await botWithThread(user, "누리클라우드");
  const id = await pageCard(user, mine.thread, 11);
  const choice = await pageCard(user, mine.thread, 11, "RESUME_GATE");
  const stranger = await db.person("PRO");

  assert.equal((await db.call(user, "POST", `/bots/${other.bot}/approvals/${id}/retry`)).status, 404);
  assert.equal((await db.call(stranger, "POST", `/bots/${mine.bot}/approvals/${id}/retry`)).status, 404);
  assert.equal((await db.call(user, "POST", `/bots/${mine.bot}/approvals/${choice}/retry`)).status, 404);
  assert.equal((await db.call(user, "POST", `/bots/${mine.bot}/approvals/${crypto.randomUUID()}/retry`)).status, 404);
});

test("a bot's allowed sites are listed by host and taken back without a confirm", async (t) => {
  if (!db) return t.skip(SKIP);
  const user = await db.person("PRO");
  const { bot } = await botWithThread(user);
  await rows(
    `INSERT INTO bot_site_grants (bot_id, host, created_at) VALUES
       ($1::uuid, 'moapay.notion.site', '2026-11-05T01:00:00Z'), ($1::uuid, 'careers.moapay.co.kr', '2026-11-03T01:00:00Z')`, [bot]);

  const listed = await db.call(user, "GET", `/bots/${bot}/site-grants`);
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.data, [
    { host: "careers.moapay.co.kr", grantedAt: "2026-11-03T01:00:00Z" },
    { host: "moapay.notion.site", grantedAt: "2026-11-05T01:00:00Z" },
  ]);

  for (let i = 0; i < 2; i++) {
    assert.equal((await db.call(user, "DELETE", `/bots/${bot}/site-grants/careers.moapay.co.kr`)).status, 204);
  }
  assert.deepEqual((await db.call(user, "GET", `/bots/${bot}/site-grants`)).body.data,
    [{ host: "moapay.notion.site", grantedAt: "2026-11-05T01:00:00Z" }]);

  const stranger = await db.person("PRO");
  assert.equal((await db.call(stranger, "GET", `/bots/${bot}/site-grants`)).status, 404);
  assert.equal((await db.call(stranger, "DELETE", `/bots/${bot}/site-grants/moapay.notion.site`)).status, 404);
  assert.equal((await rows("SELECT count(*)::int AS n FROM bot_site_grants WHERE bot_id = $1::uuid", [bot]))[0].n, 1);

  assert.equal((await db.call(user, "DELETE", `/bots/${bot}`)).status, 204);
  assert.equal((await rows("SELECT count(*)::int AS n FROM bot_site_grants WHERE bot_id = $1::uuid", [bot]))[0].n, 0,
    "deleting the bot deletes its grants");
});

test("the Push Bot lists and revokes its sites by the literal push", async (t) => {
  if (!db) return t.skip(SKIP);
  const user = await db.person("PRO");

  const empty = await db.call(user, "GET", "/bots/push/site-grants");
  assert.deepEqual([empty.status, empty.body.data], [200, []]);

  const [push] = await rows("SELECT id FROM bots WHERE user_id = $1::uuid AND kind = 'push'", [user.id]);
  await rows("INSERT INTO bot_site_grants (bot_id, host) VALUES ($1::uuid, 'nuricloud.career.greetinghr.com')", [push.id]);
  assert.deepEqual(((await db.call(user, "GET", "/bots/push/site-grants")).body.data as { host: string }[]).map((g) => g.host),
    ["nuricloud.career.greetinghr.com"]);
  assert.equal((await db.call(user, "DELETE", "/bots/push/site-grants/nuricloud.career.greetinghr.com")).status, 204);
  assert.deepEqual((await db.call(user, "GET", "/bots/push/site-grants")).body.data, []);
});
