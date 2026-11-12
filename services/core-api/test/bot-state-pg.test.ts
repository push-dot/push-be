// A bot's state, the list order, search and the posting lookups, on a migrated Postgres (BILLING_PG_URL).
// The state is a view, so only the real schema can show what a bot reads as.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { after, before, describe, test } from "node:test";

import { botsPg, type BotsPg, type Person } from "../test-support/bots-pg.ts";
import { livePg } from "./parity/pg.ts";

const URL_ = process.env.BILLING_PG_URL;
const SKIP = "set BILLING_PG_URL to a migrated Postgres";

type Row = Record<string, unknown>;

const START = Math.floor(Date.now() / 1000) * 1000;

/** A whole second, `minutes` before this file started, as the routes print a time. */
const ago = (minutes: number): string => new Date(START - minutes * 60_000).toISOString().replace(".000Z", "Z");

/** Writers of one bot's thread, the way core and the AI service store a turn. */
const scene = (db: BotsPg, user: Person, botId: string) => {
  const run = (sql: string, params: unknown[]) => db.pg.query(sql, params);
  const thread = async (): Promise<string> => {
    await run(
      `INSERT INTO conversations (id, user_id, title, bot_id) VALUES ($1::uuid, $2::uuid, '', $3::uuid)
       ON CONFLICT (bot_id) WHERE bot_id IS NOT NULL DO NOTHING`,
      [crypto.randomUUID(), user.id, botId]);
    return String((await run("SELECT id FROM conversations WHERE bot_id = $1::uuid", [botId])).rows[0].id);
  };
  return {
    thread,
    say: async (role: "USER" | "ASSISTANT", text: string, when: string): Promise<string> => {
      const id = crypto.randomUUID();
      await run(
        "INSERT INTO messages (id, user_id, conversation_id, role, text, created_at) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::timestamptz)",
        [id, user.id, await thread(), role, text, when]);
      return id;
    },
    ask: async (card: { when: string; expires?: string; kind?: string; status?: string; title?: string }): Promise<string> => {
      const id = crypto.randomUUID();
      await run(
        `INSERT INTO approvals (id, user_id, kind, target_id, payload_hash, status, conversation_id, title, created_at, expires_at)
         VALUES ($1::uuid, $2::uuid, $3, $1::uuid, 'h', $4, $5::uuid, $6, $7::timestamptz, $8::timestamptz)`,
        [id, user.id, card.kind ?? "TOOL_ACTION", card.status ?? "PENDING", await thread(), card.title ?? "확인", card.when, card.expires ?? null]);
      return id;
    },
    job: async (status: string, when: string, statuses: Row[] = [], type = "chat"): Promise<void> => {
      const id = crypto.randomUUID();
      await run(
        `INSERT INTO ai_jobs (id, type, queue, user_id, plan, status, max_attempts, payload, conversation_id, created_at)
         VALUES ($1::uuid, $2, 'q:chat', $3::uuid, 'PRO', $4, 3, '{}', $5::uuid, $6::timestamptz)`,
        [id, type, user.id, status, await thread(), when]);
      for (const payload of statuses) {
        await run("INSERT INTO chat_events (job_id, type, payload) VALUES ($1::uuid, 'status', $2::jsonb), ($1::uuid, 'token', '{\"text\":\"a\"}')", [id, JSON.stringify(payload)]);
      }
    },
    read: (when: string) => run(
      `INSERT INTO bot_read_markers (user_id, bot_id, read_at) VALUES ($1::uuid, $2::uuid, $3::timestamptz)
       ON CONFLICT (user_id, bot_id) DO UPDATE SET read_at = EXCLUDED.read_at`,
      [user.id, botId, when]),
  };
};

type Scene = ReturnType<typeof scene>;

const QUEUED = { text: "대기 중", phase: "queued" };
const THINKING = { text: "생각 중", phase: "thinking" };
const working = (text: string): Row => ({ text, phase: "working" });

/** The named cases of the bot contract. `seed` writes the thread and answers the activity the bot must show. */
const CASES: Record<string, { unread: boolean; seed: (s: Scene, other: Scene) => Promise<Row | null> }> = {
  "fresh": { unread: false, seed: async (s) => { await s.thread(); return null; } },
  "read": {
    unread: false,
    seed: async (s) => { await s.say("USER", "질문", ago(9)); await s.say("ASSISTANT", "답", ago(8)); await s.read(ago(7)); return null; },
  },
  "own-message": {
    unread: false,
    seed: async (s) => { await s.say("ASSISTANT", "답", ago(9)); await s.read(ago(8)); await s.say("USER", "또 질문", ago(7)); return null; },
  },
  "unread": {
    unread: true,
    seed: async (s) => { await s.read(ago(9)); await s.say("ASSISTANT", "답", ago(8)); return null; },
  },
  "queued": {
    unread: false,
    seed: async (s, other) => {
      await other.job("RUNNING", ago(9), [THINKING]);
      await other.job("QUEUED", ago(8), [], "notify");
      await s.job("QUEUED", ago(5), [QUEUED]);
      await other.job("QUEUED", ago(1), [QUEUED]);
      return { phase: "queued", since: ago(5), ahead: 1 };
    },
  },
  "claimed": {
    unread: false,
    seed: async (s) => { await s.job("RUNNING", ago(5), [QUEUED]); return { phase: "thinking", since: ago(5), label: null }; },
  },
  "legacy-run": {
    unread: false,
    seed: async (s) => { await s.job("RUNNING", ago(5), [{ text: "대기 중" }]); return { phase: "thinking", since: ago(5), label: null }; },
  },
  "working": {
    unread: false,
    seed: async (s) => {
      await s.job("RUNNING", ago(5), [QUEUED, THINKING, working("공고 요건을 살펴보는 중"), THINKING, working("경력 섹션 고치는 중")]);
      return { phase: "working", since: ago(5), label: "경력 섹션 고치는 중" };
    },
  },
  "thinking-after-work": {
    unread: false,
    seed: async (s) => {
      await s.job("RUNNING", ago(5), [QUEUED, THINKING, working("공고 요건을 살펴보는 중"), THINKING]);
      return { phase: "thinking", since: ago(5), label: "공고 요건을 살펴보는 중" };
    },
  },
  "card": {
    unread: true,
    seed: async (s) => {
      await s.read(ago(9));
      await s.job("DONE", ago(8), [QUEUED, { text: "확인을 기다리고 있어요", phase: "waiting" }]);
      const cardId = await s.ask({ when: ago(6), expires: ago(-4), title: "이 변경을 이력서에 반영할까요?" });
      return { phase: "waiting", since: ago(6), for: "confirm", cardId, cardTitle: "이 변경을 이력서에 반영할까요?", expiresAt: ago(-4) };
    },
  },
  "card-read": {
    unread: false,
    seed: async (s) => {
      const cardId = await s.ask({ when: ago(6), kind: "RESUME_GATE", title: "어느 공고로 할까요?" });
      await s.read(ago(5));
      return { phase: "waiting", since: ago(6), for: "answer", cardId, cardTitle: "어느 공고로 할까요?", expiresAt: null };
    },
  },
  "card-expired": {
    unread: false,
    seed: async (s) => { await s.ask({ when: ago(20), expires: ago(10) }); await s.read(ago(5)); return null; },
  },
  "card-retried": {
    unread: true,
    seed: async (s) => {
      await s.read(ago(15));
      // A retry moves the card's asking time and its end, so the row reads as asked at the retry.
      const cardId = await s.ask({ when: ago(2), expires: ago(-8) });
      return { phase: "waiting", since: ago(2), for: "confirm", cardId, cardTitle: "확인", expiresAt: ago(-8) };
    },
  },
  "unread-and-working": {
    unread: true,
    seed: async (s) => {
      await s.read(ago(9));
      await s.say("ASSISTANT", "먼저 요건부터 볼게요", ago(8));
      await s.job("RUNNING", ago(5), [QUEUED, working("공고 요건을 살펴보는 중")]);
      return { phase: "working", since: ago(5), label: "공고 요건을 살펴보는 중" };
    },
  },
  "no-thread": { unread: false, seed: async () => null },
};

describe("bot state on the shared database", () => {
  let db: BotsPg | undefined;
  before(async () => { if (URL_) db = await botsPg(URL_); });
  after(async () => { await db?.close(); });

  const listed = async (user: Person): Promise<Row[]> => (await db!.call(user, "GET", "/bots")).data as unknown as Row[];
  const botOf = async (user: Person, id: unknown): Promise<Row> => (await listed(user)).find((bot) => bot.id === id)!;
  const made = async (user: Person, company: string): Promise<string> =>
    String((await db!.call(user, "POST", "/bots", { postingId: await db!.posting(company) })).data.id);

  test("a bot reads as its named case", async (t) => {
    if (!db) return t.skip(SKIP);
    assert.equal(Object.keys(CASES).length, 15);
    for (const [name, c] of Object.entries(CASES)) {
      const user = await db.person("PRO");
      const [bot, other] = [await made(user, "Acme"), await made(user, "Beta")];
      const activity = await c.seed(scene(db, user, bot), scene(db, user, other));
      const row = await botOf(user, bot);
      assert.deepEqual(row.activity, activity, name);
      assert.equal(row.unread, c.unread, name);
    }
  });

  test("a bot with no thread has no last message and was last active when it was made", async (t) => {
    if (!db) return t.skip(SKIP);
    const user = await db.person("PRO");
    const bot = await botOf(user, await made(user, "Acme"));
    assert.deepEqual([bot.lastMessage, bot.lastActivityAt, bot.lastMessagePreview, bot.status], [null, bot.createdAt, "", "DONE"]);
  });

  test("the last message is the newest of either author, cut to 140 characters", async (t) => {
    if (!db) return t.skip(SKIP);
    const user = await db.person("PRO");
    const id = await made(user, "Acme");
    await db.pg.query("UPDATE bots SET created_at = $2::timestamptz WHERE id = $1::uuid", [id, ago(60)]);
    const s = scene(db, user, id);
    await s.say("ASSISTANT", "가".repeat(200), ago(9));
    assert.deepEqual((await botOf(user, id)).lastMessage, { preview: "가".repeat(140), at: ago(9), fromBot: true });
    await s.say("USER", "고마워요", ago(8));
    const bot = await botOf(user, id);
    assert.deepEqual([bot.lastMessage, bot.lastActivityAt], [{ preview: "고마워요", at: ago(8), fromBot: false }, ago(8)]);
  });

  test("the list is the Push Bot, then the bots by last activity: a message or an open card moves a bot up, a PATCH does not", async (t) => {
    if (!db) return t.skip(SKIP);
    const user = await db.person("PRO");
    const ids: Record<string, string> = {};
    for (const [company, days] of [["Acme", 3], ["Beta", 2], ["Gamma", 1]] as const) {
      ids[company] = await made(user, company);
      await db.pg.query("UPDATE bots SET created_at = $2::timestamptz WHERE id = $1::uuid", [ids[company], ago(days * 1440)]);
    }
    const order = async (): Promise<unknown[]> => (await listed(user)).map((bot) => bot.displayName);
    assert.deepEqual(await order(), ["Push Bot", "Gamma", "Beta", "Acme"]);

    const patched = await db.call(user, "PATCH", `/bots/${ids.Acme}`, { expectedRevision: 1, displayName: "Acme coach", color: "coral" });
    assert.deepEqual([patched.status, patched.data.revision], [200, 2]);
    assert.deepEqual(await order(), ["Push Bot", "Gamma", "Beta", "Acme coach"], "an edit is not activity");

    await scene(db, user, ids.Beta).say("USER", "안녕", ago(60));
    assert.deepEqual(await order(), ["Push Bot", "Beta", "Gamma", "Acme coach"]);
    await scene(db, user, ids.Acme).ask({ when: ago(30) });
    assert.deepEqual(await order(), ["Push Bot", "Acme coach", "Beta", "Gamma"]);

    const push = (await listed(user))[0];
    await db.pg.query("UPDATE bots SET created_at = $2::timestamptz WHERE id = $1::uuid", [push.id, ago(10000)]);
    await scene(db, user, String(push.id)).say("ASSISTANT", "오래된 말", ago(9000));
    const now = await listed(user);
    assert.deepEqual([now[0].displayName, now[0].lastActivityAt], ["Push Bot", ago(9000)], "the Push Bot stays first whatever its activity");
  });

  test("the list carries the plan's limit and counts company bots only", async (t) => {
    if (!db) return t.skip(SKIP);
    const user = await db.person("FREE");
    await made(user, "Acme");
    const list = await db.call(user, "GET", "/bots");
    assert.deepEqual(list.body.limit, { plan: "FREE", max: 3, used: 1, table: { FREE: 3, PRO: 20, ULTRA: null } });
    assert.equal((list.data as unknown as Row[]).length, 2);
  });

  test("a soft-deleted bot is not listed, not counted and not searched", async (t) => {
    if (!db) return t.skip(SKIP);
    const user = await db.person("FREE");
    const [kept, gone] = [await made(user, "Acme"), await made(user, "Beta")];
    await scene(db, user, gone).say("ASSISTANT", "지워진 봇의 말", ago(5));
    await db.pg.query("UPDATE bots SET deleted_at = now() WHERE id = $1::uuid", [gone]);
    const list = await db.call(user, "GET", "/bots");
    assert.deepEqual((list.data as unknown as Row[]).map((bot) => bot.kind === "push" || bot.id), [true, kept]);
    assert.equal((list.body.limit as Row).used, 1);
    assert.equal((await db.call(user, "GET", `/bots/${gone}`)).status, 404);
    const found = (await db.call(user, "GET", `/bots/search?q=${encodeURIComponent("지워진")}`)).data;
    assert.deepEqual([found.messageTotal, found.botTotal], [0, 0]);
  });

  test("create and patch answer the bot with its live state", async (t) => {
    if (!db) return t.skip(SKIP);
    const user = await db.person("PRO");
    const postingId = await db.posting("Acme");
    const created = await db.call(user, "POST", "/bots", { postingId });
    assert.deepEqual([created.data.activity, created.data.unread, created.data.lastMessage], [null, false, null]);
    const s = scene(db, user, String(created.data.id));
    await s.say("ASSISTANT", "초안을 만들었어요", ago(3));
    await s.job("RUNNING", ago(2), [working("경력 섹션 고치는 중")]);
    for (const answer of [
      await db.call(user, "POST", "/bots", { postingId }),
      await db.call(user, "PATCH", `/bots/${created.data.id}`, { expectedRevision: 1, notificationsMuted: true }),
    ]) {
      assert.deepEqual(
        [answer.status, answer.data.activity, answer.data.unread, answer.data.status],
        [200, { phase: "working", since: ago(2), label: "경력 섹션 고치는 중" }, true, "RUNNING"]);
    }
  });

  test("GET /bots?postingId= finds the bot made from another posting of the same company, in any letter case", async (t) => {
    if (!db) return t.skip(SKIP);
    const [user, stranger] = [await db.person("PRO"), await db.person("PRO")];
    const bot = await made(user, "Moa Pay");
    await made(stranger, "Moa Pay");
    const found = await db.call(user, "GET", `/bots?postingId=${await db.posting("  moa PAY ")}`);
    assert.deepEqual([found.status, (found.data as unknown as Row[]).map((row) => row.id), "limit" in found.body], [200, [bot], false]);
    for (const postingId of [await db.posting("Beta"), await db.posting("Moa Pay", "DRAFT"), crypto.randomUUID()]) {
      assert.deepEqual((await db.call(user, "GET", `/bots?postingId=${postingId}`)).body, { data: [] });
    }
    assert.equal((await db.pg.query("SELECT 1 FROM bots WHERE user_id = $1::uuid AND kind = 'push'", [user.id])).rows.length, 0,
      "a lookup by posting makes no Push Bot");
  });

  test("GET /bots/{id} adds the posting and the newest fit score", async (t) => {
    if (!db) return t.skip(SKIP);
    const user = await db.person("PRO");
    const postingId = await db.posting("Acme");
    await db.pg.query("UPDATE job_postings SET title = '백엔드 엔지니어', deadline = '2026-11-20' WHERE id = $1::uuid", [postingId]);
    const id = (await db.call(user, "POST", "/bots", { postingId })).data.id;
    const detail = async (): Promise<Row> => (await db!.call(user, "GET", `/bots/${id}`)).data;
    assert.deepEqual(
      [(await detail()).posting, (await detail()).fit],
      [{ id: postingId, title: "백엔드 엔지니어", deadline: "2026-11-20", closed: false }, null]);

    for (const [score, when, plan] of [[6.5, ago(60), "FREE"], [8.1, ago(5), "PRO"]] as const) {
      const documentId = crypto.randomUUID();
      await db.pg.query(
        "INSERT INTO documents (id, user_id, title, kind, template) VALUES ($1::uuid, $2::uuid, 'resume', 'RESUME', 'SIMPLE')", [documentId, user.id]);
      await db.pg.query(
        `INSERT INTO posting_fit_cache (user_id, posting_id, document_id, fit_score, parts, plan, created_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, '{}', $5, $6::timestamptz)`,
        [user.id, postingId, documentId, score, plan, when]);
    }
    await db.pg.query("UPDATE job_postings SET closed_at = now(), status = 'CLOSED' WHERE id = $1::uuid", [postingId]);
    assert.deepEqual(
      [(await detail()).posting, (await detail()).fit],
      [{ id: postingId, title: "백엔드 엔지니어", deadline: "2026-11-20", closed: true }, { score: 8.1 }]);

    const push = (await db.call(user, "GET", "/bots/push")).data;
    assert.deepEqual([push.posting, push.fit, push.color], [null, null, null]);
    await db.pg.query("DELETE FROM job_postings WHERE id = $1::uuid", [postingId]);
    assert.deepEqual([(await detail()).posting, (await detail()).postingId], [null, null]);
  });

  test("search finds bots by name, company and posting title, and messages by text, in the caller's bot chats only", async (t) => {
    if (!db) return t.skip(SKIP);
    const [user, stranger] = [await db.person("PRO"), await db.person("PRO")];
    const postingId = await db.posting("모아페이");
    await db.pg.query("UPDATE job_postings SET title = '백엔드 엔지니어' WHERE id = $1::uuid", [postingId]);
    const moa = String((await db.call(user, "POST", "/bots", { postingId })).data.id);
    const dotori = await made(user, "도토리증권");
    const push = String((await db.call(user, "GET", "/bots/push")).data.id);
    const lead = "지난주에 올려 주신 이력서와 자기소개서를 다시 읽어 봤어요. 그리고 ";
    const inDotori = await scene(db, user, dotori).say("ASSISTANT", `${lead}모아페이 경력과 겹치는 부분을 정리했어요`, ago(60));
    const inPush = await scene(db, user, push).say("USER", "MOAPAY 말고 모아페이 공고 마감이 언제예요?", ago(1440));
    await scene(db, user, moa).say("ASSISTANT", "면접 예상 질문 12개를 정리했어요", ago(10));

    await scene(db, stranger, await made(stranger, "모아페이")).say("ASSISTANT", "모아페이 다른 사람의 대화", ago(5));
    const web = crypto.randomUUID();
    await db.pg.query("INSERT INTO conversations (id, user_id, title) VALUES ($1::uuid, $2::uuid, '모아페이 웹 대화')", [web, user.id]);
    await db.pg.query("INSERT INTO messages (id, user_id, conversation_id, role, text) VALUES ($1::uuid, $2::uuid, $3::uuid, 'USER', '모아페이 웹에서 한 말')",
      [crypto.randomUUID(), user.id, web]);

    const search = async (q: string): Promise<Row> => (await db!.call(user, "GET", `/bots/search?q=${encodeURIComponent(q)}`)).data;
    const found = await search("모아");
    assert.deepEqual(
      [(found.bots as Row[]).map((bot) => [bot.id, bot.line, bot.displayName]), found.botTotal],
      [[[moa, "모아페이 · 백엔드 엔지니어", "모아페이"]], 1]);
    assert.deepEqual([found.messages, found.messageTotal], [[
      { bot: { id: dotori, kind: "company", displayName: "도토리증권", color: "teal" }, messageId: inDotori, at: ago(60), role: "ASSISTANT",
        snippet: `…${[...lead].slice(-30).join("")}모아페이 경력과 겹치는 부분을 정리했어요` },
      { bot: { id: push, kind: "push", displayName: "Push Bot", color: null }, messageId: inPush, at: ago(1440), role: "USER",
        snippet: "MOAPAY 말고 모아페이 공고 마감이 언제예요?" },
    ], 2]);

    assert.deepEqual(((await search("백엔드")).bots as Row[]).map((bot) => bot.id), [moa], "by posting title");
    assert.deepEqual(((await search("push bot")).bots as Row[]).map((bot) => [bot.id, bot.line]), [[push, "Push Bot"]], "by name, any letter case");
    assert.deepEqual(((await search("moapay")).messages as Row[]).map((hit) => hit.messageId), [inPush], "message text, any letter case");
    const accented = await scene(db, user, moa).say("USER", "Résumé 초안을 봐 주세요", ago(3));
    assert.deepEqual(((await search("résumé 초안")).messages as Row[]).map((hit) => hit.messageId), [accented], "a cased letter outside ASCII");
    assert.deepEqual(await search("없는말"), { bots: [], botTotal: 0, messages: [], messageTotal: 0 });
  });

  test("search reads % and _ and a backslash in q as plain characters", async (t) => {
    if (!db) return t.skip(SKIP);
    const user = await db.person("PRO");
    const s = scene(db, user, await made(user, "100%_Co"));
    await made(user, "1000 Co");
    const said: Record<string, string> = {};
    for (const [i, text] of ["100% 완료", "1000 완료", "a_c", "abc", "C:\\temp"].entries()) said[text] = await s.say("ASSISTANT", text, ago(10 + i));
    const search = async (q: string): Promise<Row> => (await db!.call(user, "GET", `/bots/search?q=${encodeURIComponent(q)}`)).data;
    for (const [q, texts] of [["100%", ["100% 완료"]], ["a_c", ["a_c"]], ["\\", ["C:\\temp"]], ["%", ["100% 완료"]], ["_", ["a_c"]]] as const) {
      assert.deepEqual(((await search(q)).messages as Row[]).map((hit) => hit.messageId), texts.map((text) => said[text]), q);
    }
    assert.deepEqual(((await search("100%_")).bots as Row[]).map((bot) => bot.displayName), ["100%_Co"]);
  });

  test("search pages the message hits newest first and keeps the total", async (t) => {
    if (!db) return t.skip(SKIP);
    const user = await db.person("PRO");
    const s = scene(db, user, await made(user, "Acme"));
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) ids.push(await s.say(i % 2 ? "USER" : "ASSISTANT", `찾는말 ${i}`, ago(i < 2 ? 10 : 20 + i)));
    const newestFirst = [...ids.slice(0, 2).sort().reverse(), ...ids.slice(2)];
    const seen: unknown[] = [];
    let cursor: unknown = null;
    for (const size of [2, 2, 1]) {
      const page = await db.call(user, "GET", `/bots/search?q=${encodeURIComponent("찾는말")}&limit=2${cursor ? `&cursor=${cursor}` : ""}`);
      const hits = page.data.messages as Row[];
      assert.deepEqual([hits.length, page.data.messageTotal], [size, 5]);
      seen.push(...hits.map((hit) => hit.messageId));
      cursor = (page.body.page as Row).nextCursor;
      assert.equal((page.body.page as Row).hasMore, cursor !== null);
    }
    assert.deepEqual([seen, cursor], [newestFirst, null]);
  });

  test("link preview answers a posting Push has with its facts and the link's host, and not a draft or a blank company", async (t) => {
    if (!db) return t.skip(SKIP);
    const user = await db.person("PRO");
    const preview = async (url: string): Promise<Row> => (await db!.call(user, "POST", "/bots/link-preview", { url })).data;
    const link = `https://careers.moapay.example/jobs/${crypto.randomUUID()}`;
    const postingId = await db.posting("  모아페이 ");
    await db.pg.query(
      "UPDATE job_postings SET title = '백엔드 엔지니어', deadline = '2026-11-20', career_min = 3, career_max = NULL, location = '서울', source_url = $2 WHERE id = $1::uuid",
      [postingId, link]);
    const found = {
      status: "found", postingId, company: "모아페이", title: "백엔드 엔지니어",
      deadline: "2026-11-20", careerMin: 3, careerMax: null, location: "서울",
    };
    assert.deepEqual(await preview(`${link}/`), { ...found, host: "careers.moapay.example" });
    assert.deepEqual(await preview(`https://push.example/postings/${postingId}`), { ...found, host: "push.example" });

    for (const [company, status] of [["모아페이", "DRAFT"], ["   ", "OPEN"]] as const) {
      const hidden = await db.posting(company, status);
      const source = `https://careers.moapay.example/jobs/${crypto.randomUUID()}`;
      await db.pg.query("UPDATE job_postings SET source_url = $2 WHERE id = $1::uuid", [hidden, source]);
      for (const url of [source, `https://push.example/postings/${hidden}`]) {
        assert.deepEqual(await preview(url), { status: "not_a_posting" }, `${status} "${company}"`);
      }
    }
    assert.deepEqual(await preview("https://moapay.example/about"), { status: "not_a_posting" });
  });

  test("a bot's name is never blank: not from a posting's company, not from a typed name", async (t) => {
    if (!db) return t.skip(SKIP);
    const user = await db.person("PRO");
    const blank = await db.call(user, "POST", "/bots", { postingId: await db.posting("   ") });
    assert.equal(blank.status, 404);
    const spaced = await db.call(user, "POST", "/bots", { postingId: await db.posting("  Moa Pay ") });
    assert.deepEqual([spaced.status, spaced.data.displayName, spaced.data.companyName], [201, "Moa Pay", "Moa Pay"]);
    const typed = await db.call(user, "POST", "/bots", { postingId: await db.posting("Beta"), displayName: "   " });
    assert.deepEqual([typed.status, typed.error?.details.field], [400, "displayName"]);
    const renamed = await db.call(user, "PATCH", `/bots/${spaced.data.id}`, { expectedRevision: 1, displayName: "  " });
    assert.deepEqual([renamed.status, renamed.error?.details.field], [400, "displayName"]);
    const names = await db.pg.query("SELECT display_name FROM bots WHERE user_id = $1::uuid AND kind = 'company'", [user.id]);
    assert.deepEqual(names.rows, [{ display_name: "Moa Pay" }]);
  });
});

const DIR = new URL("../../../db/migrations/", import.meta.url);
const TARGET = "0054_bot_state.sql";
const OWNED = 5;
const OTHERS = { users: 20, botsEach: 100, perThread: 10 };
// Rows of a long thread that a state lookup must step over by index: tokens of a run, finished jobs, answered cards.
const HISTORY = 300;
const THREAD_TABLES = ["approvals", "ai_jobs", "messages", "chat_events"];

// 2,000 bots of other users, each with a thread of 10 messages, 10 cards and 10 chat jobs with their events.
const CROWD = `
INSERT INTO users (id, provider, provider_subject, display_name, plan)
SELECT gen_random_uuid(), 'test', 'crowd-' || n, 'crowd', 'ULTRA' FROM generate_series(1, ${OTHERS.users}) n;
INSERT INTO bots (id, user_id, kind, company_name, display_name)
SELECT gen_random_uuid(), u.id, 'company', 'company ' || n, 'company ' || n
FROM users u, generate_series(1, ${OTHERS.botsEach}) n WHERE u.display_name = 'crowd';
INSERT INTO conversations (id, user_id, title, bot_id)
SELECT gen_random_uuid(), b.user_id, '', b.id FROM bots b JOIN users u ON u.id = b.user_id WHERE u.display_name = 'crowd';
INSERT INTO messages (id, user_id, conversation_id, role, text, created_at)
SELECT gen_random_uuid(), c.user_id, c.id, CASE WHEN n % 2 = 0 THEN 'ASSISTANT' ELSE 'USER' END, 'crowd message ' || n, now() - n * interval '1 minute'
FROM conversations c, generate_series(1, ${OTHERS.perThread}) n WHERE c.bot_id IS NOT NULL;
INSERT INTO approvals (id, user_id, kind, target_id, payload_hash, status, conversation_id, created_at)
SELECT gen_random_uuid(), c.user_id, 'TOOL_ACTION', c.id, 'h', CASE WHEN n = 1 THEN 'PENDING' ELSE 'APPROVED' END, c.id, now() - n * interval '1 minute'
FROM conversations c, generate_series(1, ${OTHERS.perThread}) n WHERE c.bot_id IS NOT NULL;
INSERT INTO ai_jobs (id, type, queue, user_id, plan, status, max_attempts, payload, conversation_id, created_at)
SELECT gen_random_uuid(), 'chat', 'q:chat', c.user_id, 'ULTRA', CASE n WHEN 1 THEN 'RUNNING' WHEN 2 THEN 'QUEUED' ELSE 'DONE' END, 3, '{}', c.id, now() - n * interval '1 minute'
FROM conversations c, generate_series(1, ${OTHERS.perThread}) n WHERE c.bot_id IS NOT NULL;
INSERT INTO chat_events (job_id, type, payload)
SELECT j.id, e.type, e.payload::jsonb FROM ai_jobs j,
  (VALUES ('status', '{"text":"생각 중","phase":"thinking"}'), ('status', '{"text":"고치는 중","phase":"working"}'), ('token', '{"text":"a"}')) e(type, payload);
`;

type Plan = { "Node Type": string; "Relation Name"?: string; "Actual Rows": number; "Rows Removed by Filter"?: number; Plans?: Plan[] };
const nodesOf = (plan: Plan): Plan[] => [plan, ...(plan.Plans ?? []).flatMap(nodesOf)];

describe("bot state on a database of its own", () => {
  const name = `botstate_${crypto.randomUUID().replaceAll("-", "")}`;
  let db: BotsPg | undefined;

  // One connection helper at a time: livePg points the driver at its own proxy.
  const asAdmin = async (sql: string): Promise<void> => {
    const admin = await livePg(URL_!, 1);
    try {
      await admin.query(sql);
    } finally {
      await admin.close();
    }
  };

  const id = (tail: string): string => `00000000-0000-4000-8000-0000000000${tail}`;

  before(async () => {
    if (!URL_) return;
    await asAdmin(`CREATE DATABASE ${name}`);
    const url = new URL(URL_);
    url.pathname = `/${name}`;
    db = await botsPg(url.toString());
    const { query } = db.pg;
    const files = readdirSync(DIR).filter((file) => file.endsWith(".sql")).sort();
    for (const file of files.filter((file) => file < TARGET)) await query(readFileSync(new URL(file, DIR), "utf8"));
    // What code from before 0053 stored for a turn that finished after 0053 ran.
    await query(`
      INSERT INTO users (id, provider, provider_subject, display_name) VALUES ('${id("01")}', 'test', 'scrub', 'scrub');
      INSERT INTO operations (id, user_id, type, status, result) VALUES
        ('${id("d1")}', '${id("01")}', 'CHAT_MESSAGE', 'SUCCEEDED', '{"kind":"CHAT_MESSAGE","value":{"approvalIds":["${id("a1")}"],
          "assistantMessage":{"id":"${id("f1")}","conversationId":"${id("c1")}","role":"ASSISTANT","text":"봇이 한 말"},
          "userMessage":{"id":"${id("f2")}","conversationId":"${id("c1")}","role":"USER","text":"내가 한 말"}}}'),
        ('${id("d2")}', '${id("01")}', 'CHAT_MESSAGE', 'SUCCEEDED', '{"kind":"CHAT_MESSAGE","value":{"assistantMessageId":"${id("f3")}","approvalIds":[]}}'),
        ('${id("d3")}', '${id("01")}', 'JOB_ANALYSIS', 'SUCCEEDED', '{"kind":"JOB_ANALYSIS","value":{"job":{"title":"Backend"}}}');`);
    for (const file of files.filter((file) => file >= TARGET)) await query(readFileSync(new URL(file, DIR), "utf8"));
  });
  after(async () => {
    if (!URL_) return;
    await db?.pg.close();
    await asAdmin(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  });

  test("migration 0054 leaves no chat operation that holds a message", async (t) => {
    if (!db) return t.skip("set BILLING_PG_URL to a Postgres that may create a database");
    const { query } = db.pg;
    assert.deepEqual((await query("SELECT right(id::text, 2) AS operation, result FROM operations ORDER BY id")).rows, [
      { operation: "d1", result: { kind: "CHAT_MESSAGE", value: { assistantMessageId: id("f1"), userMessageId: id("f2"), approvalIds: [id("a1")] } } },
      { operation: "d2", result: { kind: "CHAT_MESSAGE", value: { assistantMessageId: id("f3"), approvalIds: [] } } },
      { operation: "d3", result: { kind: "JOB_ANALYSIS", value: { job: { title: "Backend" } } } },
    ]);
    assert.deepEqual(
      (await query("SELECT count(*)::int AS n FROM operations WHERE result::text LIKE '%한 말%'")).rows, [{ n: 0 }]);
  });

  test("the bot reads evaluate only the caller's bots and step over a thread's history by index", async (t) => {
    if (!db) return t.skip("set BILLING_PG_URL to a Postgres that may create a database");
    await db.pg.query(CROWD);
    const user = await db.person("PRO");
    const bots: string[] = [];
    const threads: string[] = [];
    for (let i = 0; i < OWNED; i += 1) {
      const id = String((await db.call(user, "POST", "/bots", { postingId: await db.posting(`mine ${i}`) })).data.id);
      const s = scene(db, user, id);
      await s.say("USER", "질문", ago(9));
      await s.say("ASSISTANT", "답", ago(8));
      await s.ask({ when: ago(7), status: i === 0 ? "PENDING" : "APPROVED" });
      await s.job(i === 1 ? "QUEUED" : "RUNNING", ago(6), [QUEUED, THINKING, working("고치는 중")]);
      bots.push(id);
      threads.push(await s.thread());
    }
    await db.pg.query(
      `INSERT INTO chat_events (job_id, type, payload)
       SELECT j.id, 'token', '{"text":"a"}' FROM ai_jobs j, generate_series(1, ${HISTORY}) WHERE j.user_id = $1::uuid`, [user.id]);
    await db.pg.query(
      `INSERT INTO ai_jobs (id, type, queue, user_id, plan, status, max_attempts, payload, conversation_id, created_at)
       SELECT gen_random_uuid(), 'chat', 'q:chat', $1::uuid, 'PRO', 'DONE', 3, '{}', $2::uuid, now() - n * interval '1 hour'
       FROM generate_series(1, ${HISTORY}) n`, [user.id, threads[2]]);
    await db.pg.query(
      `INSERT INTO approvals (id, user_id, kind, target_id, payload_hash, status, conversation_id, created_at)
       SELECT gen_random_uuid(), $1::uuid, 'TOOL_ACTION', $2::uuid, 'h', 'APPROVED', $2::uuid, now() - n * interval '1 hour'
       FROM generate_series(1, ${HISTORY}) n`, [user.id, threads[3]]);
    await db.pg.query("ANALYZE users, bots, conversations, messages, approvals, ai_jobs, chat_events, bot_read_markers");

    const sent: { sql: string; params: unknown[] }[] = [];
    const real = db.pg.query;
    db.pg.query = (sql, params = []) => {
      sent.push({ sql, params });
      return real(sql, params);
    };
    try {
      for (const path of ["/bots", `/bots/${bots[0]}`, `/bots?postingId=${await db.posting("MINE 2")}`, "/bots/search?q=mine"]) {
        assert.equal((await db.call(user, "GET", path)).status, 200, path);
      }
    } finally {
      db.pg.query = real;
    }
    const reads = sent.filter(({ sql }) => /bot_state_v|WITH hits/.test(sql));
    assert.equal(reads.length, 5, "the list, one bot, the bot of a posting, and the two halves of search");

    const owned = OWNED + 1;
    for (const { sql, params } of reads) {
      const explained = await real(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`, params);
      const nodes = nodesOf((explained.rows[0]["QUERY PLAN"] as { Plan: Plan }[])[0].Plan);
      const onBots = nodes.filter((node) => node["Relation Name"] === "bots");
      assert.ok(onBots.length > 0, sql);
      for (const node of onBots) {
        assert.ok(node["Actual Rows"] <= owned, `a scan of bots returned ${node["Actual Rows"]} rows for a caller with ${owned}: ${sql}`);
      }
      const onThreads = nodes.filter((node) => THREAD_TABLES.includes(node["Relation Name"] ?? ""));
      assert.deepEqual(onThreads.filter((node) => node["Node Type"] === "Seq Scan").map((node) => node["Relation Name"]), [], sql);
      const walked = onThreads
        .filter((node) => (node["Rows Removed by Filter"] ?? 0) >= HISTORY)
        .map((node) => `${node["Relation Name"]}: ${node["Rows Removed by Filter"]} rows read and dropped`);
      assert.deepEqual(walked, [], sql);
    }
  });
});
