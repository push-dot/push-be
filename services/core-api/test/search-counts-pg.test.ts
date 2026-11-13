// The tab counts of /search/counts against the lists of /search, on a migrated Postgres (BILLING_PG_URL).
// A count that differs from its list is a SQL rule, so only the real store shows it.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { searchFields } from "../src/hangul.ts";
import { botsPg, type BotsPg, type Person } from "../test-support/bots-pg.ts";

const URL_ = process.env.BILLING_PG_URL;
const SKIP = "set BILLING_PG_URL to a migrated Postgres";

let db: BotsPg | undefined;
before(async () => { if (URL_) db = await botsPg(URL_); });
after(async () => {
  if (db) await db.pg.query("DELETE FROM search_queries WHERE term LIKE 'zq%'");
  await db?.close();
});

const sql = async (text: string, params: unknown[] = []) => (await db!.pg.query(text, params)).rows;

const profile = async (user: Person, headline: string, isPublic = true): Promise<void> => {
  const f = searchFields(headline);
  await sql("INSERT INTO profiles (user_id, headline, search_text, search_choseong, search_jamo) VALUES ($1,$2,$3,$4,$5)",
    [user.id, headline, f.text, f.choseong, f.jamo]);
  await sql("INSERT INTO user_settings (user_id, profile_public) VALUES ($1,$2) ON CONFLICT (user_id) DO UPDATE SET profile_public = $2",
    [user.id, isPublic]);
};

const post = async (author: Person, title: string): Promise<void> => {
  const f = searchFields(title);
  await sql("INSERT INTO posts (id, user_id, category, title, body, search_text, search_choseong, search_jamo) VALUES ($1,$2,'dev',$3,'b',$4,$5,$6)",
    [crypto.randomUUID(), author.id, title, f.text, f.choseong, f.jamo]);
};

const counts = async (user: Person | null, q: string) => {
  const res = await db!.call(user ?? { id: "00000000-0000-0000-0000-000000000000", plan: "FREE" }, "GET", `/search/counts?q=${encodeURIComponent(q)}`);
  assert.equal(res.status, 200);
  return res.data as { postings: number; people: number; posts: number };
};

const listLength = async (user: Person, type: string, q: string): Promise<number> => {
  const res = await db!.call(user, "GET", `/search?type=${type}&limit=100&q=${encodeURIComponent(q)}`);
  assert.equal(res.status, 200);
  return (res.body.data as unknown[]).length;
};

test("each tab count equals the length of its full list", { skip: URL_ ? false : SKIP }, async () => {
  const me = await db!.person("FREE");
  const [a, b, c, d] = [await db!.person("FREE"), await db!.person("FREE"), await db!.person("FREE"), await db!.person("FREE")];
  // zqkotlin: matches by text. zqprivate: the profile is private. me: the caller's own profile.
  await profile(a, "zqkotlin 개발자");
  await profile(b, "zqkotlin 백엔드", false);
  await profile(me, "zqkotlin 나");
  await profile(c, "ㅈㅋㅋㅈㅂㅇㅋ 초성");
  await profile(d, "자바 개발자");
  await post(a, "zqkotlin 후기");
  await post(a, "ㅈㅋㅋㅈㅂㅇㅋ 후기");
  await post(a, "무관한 글");
  await db!.posting("zqkotlin 컴퍼니");

  // Raw text, choseong and jamo prefix forms; every one must also match the list.
  for (const q of ["zqkotlin", "ㅈㅋㅋㅈㅂㅇㅋ", "ㅈㅏㅂㅏ", "자바", "없는검색어"]) {
    const got = await counts(me, q);
    assert.equal(got.people, await listLength(me, "people", q), `people for ${q}`);
    assert.equal(got.posts, await listLength(me, "posts", q), `posts for ${q}`);
    assert.equal(got.postings, await listLength(me, "postings", q), `postings for ${q}`);
  }
  const raw = await counts(me, "zqkotlin");
  assert.deepEqual(raw, { postings: 1, people: 1, posts: 1 });
});

test("counts leave the term unrecorded and give guests 0 people and posts", { skip: URL_ ? false : SKIP }, async () => {
  const me = await db!.person("FREE");
  const a = await db!.person("FREE");
  await profile(a, "zqguest 개발자");
  await post(a, "zqguest 글");
  const seen = async () => Number((await sql("SELECT count(*)::int AS n FROM search_queries WHERE term = 'zqguest'"))[0].n);
  assert.deepEqual(await counts(null, "zqguest"), { postings: 0, people: 0, posts: 0 });
  assert.deepEqual(await counts(me, "zqguest"), { postings: 0, people: 1, posts: 1 });
  assert.equal(await seen(), 0);
  assert.equal((await db!.call(me, "GET", "/search?type=people&q=zqguest")).status, 200);
  assert.equal(await seen(), 1);
});
