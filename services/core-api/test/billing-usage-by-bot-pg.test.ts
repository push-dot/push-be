// GET /billing usageByBot on a migrated Postgres (BILLING_PG_URL): which settled rows count toward which Bot is
// a rule of the SQL joins, so only the real schema shows it.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { botsPg, type BotsPg, type Person } from "../test-support/bots-pg.ts";

const URL_ = process.env.BILLING_PG_URL;
const SKIP = "set BILLING_PG_URL to a migrated Postgres";

let db: BotsPg | undefined;
before(async () => { if (URL_) db = await botsPg(URL_); });
after(async () => { await db?.close(); });

type Usage = { id: string; name: string; usedMicroCredits: number };

const run = (sql: string, params: unknown[] = []) => db!.pg.query(sql, params);

const bot = async (user: Person, company: string): Promise<{ id: string; thread: string }> => {
  const made = await db!.call(user, "POST", "/bots", { postingId: await db!.posting(company) });
  assert.equal(made.status, 201);
  const id = String(made.data.id);
  const thread = crypto.randomUUID();
  await run("INSERT INTO conversations (id, user_id, title, bot_id) VALUES ($1::uuid, $2::uuid, 't', $3::uuid)", [thread, user.id, id]);
  return { id, thread };
};

const usage = async (user: Person, micro: number, link: { job: string }, more: { status?: string; at?: string } = {}) => {
  await run(
    `INSERT INTO ai_usage (id, user_id, provider, model, managed, input_tokens, output_tokens, cost_micro_credits, status, job_id, created_at)
     VALUES ($1::uuid, $2::uuid, 'OPENROUTER', 'm', true, 1, 1, $3, $4, $5::uuid, COALESCE($6::timestamptz, now()))`,
    [crypto.randomUUID(), user.id, micro, more.status ?? "SETTLED", link.job, more.at ?? null]);
};

const chatJob = async (user: Person, thread: string): Promise<string> => {
  const id = crypto.randomUUID();
  await run(
    `INSERT INTO ai_jobs (id, type, queue, user_id, plan, status, max_attempts, payload, conversation_id)
     VALUES ($1::uuid, 'chat', 'q:chat', $2::uuid, 'PRO', 'DONE', 3, '{}'::jsonb, $3::uuid)`,
    [id, user.id, thread]);
  return id;
};

const billing = async (user: Person): Promise<Usage[]> => {
  const res = await db!.call(user, "GET", "/billing");
  assert.equal(res.status, 200);
  return res.data.usageByBot as Usage[];
};

test("usageByBot is an empty list when the user has no Bot usage", async (t) => {
  if (!db) return t.skip(SKIP);
  const user = await db.person("PRO");
  assert.deepEqual(await billing(user), []);
});

test("usageByBot sums this month's settled usage per Bot through its jobs, biggest first", async (t) => {
  if (!db) return t.skip(SKIP);
  const user = await db.person("PRO");
  const [small, large] = [await bot(user, "작은회사"), await bot(user, "큰회사")];
  await usage(user, 1_000_000, { job: await chatJob(user, small.thread) });
  await usage(user, 2_000_000, { job: await chatJob(user, large.thread) });
  await usage(user, 3_000_000, { job: await chatJob(user, large.thread) });
  const rows = await billing(user);
  assert.deepEqual(rows.map((r) => [r.id, r.usedMicroCredits]), [[large.id, 5_000_000], [small.id, 1_000_000]]);
  assert.ok(rows.every((r) => r.name.length > 0));
});

test("usageByBot leaves out unsettled rows, last month's rows, usage outside any Bot thread and Bots the user deleted", async (t) => {
  if (!db) return t.skip(SKIP);
  const user = await db.person("PRO");
  const [kept, gone] = [await bot(user, "남는회사"), await bot(user, "지운회사")];
  const job = await chatJob(user, kept.thread);
  await usage(user, 4_000_000, { job });
  await usage(user, 9_000_000, { job }, { status: "RESERVED" });
  await usage(user, 9_000_000, { job }, { at: "2000-01-15T00:00:00Z" });
  const plain = crypto.randomUUID();
  await run("INSERT INTO conversations (id, user_id, title) VALUES ($1::uuid, $2::uuid, 'plain')", [plain, user.id]);
  await usage(user, 9_000_000, { job: await chatJob(user, plain) });
  await usage(user, 9_000_000, { job: await chatJob(user, gone.thread) });
  await run("UPDATE bots SET deleted_at = now() WHERE id = $1::uuid", [gone.id]);
  assert.deepEqual((await billing(user)).map((r) => [r.id, r.usedMicroCredits]), [[kept.id, 4_000_000]]);
});

test("usageByBot never shows another user's Bot usage", async (t) => {
  if (!db) return t.skip(SKIP);
  const [mine, theirs] = [await db.person("PRO"), await db.person("PRO")];
  const other = await bot(theirs, "남의회사");
  await usage(theirs, 7_000_000, { job: await chatJob(theirs, other.thread) });
  assert.deepEqual(await billing(mine), []);
  assert.deepEqual((await billing(theirs)).map((r) => r.id), [other.id]);
});
