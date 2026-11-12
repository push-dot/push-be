// The materials routes of core on a migrated Postgres (BILLING_PG_URL). The sections, counts, search,
// bot filter and the 30-day bin are rules of the SQL, so only the real store shows them.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { after, before, test } from "node:test";

import { botsPg, type BotsPg, type Person } from "../test-support/bots-pg.ts";

const URL_ = process.env.BILLING_PG_URL;
const SKIP = "set BILLING_PG_URL to a migrated Postgres";
const AI_DIR = new URL("../../ai/", import.meta.url).pathname;

let db: BotsPg | undefined;
before(async () => { if (URL_) db = await botsPg(URL_); });
after(async () => { await db?.close(); });

type Item = Record<string, unknown> & { id: string };
type Section = { section: string; items: Item[]; nextCursor: string | null };

const sql = async (text: string, params: unknown[] = []) => (await db!.pg.query(text, params)).rows;

const file = async (user: Person, name: string, minutesAgo: number, more: { mime?: string; maker?: string } = {}): Promise<string> => {
  const id = crypto.randomUUID();
  await sql(
    `INSERT INTO sources (id, user_id, file_name, mime_type, size, sha256, path, created_at, content, page_count, created_by_bot_id)
     VALUES ($1, $2, $3, $4, 312000, 'h', 'db://sources/test', now() - make_interval(mins => $5), '\\x255044'::bytea, 2, $6)`,
    [id, user.id, name, more.mime ?? "application/pdf", minutesAgo, more.maker ?? null]);
  return id;
};

const doc = async (user: Person, title: string, minutesAgo: number, more: { status?: string; maker?: string } = {}): Promise<string> => {
  const id = crypto.randomUUID();
  await sql(
    `INSERT INTO documents (id, user_id, title, kind, template, status, created_at, updated_at, created_by_bot_id)
     VALUES ($1, $2, $3, 'RESUME', 'default', $4, now() - interval '1 day', now() - make_interval(mins => $5), $6)`,
    [id, user.id, title, more.status ?? "DRAFT", minutesAgo, more.maker ?? null]);
  return id;
};

const bookmark = async (user: Person, company: string, minutesAgo: number, status = "OPEN"): Promise<string> => {
  const posting = await db!.posting(company, status);
  await sql("INSERT INTO bookmarks (user_id, posting_id, created_at) VALUES ($1, $2, now() - make_interval(mins => $3))", [user.id, posting, minutesAgo]);
  return posting;
};

const link = async (user: Person, url: string, kind: string, minutesAgo: number, deleted = false): Promise<string> => {
  const id = crypto.randomUUID();
  await sql(
    `INSERT INTO user_links (id, user_id, kind, url, title, created_at, deleted_at)
     VALUES ($1, $2, $3, $4, '', now() - make_interval(mins => $5), CASE WHEN $6::boolean THEN now() END)`,
    [id, user.id, kind, url, minutesAgo, deleted]);
  return id;
};

const sectionsOf = (data: Record<string, unknown>): Section[] => data.sections as Section[];

const companyBot = async (user: Person, company: string): Promise<string> => {
  const bot = await db!.call(user, "POST", "/bots", { postingId: await db!.posting(company) });
  assert.equal(bot.status, 201);
  return String(bot.data.id);
};

// The turn that core queued, run by the AI service's own runtime: the same _persist that writes every reply.
const RUN_TURN = `
import asyncio, json, sys
from types import SimpleNamespace
from uuid import UUID
import asyncpg
from langgraph.checkpoint.memory import MemorySaver
from app.db import DB, _init_conn
from app.domain.services.conversation import ConversationService
from app.harness.jobs import run_queue_turn
from tests.harness_fakes import Gate

async def main(url, job_id):
    pool = await asyncpg.create_pool(url, init=_init_conn, min_size=0, max_size=2)
    try:
        db = DB(pool)
        svc = ConversationService(db, Gate(), checkpointer=MemorySaver())
        await db.q().execute("UPDATE ai_jobs SET status = 'RUNNING' WHERE id = $1", UUID(job_id))
        job = dict(await db.q().fetchrow("SELECT id, user_id, conversation_id, payload FROM ai_jobs WHERE id = $1", UUID(job_id)))
        if isinstance(job["payload"], str):
            job["payload"] = json.loads(job["payload"])

        async def emit(kind, payload):
            await svc.jobs.emit(job["id"], kind, payload)

        async def cancelled(_job_id):
            return False

        await run_queue_turn(svc, SimpleNamespace(job=job, emit=emit), cancelled)
    finally:
        await pool.close()

asyncio.run(main(sys.argv[1], sys.argv[2]))
`;

const aiServiceReady = (): boolean => spawnSync("uv", ["--version"]).status === 0;

/** Sends to the bot through core and lets the AI service finish the turn. */
const sendAndFinish = async (user: Person, botId: string, attachments: { kind: string; id: string }[]): Promise<void> => {
  const sent = await db!.call(user, "POST", `/bots/${botId}/messages/stream`, { text: "이 자료로 봐 줘", attachments });
  assert.equal(sent.status, 202, JSON.stringify(sent.error));
  const jobId = String((sent.data.result as { value: { jobId: string } }).value.jobId);
  const turn = spawnSync("uv", ["run", "--no-sync", "python", "-c", RUN_TURN, URL_!, jobId], { cwd: AI_DIR, encoding: "utf8" });
  assert.equal(turn.status, 0, turn.stderr);
  const [reply] = await sql("SELECT count(*)::int AS n FROM messages WHERE user_id = $1 AND role = 'ASSISTANT' AND operation_id IS NOT NULL", [user.id]);
  assert.ok(Number(reply.n) > 0, "the turn wrote its reply");
};

test("the 전체 tab previews 4 docs, 3 bookmarks and 3 links, and counts every section with and without q", async (t) => {
  if (!db) return t.skip(SKIP);
  const user = await db.person("PRO");
  const stranger = await db.person("PRO");
  const docs = [
    await file(user, "김서준_백엔드_이력서.pdf", 1),
    await doc(user, "백엔드 엔지니어 이력서", 2),
    await file(user, "경력기술서_2026.pdf", 3),
    await file(user, "Payment_retry.pdf", 4),
    await doc(user, "서버 개발자 이력서", 5),
    await file(user, "포트폴리오_결제시스템.pdf", 6),
    await doc(user, "자기소개서", 7),
    await file(user, "졸업증명서.pdf", 8),
  ];
  await file(user, "05_final_resume.md", 0, { mime: "text/plain" });
  await file(user, "notes", 0, { mime: "text/markdown" });
  await doc(user, "지운 이력서", 0, { status: "ARCHIVED" });
  await file(stranger, "남의_이력서.pdf", 0);
  const marks = [];
  for (const [index, company] of ["모아페이", "도토리증권", "KakaoPay", "한빛모빌리티", "소담헬스", "파도AI"].entries()) {
    marks.push(await bookmark(user, company, index + 1, index === 5 ? "CLOSED" : "OPEN"));
  }
  const links = [
    await link(user, "https://github.com/seojun-kim", "github", 1),
    await link(user, "https://seojun.dev/blog/payment-retry", "blog", 2),
    await link(user, "https://www.LinkedIn.com/in/seojun-kim", "other", 3),
  ];
  for (let index = 4; index <= 10; index += 1) links.push(await link(user, `https://seojun.dev/post/${index}`, "blog", index));
  await link(user, "https://deleted.example", "other", 0, true);

  const all = await db.call(user, "GET", "/materials");

  assert.equal(all.status, 200);
  assert.deepEqual(all.data.counts, { doc: 8, bookmark: 6, link: 10 });
  assert.deepEqual(sectionsOf(all.data).map((s) => [s.section, s.items.map((item) => item.id), s.nextCursor]), [
    ["doc", docs.slice(0, 4), null],
    ["bookmark", marks.slice(0, 3), null],
    ["link", links.slice(0, 3), null],
  ]);
  const [, , linkedIn] = sectionsOf(all.data)[2].items;
  assert.deepEqual({ linkKind: linkedIn.linkKind, host: linkedIn.host, title: linkedIn.title },
    { linkKind: "other", host: "www.linkedin.com", title: "https://www.LinkedIn.com/in/seojun-kim" });
  const bookmarks = await db.call(user, "GET", "/materials?tab=bookmark");
  assert.deepEqual(sectionsOf(bookmarks.data)[0].items.map((item) => [item.company, item.closed]), [
    ["모아페이", false], ["도토리증권", false], ["KakaoPay", false], ["한빛모빌리티", false], ["소담헬스", false], ["파도AI", true],
  ]);

  const pay = await db.call(user, "GET", "/materials?q=%20PAY%20");
  assert.deepEqual(pay.data.counts, { doc: 1, bookmark: 1, link: 1 }, "q ignores letter case and outer spaces in every section");
  assert.deepEqual(sectionsOf(pay.data).map((s) => s.items.map((item) => item.id)), [[docs[3]], [marks[2]], [links[1]]]);
  const resumes = await db.call(user, "GET", "/materials?tab=doc&q=이력서");
  assert.deepEqual(resumes.data.counts, { doc: 3, bookmark: 0, link: 0 });
  assert.deepEqual(sectionsOf(resumes.data).map((s) => [s.section, s.items.map((item) => item.id)]), [["doc", [docs[0], docs[1], docs[4]]]]);
});

test("a section tab pages files and documents together, newest first, with no short page", async (t) => {
  if (!db) return t.skip(SKIP);
  const user = await db.person("PRO");
  const expected: string[] = [];
  for (let minute = 1; minute <= 11; minute += 1) {
    expected.push(minute % 3 === 0 ? await doc(user, `문서 ${minute}`, minute) : await file(user, `파일 ${minute}.pdf`, minute));
    // A markdown note between every two rows: filtered after the LIMIT, it would make short pages.
    await file(user, `note-${minute}.md`, minute, { mime: "text/plain" });
  }

  const pages: string[][] = [];
  let cursor: string | null = "";
  while (cursor != null) {
    const page: { status: number; data: Record<string, unknown> } = await db.call(user, "GET", `/materials?tab=doc&limit=3${cursor ? `&cursor=${cursor}` : ""}`);
    assert.equal(page.status, 200);
    const [section] = sectionsOf(page.data);
    pages.push(section.items.map((item) => item.id));
    cursor = section.nextCursor;
  }

  assert.deepEqual(pages.map((page) => page.length), [3, 3, 3, 2]);
  assert.deepEqual(pages.flat(), expected);
});

test("a bot's materials are the ones its chat attached and the ones it made, after a real turn", async (t) => {
  if (!db) return t.skip(SKIP);
  if (!aiServiceReady()) return t.skip("needs uv and the synced services/ai environment");
  const user = await db.person("PRO");
  const moapay = await companyBot(user, "모아페이");
  const dotori = await companyBot(user, "도토리증권");
  const resume = await file(user, "김서준_백엔드_이력서.pdf", 5);
  const career = await file(user, "경력기술서_2026.pdf", 6);
  const made = await file(user, "모아페이_자기소개서.pdf", 7, { maker: moapay });
  const draft = await doc(user, "백엔드 엔지니어 이력서", 8);
  const saved = await bookmark(user, "모아페이", 9);
  const unsaved = await db.posting("누리클라우드");
  const links = [
    await link(user, "https://github.com/seojun-kim", "github", 10),
    await link(user, "https://seojun.dev", "portfolio", 11),
    await link(user, "https://linkedin.com/in/seojun-kim", "other", 12),
  ];
  await file(user, "아무 봇도 안 쓴 파일.pdf", 1);
  await link(user, "https://velog.io/@seojun", "blog", 1);

  await sendAndFinish(user, dotori, [{ kind: "file", id: resume }]);
  await sendAndFinish(user, moapay, [
    { kind: "file", id: resume }, { kind: "file", id: career }, { kind: "document", id: draft },
    { kind: "posting", id: saved }, { kind: "posting", id: unsaved }, ...links.map((id) => ({ kind: "link", id })),
  ]);

  const profile = await db.call(user, "GET", `/bots/${moapay}`);
  assert.equal(profile.data.materialCount, 8, "서류 4, 북마크 1, 링크 3: a posting that is not bookmarked is not a material");
  const listed = await db.call(user, "GET", `/materials?bot=${moapay}`);
  assert.deepEqual(listed.data.counts, { doc: 4, bookmark: 1, link: 3 });
  assert.deepEqual(sectionsOf(listed.data).map((s) => s.items.map((item) => item.id)), [[resume, career, made, draft], [saved], links]);
  assert.equal((await db.call(user, "GET", `/bots/${dotori}`)).data.materialCount, 1);
  assert.equal((await db.call(user, "GET", "/bots/push")).data.materialCount, 0);

  const ref = (id: string, name: string) => ({ id, kind: "company", displayName: name, color: "teal" });
  const used = await db.call(user, "GET", `/materials/file/${resume}`);
  assert.deepEqual(used.data.usedBy, [ref(moapay, "모아페이"), ref(dotori, "도토리증권")], "most recent chat first");
  assert.equal(used.data.createdBy, null);
  const own = await db.call(user, "GET", `/materials/file/${made}`);
  assert.deepEqual([own.data.createdBy, own.data.usedBy], [ref(moapay, "모아페이"), [ref(moapay, "모아페이")]]);

  assert.equal((await db.call(user, "DELETE", `/bots/${dotori}`)).status, 204);
  assert.deepEqual((await db.call(user, "GET", `/materials/file/${resume}`)).data.usedBy, [ref(moapay, "모아페이")], "a deleted bot's chat is gone with it");
  assert.equal((await db.call(user, "GET", "/materials?bot=" + dotori)).status, 404);
});

test("a material keeps its maker's name until the bot is deleted, then reads as made by no one known", async (t) => {
  if (!db) return t.skip(SKIP);
  const user = await db.person("PRO");
  const bot = await companyBot(user, "파도AI");
  const made = await doc(user, "파도AI 자기소개서 초안", 1, { maker: bot });

  const before = await db.call(user, "GET", `/materials/document/${made}`);
  assert.deepEqual([before.data.origin, before.data.createdBy, before.data.usedBy],
    ["AI", { id: bot, kind: "company", displayName: "파도AI", color: "teal" }, [{ id: bot, kind: "company", displayName: "파도AI", color: "teal" }]]);
  assert.deepEqual((await db.call(user, "GET", `/materials?bot=${bot}`)).data.counts, { doc: 1, bookmark: 0, link: 0 });

  assert.equal((await db.call(user, "DELETE", `/bots/${bot}`)).status, 204);
  const after = await db.call(user, "GET", `/materials/document/${made}`);
  assert.deepEqual([after.data.origin, after.data.createdBy, after.data.usedBy], ["AI", null, []]);
});

test("each kind's delete keeps the material, and restore brings it back as it was listed", async (t) => {
  if (!db) return t.skip(SKIP);
  const user = await db.person("PRO");
  const stranger = await db.person("PRO");
  const ids = {
    file: await file(user, "김서준_백엔드_이력서.pdf", 1),
    document: await doc(user, "백엔드 엔지니어 이력서", 2),
    posting: await bookmark(user, "모아페이", 3),
    link: await link(user, "https://github.com/seojun-kim", "github", 4),
  };
  await sql("INSERT INTO profiles (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING", [user.id]);
  await sql("UPDATE profiles SET resume_source_id = $2 WHERE user_id = $1", [user.id, ids.file]);
  const listed = Object.fromEntries(sectionsOf((await db.call(user, "GET", "/materials")).data).flatMap((s) => s.items.map((item) => [item.id, item])));

  for (const [kind, id] of Object.entries(ids)) {
    for (const method of ["GET", "DELETE"]) assert.equal((await db.call(stranger, method, `/materials/${kind}/${id}`)).status, 404, `${kind} is not the stranger's`);
    assert.equal((await db.call(stranger, "POST", `/materials/${kind}/${id}/restore`)).status, 404);

    assert.equal((await db.call(user, "DELETE", `/materials/${kind}/${id}`)).status, 204, kind);
    assert.equal((await db.call(user, "GET", `/materials/${kind}/${id}`)).status, 404, `${kind} is gone from its detail`);
    assert.equal((await db.call(user, "DELETE", `/materials/${kind}/${id}`)).status, 204, `${kind}: a second delete answers as the first`);
    assert.equal((await db.call(stranger, "DELETE", `/materials/${kind}/${id}`)).status, 404, `${kind}: a deleted material is not the stranger's either`);
  }
  assert.equal((await db.call(user, "DELETE", `/materials/link/${crypto.randomUUID()}`)).status, 404);
  assert.deepEqual((await db.call(user, "GET", "/materials")).data.counts, { doc: 0, bookmark: 0, link: 0 });
  const [pin] = await sql("SELECT resume_source_id FROM profiles WHERE user_id = $1", [user.id]);
  assert.equal(pin.resume_source_id, null);

  for (const [kind, id] of Object.entries(ids)) {
    const back = await db.call(user, "POST", `/materials/${kind}/${id}/restore`);
    assert.equal(back.status, 200, kind);
    const { updatedAt: _edited, ...restored } = back.data;
    const { updatedAt: _listed, ...before } = listed[id];
    assert.deepEqual(restored, before, `${kind} reads as it did before the delete`);
    assert.deepEqual((await db.call(user, "POST", `/materials/${kind}/${id}/restore`)).data, back.data, `${kind}: a second restore changes nothing`);
  }
  assert.deepEqual((await db.call(user, "GET", "/materials")).data.counts, { doc: 2, bookmark: 1, link: 1 });
  const [repinned] = await sql("SELECT resume_source_id FROM profiles WHERE user_id = $1", [user.id]);
  assert.equal(repinned.resume_source_id, ids.file, "the profile's resume is pinned again");
  const reread = await sql("SELECT payload->>'sourceId' AS source, payload->>'documentId' AS document FROM ai_jobs WHERE user_id = $1 AND type = 'ingest'", [user.id]);
  assert.deepEqual(reread.map((job) => job.source ?? job.document).sort(), [ids.document, ids.file].sort(), "a restored file and document are read again");
  assert.equal((await db.call(user, "POST", `/materials/file/${crypto.randomUUID()}/restore`)).status, 404);
});

test("a file that career evidence cites is refused alike by DELETE /sources and the materials delete", async (t) => {
  if (!db) return t.skip(SKIP);
  const user = await db.person("PRO");
  const cited = await file(user, "경력기술서_2026.pdf", 1);
  await sql(
    "INSERT INTO career_evidence (id, user_id, kind, title, source_text, provenance) VALUES ($1, $2, 'PROJECT', '결제', 't', $3::jsonb)",
    [crypto.randomUUID(), user.id, JSON.stringify({ sourceId: cited })]);

  for (const path of [`/sources/${cited}`, `/materials/file/${cited}`]) {
    const refused = await db.call(user, "DELETE", path);
    assert.equal(refused.status, 409, path);
    assert.deepEqual([refused.error?.code, refused.error?.details], ["INVALID_TRANSITION", { reason: "REFERENCED_BY_EVIDENCE", evidenceCount: 1 }], path);
  }
  assert.equal((await db.call(user, "GET", `/materials/file/${cited}`)).status, 200);
});

const archivedDoc = async (user: Person, finalized: boolean): Promise<string> => {
  const id = await doc(user, finalized ? "확정한 이력서" : "초안 이력서", 1, { status: "ARCHIVED" });
  if (finalized) {
    const version = crypto.randomUUID();
    await sql("INSERT INTO document_versions (id, document_id, user_id, number, content, blocks) VALUES ($1, $2, $3, 1, '{}'::jsonb, '[]'::jsonb)",
      [version, id, user.id]);
    await sql("UPDATE documents SET finalized_version_id = $2 WHERE id = $1", [id, version]);
  }
  return id;
};

test("a document is archived and restored alike by the documents routes and the materials routes", async (t) => {
  if (!db) return t.skip(SKIP);
  const user = await db.person("PRO");
  const routes = {
    documents: { archived: 200, archive: (id: string) => db!.call(user, "POST", `/documents/${id}/archive`, { expectedRevision: 1 }),
      restore: (id: string) => db!.call(user, "POST", `/documents/${id}/restore`, { expectedRevision: 1 }) },
    materials: { archived: 204, archive: (id: string) => db!.call(user, "DELETE", `/materials/document/${id}`),
      restore: (id: string) => db!.call(user, "POST", `/materials/document/${id}/restore`) },
  };
  const stateOf = async (id: string) => {
    const read = await db!.call(user, "GET", `/documents/${id}`);
    return [read.data.status, read.data.revision];
  };

  for (const [name, route] of Object.entries(routes)) {
    const live = await doc(user, "보관할 이력서", 1);
    assert.equal((await route.archive(live)).status, route.archived, name);
    assert.deepEqual(await stateOf(live), ["ARCHIVED", 2], `${name} archives once`);

    const finalized = await archivedDoc(user, true);
    const draft = await archivedDoc(user, false);
    for (const id of [finalized, draft]) assert.equal((await route.restore(id)).status, 200, name);
    assert.deepEqual([await stateOf(finalized), await stateOf(draft)], [["FINALIZED", 2], ["DRAFT", 2]], `${name} restores to the last state`);
    const reread = await sql("SELECT payload->>'documentId' AS id FROM ai_jobs WHERE user_id = $1 AND type = 'ingest' AND payload->>'documentId' = ANY($2)",
      [user.id, [finalized, draft]]);
    assert.deepEqual(reread.map((job) => job.id).sort(), [finalized, draft].sort(), `${name} reads a restored document again`);
  }
});

test("a link is deleted and restored alike by /me/links and the materials routes", async (t) => {
  if (!db) return t.skip(SKIP);
  const user = await db.person("PRO");
  const routes = {
    me: { remove: (id: string) => db!.call(user, "DELETE", `/me/links/${id}`), restore: (id: string) => db!.call(user, "POST", `/me/links/${id}/restore`) },
    materials: { remove: (id: string) => db!.call(user, "DELETE", `/materials/link/${id}`),
      restore: (id: string) => db!.call(user, "POST", `/materials/link/${id}/restore`) },
  };
  const listed = async (id: string): Promise<boolean[]> => [
    ((await db!.call(user, "GET", "/me/links")).data as unknown as Item[]).some((item) => item.id === id),
    sectionsOf((await db!.call(user, "GET", "/materials?tab=link")).data)[0].items.some((item) => item.id === id),
  ];

  for (const [name, route] of Object.entries(routes)) {
    const id = await link(user, `https://${name}.example.com/portfolio`, "portfolio", 1);
    assert.equal((await route.remove(id)).status, 204, name);
    assert.deepEqual(await listed(id), [false, false], `${name}: a deleted link leaves both lists`);
    const [kept] = await sql("SELECT deleted_at IS NOT NULL AS kept FROM user_links WHERE id = $1", [id]);
    assert.equal(kept?.kept, true, `${name}: the row is kept for the 30-day purge`);

    assert.equal((await route.restore(id)).status, 200, name);
    assert.deepEqual(await listed(id), [true, true], `${name}: a restored link is back in both lists`);
  }
});

type Answer = Awaited<ReturnType<BotsPg["call"]>>;

// Every backend waiting behind `pid`, directly or behind another waiter.
const WAITING = `WITH RECURSIVE behind(pid) AS (
    SELECT pid FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))
    UNION SELECT a.pid FROM pg_stat_activity a JOIN behind b ON b.pid = ANY(pg_blocking_pids(a.pid)))
  SELECT count(*)::int AS n FROM behind`;

/**
 * Two identical requests that overlap: a transaction holds the row the request locks first until both
 * requests wait for it, then lets them go. Left alone, the second one rarely starts before the first ends.
 */
const twoAtOnce = async (user: Person, method: string, path: string, hold: string, id: string): Promise<Answer[]> => {
  const { both } = await db!.pg.transaction!(async (tx) => {
    const [{ pid }] = (await tx("SELECT pg_backend_pid() AS pid")).rows;
    await tx(hold, [id]);
    const both = Promise.all([db!.call(user, method, path), db!.call(user, method, path)]);
    // Asked outside the holding transaction, which would keep reading pg_stat_activity as of its first look.
    const until = Date.now() + 10_000;
    while (Number((await sql(WAITING, [pid]))[0].n) < 2) {
      assert.ok(Date.now() < until, `both requests of ${method} ${path} wait on the held row`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return { both };
  });
  return both;
};

const HOLD_LIVE: Record<string, string> = {
  file: "SELECT 1 FROM sources WHERE id = $1 FOR UPDATE",
  document: "SELECT 1 FROM documents WHERE id = $1 FOR UPDATE",
  posting: "SELECT 1 FROM bookmarks WHERE posting_id = $1 FOR UPDATE",
  link: "SELECT 1 FROM user_links WHERE id = $1 FOR UPDATE",
};
const HOLD_DELETED: Record<string, string> = {
  ...HOLD_LIVE, file: "SELECT 1 FROM material_bin WHERE id = $1 FOR UPDATE", posting: "SELECT 1 FROM material_bin WHERE id = $1 FOR UPDATE",
};

const oneOfEach = async (user: Person) => ({
  file: await file(user, "포트폴리오_2026.pdf", 1),
  document: await doc(user, "한빛뱅크 자기소개서", 2),
  posting: await bookmark(user, "한빛뱅크", 3),
  link: await link(user, "https://velog.io/@seojun", "blog", 4),
});

test("two deletes of one material at once both answer 204 and delete it once", async (t) => {
  if (!db) return t.skip(SKIP);
  const user = await db.person("PRO");
  const ids = await oneOfEach(user);

  const answers: Record<string, number[]> = {};
  for (const [kind, id] of Object.entries(ids)) {
    answers[kind] = (await twoAtOnce(user, "DELETE", `/materials/${kind}/${id}`, HOLD_LIVE[kind], id)).map((answer) => answer.status);
  }

  assert.deepEqual(answers, { file: [204, 204], document: [204, 204], posting: [204, 204], link: [204, 204] });
  assert.deepEqual((await db.call(user, "GET", "/materials")).data.counts, { doc: 0, bookmark: 0, link: 0 });
  const [archived] = await sql("SELECT revision FROM documents WHERE id = $1", [ids.document]);
  assert.equal(Number(archived.revision), 2, "the document is archived once");
  for (const [kind, id] of Object.entries(ids)) {
    assert.equal((await db.call(user, "POST", `/materials/${kind}/${id}/restore`)).status, 200, `${kind} can be restored`);
  }
});

test("two restores of one material at once both answer it and restore it once", async (t) => {
  if (!db) return t.skip(SKIP);
  const user = await db.person("PRO");
  const ids = await oneOfEach(user);
  for (const [kind, id] of Object.entries(ids)) assert.equal((await db.call(user, "DELETE", `/materials/${kind}/${id}`)).status, 204, kind);

  for (const [kind, id] of Object.entries(ids)) {
    const answers = await twoAtOnce(user, "POST", `/materials/${kind}/${id}/restore`, HOLD_DELETED[kind], id);
    assert.deepEqual(answers.map((answer) => answer.status), [200, 200], kind);
    assert.deepEqual(answers[1].data, answers[0].data, `${kind}: both answer the same material`);
  }

  assert.deepEqual((await db.call(user, "GET", "/materials")).data.counts, { doc: 2, bookmark: 1, link: 1 });
  const [restored] = await sql("SELECT revision FROM documents WHERE id = $1", [ids.document]);
  assert.equal(Number(restored.revision), 3, "the document is restored once");
  const reread = await sql("SELECT payload->>'sourceId' AS source, payload->>'documentId' AS document FROM ai_jobs WHERE user_id = $1 AND type = 'ingest'", [user.id]);
  assert.deepEqual(reread.map((job) => job.source ?? job.document).sort(), [ids.document, ids.file].sort(), "each is read again once");
});

test("a posting bookmarked again after a delete can be deleted and restored again", async (t) => {
  if (!db) return t.skip(SKIP);
  const user = await db.person("PRO");
  const posting = await bookmark(user, "누리클라우드", 1);
  assert.equal((await db.call(user, "DELETE", `/materials/posting/${posting}`)).status, 204);
  assert.equal((await db.call(user, "POST", `/postings/${posting}/bookmark`)).status, 204);
  const again = await db.call(user, "GET", `/materials/posting/${posting}`);

  assert.equal((await db.call(user, "DELETE", `/materials/posting/${posting}`)).status, 204);
  const back = await db.call(user, "POST", `/materials/posting/${posting}/restore`);

  assert.equal(back.status, 200);
  assert.equal(back.data.bookmarkedAt, again.data.bookmarkedAt, "the newer bookmark comes back");
});

test("a bookmark restored after its posting is gone answers 404", async (t) => {
  if (!db) return t.skip(SKIP);
  const user = await db.person("PRO");
  const posting = await bookmark(user, "소담헬스", 1);
  assert.equal((await db.call(user, "DELETE", `/materials/posting/${posting}`)).status, 204);
  await sql("DELETE FROM job_postings WHERE id = $1", [posting]);

  assert.equal((await db.call(user, "POST", `/materials/posting/${posting}/restore`)).status, 404);
});
