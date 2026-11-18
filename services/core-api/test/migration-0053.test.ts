// Runs 0053 on rows a database at 0052 can hold: two bots for one company, two conversations under one
// bot, a soft-deleted bot with a conversation, an employer-flagged bot thread, and operations that embed
// their messages. Needs BILLING_PG_URL with the right to create a database; the scratch database is
// dropped at the end.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

import { livePg } from "./parity/pg.ts";

const URL_ = process.env.BILLING_PG_URL;
const DIR = new URL("../../../db/migrations/", import.meta.url);
const TARGET = "0053_bot_identity.sql";

const id = (tail: string): string => `00000000-0000-4000-8000-0000000000${tail}`;

const SEED = `
INSERT INTO users (id, provider, provider_subject, display_name) VALUES ('${id("01")}', 'test', 'mig-u1', 'u1');
INSERT INTO companies (id, name) VALUES ('${id("c1")}', 'Acme');
INSERT INTO bots (id, user_id, kind, company_id, company_name, display_name, mascot_key, deleted_at, created_at) VALUES
  ('${id("b0")}', '${id("01")}', 'push',    NULL,          '',       'Push Bot', NULL,        NULL,         '2026-11-01'),
  ('${id("b1")}', '${id("01")}', 'company', NULL,          'Acme',   'Acme one', 'violet',    NULL,         '2026-11-02'),
  ('${id("b2")}', '${id("01")}', 'company', '${id("c1")}', ' ACME ', 'Acme two', 'a-key.png', NULL,         '2026-11-03'),
  ('${id("b3")}', '${id("01")}', 'company', NULL,          'Beta',   'Beta',     NULL,        NULL,         '2026-11-04'),
  ('${id("b4")}', '${id("01")}', 'company', NULL,          'Gamma',  'Gamma',    NULL,        '2026-11-05', '2026-11-04'),
  ('${id("b5")}', '${id("01")}', 'company', '${id("c1")}', '',       'By id',    NULL,        NULL,         '2026-11-06');
INSERT INTO conversations (id, user_id, title, archived, created_at, updated_at, bot_id, company_id) VALUES
  ('${id("a1")}', '${id("01")}', 'acme one',          false, '2026-11-02', '2026-11-06', '${id("b1")}', NULL),
  ('${id("a2")}', '${id("01")}', 'acme two',          false, '2026-11-03', '2026-11-03', '${id("b2")}', '${id("c1")}'),
  ('${id("a3")}', '${id("01")}', 'beta old',          false, '2026-11-04', '2026-11-04', '${id("b3")}', NULL),
  ('${id("a4")}', '${id("01")}', 'beta new archived', true,  '2026-11-05', '2026-11-07', '${id("b3")}', NULL),
  ('${id("a5")}', '${id("01")}', 'gamma',             false, '2026-11-04', '2026-11-04', '${id("b4")}', NULL),
  ('${id("a6")}', '${id("01")}', 'plain web chat',    false, '2026-11-01', '2026-11-01', NULL,          NULL);
INSERT INTO messages (id, user_id, conversation_id, role, text, created_at)
SELECT gen_random_uuid(), c.user_id, c.id, r.role, c.title, c.updated_at + r.later
FROM conversations c, (VALUES ('USER', interval '0'), ('ASSISTANT', interval '1 minute')) r(role, later);
INSERT INTO workspace_files (conversation_id, name, body) VALUES
  ('${id("a1")}', 'resume.md', 'kept'), ('${id("ff")}', 'resume.md', 'of a conversation that is gone');
INSERT INTO operations (id, user_id, type, status, result) VALUES
  ('${id("d1")}', '${id("01")}', 'CHAT_MESSAGE', 'SUCCEEDED', '{"kind":"CHAT_MESSAGE","value":{"approvalIds":[],
    "assistantMessage":{"id":"${id("f1")}","conversationId":"${id("a1")}","role":"ASSISTANT","text":"봇이 한 말"},
    "userMessage":{"id":"${id("f2")}","conversationId":"${id("a1")}","role":"USER","text":"내가 한 말"}}}'),
  ('${id("d2")}', '${id("01")}', 'CHAT_MESSAGE', 'SUCCEEDED', '{"kind":"CHAT_MESSAGE","value":{"approvalIds":[],
    "assistantMessage":{"id":"${id("f3")}","conversationId":"${id("a6")}","role":"ASSISTANT","text":"카드 답 뒤에 한 말"}}}'),
  ('${id("d3")}', '${id("01")}', 'JOB_ANALYSIS', 'SUCCEEDED', '{"kind":"JOB_ANALYSIS","value":{"job":{"title":"Backend"}}}');
INSERT INTO notifications (id, user_id, type, title, target) VALUES
  ('${id("e1")}', '${id("01")}', 'AI_DONE', 'done', '{"kind":"conversation","id":"${id("a1")}"}'),
  ('${id("e2")}', '${id("01")}', 'AI_DONE', 'done', '{"kind":"conversation","id":"${id("ff")}"}'),
  ('${id("e3")}', '${id("01")}', 'COMMENT', 'hi',   '{"kind":"post","id":"${id("a1")}"}');
`;

test("migration 0053 on duplicate company bots and several conversations per bot", async (t) => {
  if (!URL_) return t.skip("set BILLING_PG_URL to a Postgres that may create a database");
  const name = `mig0053_${crypto.randomUUID().replaceAll("-", "")}`;
  // One connection helper at a time: livePg points the driver at its own proxy.
  const asAdmin = async (sql: string): Promise<void> => {
    const admin = await livePg(URL_, 1);
    try {
      await admin.query(sql);
    } finally {
      await admin.close();
    }
  };
  await asAdmin(`CREATE DATABASE ${name}`);
  const scratch = new URL(URL_);
  scratch.pathname = `/${name}`;
  const db = await livePg(scratch.toString(), 1);
  const rows = async (sql: string) => (await db.query(sql)).rows;
  try {
    const earlier = readdirSync(DIR).filter((file) => file.endsWith(".sql") && file < TARGET).sort();
    for (const file of earlier) await db.query(readFileSync(new URL(file, DIR), "utf8"));
    await db.query(SEED);
    const before = await rows("SELECT (SELECT count(*)::int FROM messages) AS messages, (SELECT count(*)::int FROM conversations) AS conversations");

    await db.query(readFileSync(new URL(TARGET, DIR), "utf8"));

    assert.deepEqual(before, [{ messages: 12, conversations: 6 }]);
    assert.deepEqual(
      await rows("SELECT (SELECT count(*)::int FROM messages) AS messages, (SELECT count(*)::int FROM conversations) AS conversations"),
      before, "no message and no conversation is lost");
    assert.deepEqual(
      await rows("SELECT right(id::text, 2) AS bot, company_name, company_key, color, company_id, deleted_at IS NULL AS live FROM bots ORDER BY id"),
      [
        { bot: "b0", company_name: "", company_key: "", color: "teal", company_id: null, live: true },
        { bot: "b1", company_name: "Acme", company_key: "acme", color: "violet", company_id: null, live: true },
        { bot: "b2", company_name: " ACME ", company_key: "acme", color: "teal", company_id: null, live: false },
        { bot: "b3", company_name: "Beta", company_key: "beta", color: "teal", company_id: null, live: true },
        { bot: "b4", company_name: "Gamma", company_key: "gamma", color: "teal", company_id: null, live: false },
        { bot: "b5", company_name: "By id", company_key: "by id", color: "teal", company_id: null, live: true },
      ]);
    assert.deepEqual(
      await rows("SELECT right(id::text, 2) AS thread, right(bot_id::text, 2) AS bot, company_id, archived FROM conversations ORDER BY id"),
      [
        { thread: "a1", bot: "b1", company_id: null, archived: false },
        { thread: "a2", bot: null, company_id: null, archived: false },
        { thread: "a3", bot: null, company_id: null, archived: false },
        { thread: "a4", bot: "b3", company_id: null, archived: false },
        { thread: "a5", bot: null, company_id: null, archived: false },
        { thread: "a6", bot: null, company_id: null, archived: false },
      ]);
    assert.deepEqual(await rows("SELECT body FROM workspace_files"), [{ body: "kept" }]);
    assert.deepEqual(
      await rows("SELECT right(id::text, 2) AS notification, right(conversation_id::text, 2) AS thread FROM notifications ORDER BY id"),
      [{ notification: "e1", thread: "a1" }, { notification: "e2", thread: null }, { notification: "e3", thread: null }]);

    assert.deepEqual(
      await rows("SELECT right(id::text, 2) AS operation, result FROM operations ORDER BY id"),
      [
        { operation: "d1", result: { kind: "CHAT_MESSAGE", value: { assistantMessageId: id("f1"), userMessageId: id("f2"), approvalIds: [] } } },
        { operation: "d2", result: { kind: "CHAT_MESSAGE", value: { assistantMessageId: id("f3"), approvalIds: [] } } },
        { operation: "d3", result: { kind: "JOB_ANALYSIS", value: { job: { title: "Backend" } } } },
      ]);

    await assert.rejects(
      db.query(`INSERT INTO bots (id, user_id, kind, company_name, display_name) VALUES ('${id("b9")}', '${id("01")}', 'company', 'ACME', 'third')`),
      /bots_company_uidx/);
    await assert.rejects(
      db.query(`INSERT INTO conversations (id, user_id, title, bot_id) VALUES ('${id("a9")}', '${id("01")}', 'second', '${id("b1")}')`),
      /conversations_bot_thread_uidx/);
  } finally {
    await db.close();
    await asAdmin(`DROP DATABASE ${name} WITH (FORCE)`);
  }
});
