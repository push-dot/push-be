// What an erase leaves behind, on a migrated Postgres (BILLING_PG_URL). The erase is one DELETE and the
// rest is foreign keys, so only the real schema can show what survives it.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { botsPg, type BotsPg, type Person } from "../test-support/bots-pg.ts";

const URL_ = process.env.BILLING_PG_URL;
const SKIP = "set BILLING_PG_URL to a migrated Postgres";

let db: BotsPg | undefined;
before(async () => { if (URL_) db = await botsPg(URL_); });
after(async () => { await db?.close(); });

const sentence = (): string => `지우면 남지 않아야 하는 문장 ${crypto.randomUUID()}`;

/** One finished turn in the bot's thread, with `text` in every column the services write chat text to. */
const seedTurn = async (user: Person, botId: string, text: string): Promise<{ thread: string; operation: string }> => {
  const [thread, job, notifyJob, operation, userMessage, assistantMessage] = Array.from({ length: 6 }, () => crypto.randomUUID());
  const quoted = JSON.stringify({ text });
  const run = (sql: string, params: unknown[]) => db!.pg.query(sql, params);
  await run(
    "INSERT INTO conversations (id, user_id, title, bot_id, resume_state) VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5::jsonb)",
    [thread, user.id, text.slice(0, 40), botId, quoted]);
  await run(
    `INSERT INTO ai_jobs (id, type, queue, user_id, plan, status, max_attempts, payload, result, conversation_id)
     VALUES ($1::uuid, 'chat', 'q:chat', $3::uuid, 'PRO', 'DONE', 3, $4::jsonb, $4::jsonb, $5::uuid),
            ($2::uuid, 'notify', 'q:notify', $3::uuid, 'PRO', 'QUEUED', 3, $4::jsonb, NULL, $5::uuid)`,
    [job, notifyJob, user.id, quoted, thread]);
  await run(
    "INSERT INTO chat_events (job_id, type, payload) VALUES ($1::uuid, 'status', '{\"text\":\"대기 중\"}'), ($1::uuid, 'token', $2::jsonb), ($1::uuid, 'done', '{}')",
    [job, quoted]);
  await run("INSERT INTO outbox (job_id, queue) VALUES ($1::uuid, 'q:notify')", [notifyJob]);
  await run("INSERT INTO credit_reservations (job_id, user_id, amount_micro, status) VALUES ($1::uuid, $2::uuid, 1000, 'SETTLED')", [job, user.id]);
  await run(
    `INSERT INTO messages (id, user_id, conversation_id, role, text, attachments, operation_id)
     VALUES ($1::uuid, $3::uuid, $4::uuid, 'USER', $5, $6::jsonb, $7::uuid), ($2::uuid, $3::uuid, $4::uuid, 'ASSISTANT', $5, '[]', $7::uuid)`,
    [userMessage, assistantMessage, user.id, thread, text, JSON.stringify([{ kind: "file", id: crypto.randomUUID(), title: text }]), operation]);
  await run(
    `INSERT INTO approvals (id, user_id, kind, target_id, payload_hash, status, conversation_id, title, tool_name, tool_args, job_id)
     VALUES ($1::uuid, $2::uuid, 'TOOL_ACTION', $1::uuid, 'h', 'APPROVED', $3::uuid, $4, 'read_page', $5::jsonb, $6::uuid)`,
    [crypto.randomUUID(), user.id, thread, text, quoted, job]);
  await run("INSERT INTO workspace_files (conversation_id, name, body) VALUES ($1::uuid, 'resume.md', $2)", [thread, text]);
  await run(
    "INSERT INTO operations (id, user_id, type, status, result) VALUES ($1::uuid, $2::uuid, 'CHAT_MESSAGE', 'SUCCEEDED', $3::jsonb)",
    [operation, user.id, JSON.stringify({ kind: "CHAT_MESSAGE", value: { assistantMessageId: assistantMessage, userMessageId: userMessage, approvalIds: [] } })]);
  await run(
    `INSERT INTO ai_usage (id, user_id, operation_id, provider, model, managed, input_tokens, output_tokens, status, job_id)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 'OPENROUTER', 'm', true, 10, 5, 'SETTLED', $4::uuid)`,
    [crypto.randomUUID(), user.id, operation, job]);
  await run(
    "INSERT INTO notifications (id, user_id, type, title, body, target, conversation_id) VALUES ($1::uuid, $2::uuid, 'AI_DONE', 'Bot 작업 완료', $3, $4::jsonb, $5::uuid)",
    [crypto.randomUUID(), user.id, text, JSON.stringify({ kind: "bot", id: botId }), thread]);
  await run("INSERT INTO bot_read_markers (user_id, bot_id, read_at) VALUES ($1::uuid, $2::uuid, now())", [user.id, botId]);
  return { thread, operation };
};

/** Every table of the schema that has a row containing `text`. It names no table, so a new copy of chat text is found. */
const tablesHolding = async (text: string): Promise<string[]> => {
  const tables = await db!.pg.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name");
  const holding: string[] = [];
  for (const { table_name: table } of tables.rows) {
    const hit = await db!.pg.query(`SELECT 1 FROM "${String(table)}" t WHERE t::text LIKE $1 LIMIT 1`, [`%${text}%`]);
    if (hit.rows.length > 0) holding.push(String(table));
  }
  return holding;
};

const SEEDED = ["ai_jobs", "approvals", "chat_events", "conversations", "messages", "notifications", "workspace_files"];

const usageRows = async (operation: string): Promise<number> => Number((await db!.pg.query(
  "SELECT count(*)::int AS n FROM ai_usage u JOIN operations o ON o.id = u.operation_id WHERE o.id = $1::uuid", [operation])).rows[0].n);

test("DELETE /bots/{id} leaves no row that holds a sentence of the chat", async (t) => {
  if (!db) return t.skip(SKIP);
  const user = await db.person("PRO");
  const [erased, kept] = [sentence(), sentence()];
  const bot = await db.call(user, "POST", "/bots", { postingId: await db.posting("모아페이") });
  const other = await db.call(user, "POST", "/bots", { postingId: await db.posting("Beta") });
  const turn = await seedTurn(user, String(bot.data.id), erased);
  await seedTurn(user, String(other.data.id), kept);
  assert.deepEqual(await tablesHolding(erased), SEEDED);

  assert.equal((await db.call(user, "DELETE", `/bots/${bot.data.id}`)).status, 204);

  assert.deepEqual(await tablesHolding(erased), []);
  assert.deepEqual(await tablesHolding(turn.thread), []);
  assert.equal(await usageRows(turn.operation), 1, "the month's usage row and its id-only operation stay");
  assert.deepEqual(await tablesHolding(kept), SEEDED, "another bot's chat is untouched");
  assert.equal((await db.call(user, "GET", `/bots/${bot.data.id}`)).status, 404);
  assert.equal((await db.call(user, "DELETE", `/bots/${bot.data.id}`)).status, 404);
  const again = await db.call(user, "POST", "/bots", { postingId: await db.posting("모아페이") });
  assert.equal(again.status, 201, "the company is free for a new bot");
});

test("DELETE /bots/{id}/transcript erases the Push Bot's chat and keeps the bot", async (t) => {
  if (!db) return t.skip(SKIP);
  const user = await db.person("PRO");
  const erased = sentence();
  const push = await db.call(user, "PATCH", "/bots/push", { expectedRevision: 1, notificationsMuted: true });
  const turn = await seedTurn(user, String(push.data.id), erased);
  assert.deepEqual(await tablesHolding(erased), SEEDED);

  assert.equal((await db.call(user, "DELETE", "/bots/push/transcript")).status, 204);

  assert.deepEqual(await tablesHolding(erased), []);
  assert.deepEqual(await tablesHolding(turn.thread), []);
  assert.equal(await usageRows(turn.operation), 1);
  const after = await db.call(user, "GET", "/bots/push");
  assert.deepEqual([after.status, after.data.id, after.data.notificationsMuted], [200, push.data.id, true]);
  const marker = await db.pg.query("SELECT 1 FROM bot_read_markers WHERE bot_id = $1::uuid", [push.data.id]);
  assert.equal(marker.rows.length, 1, "the read marker stays");
  assert.equal((await db.call(user, "DELETE", "/bots/push/transcript")).status, 204, "a bot with no thread");
});

const FOREIGN_KEY_VIOLATION = "23503";

test("a first send that races the delete of its bot leaves no thread and no message", async (t) => {
  if (!db) return t.skip(SKIP);
  const { pg, call } = db;
  const user = await db.person("ULTRA");
  const firstSend = (run: BotsPg["pg"]["query"], botId: string) => async (): Promise<void> => {
    const thread = crypto.randomUUID();
    await run(
      `INSERT INTO conversations (id, user_id, revision, title, pinned, archived, created_at, updated_at, bot_id, posting_id)
       SELECT $1::uuid, b.user_id, 1, b.display_name, false, false, now(), now(), b.id, b.posting_id FROM bots b WHERE b.id = $2::uuid
       ON CONFLICT (bot_id) WHERE bot_id IS NOT NULL DO NOTHING`,
      [thread, botId]);
    await run(
      "INSERT INTO messages (id, user_id, conversation_id, role, text) VALUES ($1::uuid, $2::uuid, $3::uuid, 'USER', '이 공고에 맞춰 줘')",
      [crypto.randomUUID(), user.id, thread]);
  };
  const round = async (n: number): Promise<void> => {
    const botId = crypto.randomUUID();
    await pg.query(
      "INSERT INTO bots (id, user_id, kind, company_name, display_name) VALUES ($1::uuid, $2::uuid, 'company', $1::uuid::text, 'race')",
      [botId, user.id]);
    const send = n % 2 === 0 ? firstSend(pg.query, botId) : () => pg.transaction!((q) => firstSend(q, botId)());
    const sent = () => send().catch((err: { code?: string }) => {
      if (err.code !== FOREIGN_KEY_VIOLATION) throw err;
    });
    const sendFirst = n % 4 < 2 ? sent() : undefined;
    const removing = call(user, "DELETE", `/bots/${botId}`);
    await (sendFirst ?? sent());
    assert.equal((await removing).status, 204);
  };
  for (let n = 0; n < 96; n += 8) await Promise.all(Array.from({ length: 8 }, (_, i) => round(n + i)));

  const left = await pg.query(
    `SELECT (SELECT count(*)::int FROM bots WHERE user_id = $1::uuid AND kind = 'company') AS bots,
            (SELECT count(*)::int FROM conversations WHERE user_id = $1::uuid) AS conversations,
            (SELECT count(*)::int FROM messages WHERE user_id = $1::uuid) AS messages`,
    [user.id]);
  assert.deepEqual(left.rows[0], { bots: 0, conversations: 0, messages: 0 });
});
