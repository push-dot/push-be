// The bot chat routes of core on a migrated Postgres (BILLING_PG_URL). Sign-in is the dev token, so every
// statement runs for real: the thread's unique index, the cascades and the queued row are rules of the schema.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { enqueueResumeJob } from "../src/ai-jobs.ts";
import type { Query } from "../src/db.ts";
import { handle, type CoreEnv } from "../src/handler.ts";
import { uuid5Url } from "../src/http.ts";
import { botsPg, type BotsPg, type Person } from "../test-support/bots-pg.ts";

const URL_ = process.env.BILLING_PG_URL;
const SKIP = "set BILLING_PG_URL to a migrated Postgres";

let db: BotsPg | undefined;
before(async () => { if (URL_) db = await botsPg(URL_); });
after(async () => { await db?.close(); });

type Answer = { status: number; data: Record<string, unknown>; error?: { code: string; details: Record<string, unknown> | null } };

const envFor = (user: Person): CoreEnv => ({ APP_ENV: "development", DEV_AUTH_TOKEN: "dev", DEV_USER_ID: user.id, QUEUE_BACKEND: "redis" });

const call = async (user: Person, method: string, path: string, body?: unknown, run: Query = db!.pg.query, key: string = crypto.randomUUID()): Promise<Answer> => {
  const res = await handle(new Request("https://core.example/api/v1" + path, {
    method,
    headers: {
      authorization: "Bearer dev",
      "content-type": "application/json",
      ...(method === "POST" ? { "idempotency-key": key } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), envFor(user), { query: run, transaction: db!.pg.transaction, now: () => new Date() });
  const json = await res.json() as { data?: Record<string, unknown>; error?: Answer["error"] };
  return { status: res.status, data: json.data ?? {}, error: json.error };
};

const rows = async (sql: string, params: unknown[]): Promise<Record<string, unknown>[]> => (await db!.pg.query(sql, params)).rows;

const companyBot = async (user: Person, company: string): Promise<{ id: string; postingId: string }> => {
  const postingId = await db!.posting(company);
  const bot = await call(user, "POST", "/bots", { postingId });
  assert.equal(bot.status, 201);
  return { id: String(bot.data.id), postingId };
};

const threadsOf = (botId: string) => rows("SELECT id, user_id, title, company_id, posting_id FROM conversations WHERE bot_id = $1::uuid", [botId]);

const jobIdOf = (answer: Answer): string => String((answer.data.result as { value: { jobId: string } }).value.jobId);

const statusRows = (jobId: string) => rows(
  `SELECT e.payload, to_char(j.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS queued_at
   FROM chat_events e JOIN ai_jobs j ON j.id = e.job_id WHERE e.job_id = $1::uuid AND e.type = 'status'`, [jobId]);

const seedCard = async (user: Person, thread: string): Promise<string> => {
  const id = crypto.randomUUID();
  await db!.pg.query(
    `INSERT INTO approvals (id, user_id, kind, target_id, payload_hash, status, conversation_id, title, options, tool_name, tool_args)
     VALUES ($1::uuid, $2::uuid, 'TOOL_ACTION', $1::uuid, 'h', 'PENDING', $3::uuid, '지원할까요?', $4::jsonb, 'apply_to_posting', '{}')`,
    [id, user.id, thread, JSON.stringify([{ id: "approve", label: "지원" }, { id: "reject", label: "취소" }])]);
  return id;
};

test("two sends at once to a new bot create one thread", async (t) => {
  if (!db) return t.skip(SKIP);
  const user = await db.person("PRO");
  const bot = await companyBot(user, "모아페이");
  assert.deepEqual(await threadsOf(bot.id), [], "a bot has no thread before its first send");

  const sends = await Promise.all(["첫 번째", "두 번째"].map((text) => call(user, "POST", `/bots/${bot.id}/messages/stream`, { text })));

  assert.deepEqual(sends.map((send) => send.status), [202, 202]);
  const threads = await threadsOf(bot.id);
  assert.deepEqual(threads.map(({ id: _id, ...thread }) => thread),
    [{ user_id: user.id, title: "모아페이", company_id: null, posting_id: bot.postingId }]);
  const messages = await rows("SELECT text FROM messages WHERE conversation_id = $1::uuid ORDER BY text", [threads[0].id]);
  assert.deepEqual(messages.map((message) => message.text), ["두 번째", "첫 번째"]);
});

test("the Push Bot takes a send before it was ever listed", async (t) => {
  if (!db) return t.skip(SKIP);
  const user = await db.person("FREE");
  assert.equal((await call(user, "POST", "/bots/push/messages/stream", { text: "안녕" })).status, 202);
  const thread = await rows("SELECT b.kind FROM conversations c JOIN bots b ON b.id = c.bot_id WHERE c.user_id = $1::uuid", [user.id]);
  assert.deepEqual(thread, [{ kind: "push" }]);
});

test("a send stores its attachments with their titles and hands them to the run", async (t) => {
  if (!db) return t.skip(SKIP);
  const { pg } = db;
  const user = await db.person("PRO");
  const other = await db.person("PRO");
  const bot = await companyBot(user, "Attach");
  const [file, document, link, foreignFile, archived, deletedLink] = Array.from({ length: 6 }, () => crypto.randomUUID());
  await pg.query(
    `INSERT INTO sources (id, user_id, file_name, mime_type, size, sha256, path)
     VALUES ($1::uuid, $2::uuid, '김서준_이력서.pdf', 'application/pdf', 1, 'x', 'p'), ($3::uuid, $4::uuid, 'theirs.pdf', 'application/pdf', 1, 'x', 'p')`,
    [file, user.id, foreignFile, other.id]);
  await pg.query(
    `INSERT INTO documents (id, user_id, title, kind, template, status)
     VALUES ($1::uuid, $3::uuid, '백엔드 이력서', 'RESUME', 'SIMPLE', 'DRAFT'), ($2::uuid, $3::uuid, '옛 이력서', 'RESUME', 'SIMPLE', 'ARCHIVED')`,
    [document, archived, user.id]);
  await pg.query(
    `INSERT INTO user_links (id, user_id, kind, url, title, deleted_at)
     VALUES ($1::uuid, $3::uuid, 'github', 'https://github.com/seojun', '', NULL), ($2::uuid, $3::uuid, 'blog', 'https://blog.example/gone', '블로그', now())`,
    [link, deletedLink, user.id]);
  const refs = [{ kind: "file", id: file }, { kind: "document", id: document }, { kind: "posting", id: bot.postingId }, { kind: "link", id: link }];

  const sent = await call(user, "POST", `/bots/${bot.id}/messages/stream`, { text: "이 자료로 봐 줘", attachments: [...refs, refs[0]] });

  assert.equal(sent.status, 202);
  const [message] = await rows("SELECT attachments FROM messages WHERE user_id = $1::uuid AND role = 'USER'", [user.id]);
  assert.deepEqual(message.attachments, [
    { kind: "file", id: file, title: "김서준_이력서.pdf" },
    { kind: "document", id: document, title: "백엔드 이력서" },
    { kind: "posting", id: bot.postingId, title: "Attach · Backend" },
    { kind: "link", id: link, title: "https://github.com/seojun" },
  ]);
  const [job] = await rows("SELECT payload->'context' AS context FROM ai_jobs WHERE id = $1::uuid", [jobIdOf(sent)]);
  assert.deepEqual(job.context, {
    documentId: document, versionId: null, evidenceIds: [file], postingId: bot.postingId, urls: ["https://github.com/seojun"],
  });

  const fresh = await companyBot(user, "Gone");
  for (const gone of [{ kind: "file", id: foreignFile }, { kind: "document", id: archived }, { kind: "link", id: deletedLink }]) {
    const refused = await call(user, "POST", `/bots/${fresh.id}/messages/stream`, { text: "봐 줘", attachments: [refs[0], gone] });
    assert.deepEqual([refused.status, refused.error?.code, refused.error?.details], [409, "ATTACHMENT_GONE", gone], gone.kind);
  }
  const tooMany = await call(user, "POST", `/bots/${fresh.id}/messages/stream`,
    { text: "봐 줘", attachments: Array.from({ length: 11 }, () => ({ kind: "file", id: crypto.randomUUID() })) });
  assert.deepEqual([tooMany.status, tooMany.error?.details], [400, { field: "attachments" }]);
  const unknownKey = await call(user, "POST", `/bots/${fresh.id}/messages/stream`, { text: "봐 줘", context: { evidenceIds: [file] } });
  assert.equal(unknownKey.status, 400);
  assert.deepEqual(await threadsOf(fresh.id), [], "a refused send creates no thread");
});

test("a queued job starts with one status row that carries its phase, its start and the queue ahead", async (t) => {
  if (!db) return t.skip(SKIP);
  const user = await db.person("PRO");
  const first = await call(user, "POST", "/bots/push/messages/stream", { text: "하나" });
  const second = await call(user, "POST", "/bots/push/messages/stream", { text: "둘" });

  for (const [send, ahead] of [[first, 0], [second, 1]] as const) {
    const status = await statusRows(jobIdOf(send));
    assert.equal(status.length, 1);
    assert.deepEqual(status[0].payload, { text: "대기 중", phase: "queued", ahead, since: status[0].queued_at });
  }

  const key = crypto.randomUUID();
  const sends = [await call(user, "POST", "/bots/push/messages/stream", { text: "셋" }, db.pg.query, key),
    await call(user, "POST", "/bots/push/messages/stream", { text: "셋" }, db.pg.query, key)];
  assert.equal(jobIdOf(sends[0]), jobIdOf(sends[1]), "the same send again is the same job");
  assert.equal((await statusRows(jobIdOf(sends[0]))).length, 1);
  assert.equal((await rows("SELECT 1 FROM messages WHERE user_id = $1::uuid AND text = '셋'", [user.id])).length, 1);

  const [thread] = await rows("SELECT id FROM conversations WHERE user_id = $1::uuid", [user.id]);
  const url = new URL("https://core.example/");
  const resumed = await enqueueResumeJob({
    request: new Request(url), env: envFor(user), rid: "test", url, now: new Date(),
    user: { id: user.id } as never, deps: { query: db.pg.query, transaction: db.pg.transaction },
  }, { conversationId: String(thread.id), userId: user.id, payload: { resume: { approvalId: crypto.randomUUID(), optionId: "approve" } } });
  const status = await statusRows(resumed);
  assert.deepEqual(status.map((row) => row.payload), [{ text: "대기 중", phase: "queued", ahead: 3, since: status[0].queued_at }]);
});

test("without consent a send creates no thread and a card answer starts no run", async (t) => {
  if (!db) return t.skip(SKIP);
  const stranger = await db.person("PRO", false);
  const refused = await call(stranger, "POST", "/bots/push/messages/stream", { text: "안녕" });
  assert.deepEqual([refused.status, refused.error?.code], [403, "CONSENT_REQUIRED"]);
  assert.deepEqual(await rows("SELECT id FROM conversations WHERE user_id = $1::uuid", [stranger.id]), []);

  const user = await db.person("PRO");
  await call(user, "POST", "/bots/push/messages/stream", { text: "지원해 줘" });
  const [thread] = await rows("SELECT id FROM conversations WHERE user_id = $1::uuid", [user.id]);
  const card = await seedCard(user, String(thread.id));
  await db.pg.query("UPDATE user_consents SET reference_data = false WHERE user_id = $1::uuid", [user.id]);

  const answer = await call(user, "POST", `/bots/push/approvals/${card}`, { optionId: "approve" });

  assert.deepEqual([answer.status, answer.error?.code], [403, "CONSENT_REQUIRED"]);
  assert.deepEqual(await rows("SELECT status FROM approvals WHERE id = $1::uuid", [card]), [{ status: "PENDING" }]);
  assert.equal((await rows("SELECT id FROM ai_jobs WHERE user_id = $1::uuid", [user.id])).length, 1, "only the send's job");
});

test("a card is answered by bot, and the answer names no job", async (t) => {
  if (!db) return t.skip(SKIP);
  const user = await db.person("PRO");
  const empty = await companyBot(user, "NoThread");
  assert.equal((await call(user, "POST", `/bots/${empty.id}/approvals/${crypto.randomUUID()}`, { optionId: "approve" })).status, 404);

  const bot = await companyBot(user, "Card");
  await call(user, "POST", `/bots/${bot.id}/messages/stream`, { text: "지원해 줘" });
  const [thread] = await threadsOf(bot.id);
  const card = await seedCard(user, String(thread.id));
  const elsewhere = await call(user, "POST", `/bots/push/approvals/${card}`, { optionId: "approve" });
  assert.equal(elsewhere.status, 404, "a card of another bot's thread");

  const answer = await call(user, "POST", `/bots/${bot.id}/approvals/${card}`, { optionId: "approve" });

  assert.deepEqual([answer.status, answer.data], [202, { id: card, status: "APPROVED", optionId: "approve" }]);
  const resumed = await rows("SELECT payload->'resume' AS resume FROM ai_jobs WHERE conversation_id = $1::uuid AND payload ? 'resume'", [thread.id]);
  assert.deepEqual(resumed, [{ resume: { approvalId: card, optionId: "approve" } }]);
  const again = await call(user, "POST", `/bots/${bot.id}/approvals/${card}`, { optionId: "approve" });
  assert.deepEqual([again.status, again.error?.code], [409, "APPROVAL_ALREADY_RESOLVED"]);
});

// The bot is deleted from another session just before the named statement of the send runs.
const CUTS: [name: string, before: RegExp][] = [
  ["before its thread is made", /^INSERT INTO conversations/],
  ["after its thread is made", /^SELECT c\.id, c\.company_id, co\.plan AS company_plan/],
  ["before its job is queued", /^SELECT count\(\*\)::int AS n FROM ai_jobs WHERE queue/],
  ["after its job is queued", /^WITH conv AS/],
];

for (const [name, before_] of CUTS) {
  test(`a send whose bot is deleted ${name} answers 404 and leaves no row`, async (t) => {
    if (!db) return t.skip(SKIP);
    const { pg } = db;
    const user = await db.person("PRO");
    const bot = await companyBot(user, `Race ${name}`);
    let cut = false;
    const run: Query = async (sql, params) => {
      if (!cut && before_.test(sql.trim())) {
        cut = true;
        await pg.query("DELETE FROM bots WHERE id = $1::uuid", [bot.id]);
      }
      return pg.query(sql, params);
    };

    const sent = await call(user, "POST", `/bots/${bot.id}/messages/stream`, { text: "이 공고에 맞춰 줘" }, run);

    assert.equal(cut, true, "the send reached the statement");
    assert.deepEqual([sent.status, sent.error?.code], [404, "NOT_FOUND"]);
    for (const table of ["conversations", "messages", "ai_jobs", "credit_reservations"]) {
      assert.deepEqual(await rows(`SELECT 1 FROM ${table} WHERE user_id = $1::uuid`, [user.id]), [], table);
    }
  });
}

test("find in chat returns the matching messages newest first, each with its turn", async (t) => {
  if (!db) return t.skip(SKIP);
  const user = await db.person("PRO");
  const bot = await companyBot(user, "Find");
  assert.deepEqual((await call(user, "GET", `/bots/${bot.id}/transcript/matches?q=x`)).data, { total: 0, items: [] }, "no thread yet");
  const first = await call(user, "POST", `/bots/${bot.id}/messages/stream`, { text: "결제 서버 100%_경험을 강조해 줘" });
  const second = await call(user, "POST", `/bots/${bot.id}/messages/stream`, { text: "다른 이야기" });
  const [thread] = await threadsOf(bot.id);
  const assistantId = await uuid5Url(`push:chat:${jobIdOf(second)}:assistant`);
  await db.pg.query(
    "INSERT INTO messages (id, user_id, conversation_id, role, text, created_at) VALUES ($1::uuid, $2::uuid, $3::uuid, 'ASSISTANT', '결제 서버 경험을 앞에 뒀어요', now() + interval '1 second')",
    [assistantId, user.id, thread.id]);

  const found = await call(user, "GET", `/bots/${bot.id}/transcript/matches?q=${encodeURIComponent("결제 서버")}`);

  assert.equal(found.status, 200);
  const items = found.data.items as { messageId: string; turnId: string; at: string }[];
  assert.deepEqual([found.data.total, items.map((item) => [item.messageId, item.turnId])], [2, [
    [assistantId, jobIdOf(second)],
    [await uuid5Url(`push:chat:${jobIdOf(first)}:user`), jobIdOf(first)],
  ]]);
  assert.ok(items.every((item) => !Number.isNaN(Date.parse(item.at))));
  const totalFor = async (q: string): Promise<unknown> =>
    (await call(user, "GET", `/bots/${bot.id}/transcript/matches?q=${encodeURIComponent(q)}`)).data.total;
  assert.deepEqual([await totalFor("100%_경험"), await totalFor("결제%강조"), await totalFor("100_")], [1, 0, 0], "% and _ are text, not wildcards");
  assert.equal(await totalFor("서버 경험을 앞에"), 1);
  assert.equal((await call(user, "GET", `/bots/${bot.id}/transcript/matches`)).status, 400);
  assert.equal((await call(await db.person("PRO"), "GET", `/bots/${bot.id}/transcript/matches?q=x`)).status, 404, "another user's bot");
});
