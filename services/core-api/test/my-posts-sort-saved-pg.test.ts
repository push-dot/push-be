// MyPostsAllMenuFull on a migrated Postgres (BILLING_PG_URL): me/posts sorts, and a reader's saved posts. The order,
// the owner scoping and the idempotent save are rules of the SQL, so only the real schema shows them.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { botsPg } from '../test-support/bots-pg.ts';
import type { BotsPg, Person } from '../test-support/bots-pg.ts';

// Test data comes from JSON bodies and rows; the round trip types it without an assertion.
const viaJson = <T>(value: unknown): T => {
  const out: T = JSON.parse(JSON.stringify(value) ?? "null");
  return out;
};

const URL_ = process.env.BILLING_PG_URL;
const SKIP = "set BILLING_PG_URL to a migrated Postgres";

let db: BotsPg | undefined;
before(async () => { if (URL_) {db = await botsPg(URL_);} });
after(async () => { await db?.close(); });

const run = (sql: string, params: Array<unknown> = []) => db!.pg.query(sql, params);

const post = async (user: Person, title: string, more: { views?: number; comments?: number; minutesAgo?: number } = {}): Promise<string> => {
  const id = crypto.randomUUID();
  await run(
    `INSERT INTO posts (id, user_id, category, title, body, image_keys, view_count, search_text, search_choseong, search_jamo, created_at)
     VALUES ($1::uuid, $2::uuid, 'dev', $3, 'b', '[]'::jsonb, $4, '', '', '', now() - make_interval(mins => $5))`,
    [id, user.id, title, more.views ?? 0, more.minutesAgo ?? 0]);
  for (let i = 0; i < (more.comments ?? 0); i += 1) {
    await run("INSERT INTO post_comments (id, post_id, user_id, body) VALUES ($1::uuid, $2::uuid, $3::uuid, 'c')", [crypto.randomUUID(), id, user.id]);
  }
  return id;
};

const titles = async (user: Person, path: string): Promise<Array<string>> => {
  const res = await db!.call(user, "GET", path);
  assert.equal(res.status, 200);
  return (viaJson<Array<{ title: string }>>(res.body.data)).map((p) => p.title);
};

test("me/posts sorts by latest by default, then by views or comments", async (t) => {
  if (!db) {return t.skip(SKIP);}
  const me = await db.person("PRO");
  await post(me, "old but viewed", { views: 90, comments: 1, minutesAgo: 30 });
  await post(me, "new", { views: 5, comments: 0, minutesAgo: 1 });
  await post(me, "most talked", { views: 40, comments: 3, minutesAgo: 10 });
  assert.deepEqual(await titles(me, "/me/posts"), ["new", "most talked", "old but viewed"]);
  assert.deepEqual(await titles(me, "/me/posts?sort=latest"), ["new", "most talked", "old but viewed"]);
  assert.deepEqual(await titles(me, "/me/posts?sort=views"), ["old but viewed", "most talked", "new"]);
  assert.deepEqual(await titles(me, "/me/posts?sort=comments"), ["most talked", "old but viewed", "new"]);
});

test("me/posts rejects an unknown sort and never lists another author's post", async (t) => {
  if (!db) {return t.skip(SKIP);}
  const [me, other] = [await db.person("PRO"), await db.person("PRO")];
  await post(me, "mine");
  await post(other, "theirs", { views: 999 });
  const bad = await db.call(me, "GET", "/me/posts?sort=popular");
  assert.equal(bad.status, 422);
  assert.equal(bad.error?.code, "VALIDATION_ERROR");
  assert.deepEqual(await titles(me, "/me/posts?sort=views"), ["mine"]);
  const res = await db.call(me, "GET", "/me/posts?sort=views");
  assert.equal((viaJson<{ total: number }>(res.body.page)).total, 1);
});

test("a non-latest sort answers the first limit rows and no next page", async (t) => {
  if (!db) {return t.skip(SKIP);}
  const me = await db.person("PRO");
  for (const [i, views] of [30, 20, 10].entries()) {await post(me, `p${i}`, { views });}
  const res = await db.call(me, "GET", "/me/posts?sort=views&limit=2");
  assert.deepEqual((viaJson<Array<{ title: string }>>(res.body.data)).map((p) => p.title), ["p0", "p1"]);
  const page = viaJson<{ total: number; hasMore: boolean; nextCursor: string | null }>(res.body.page);
  assert.deepEqual([page.total, page.hasMore, page.nextCursor], [3, false, null]);
});

test("save and unsave are idempotent and list the post under me/saved-posts, newest save first", async (t) => {
  if (!db) {return t.skip(SKIP);}
  const [me, author] = [await db.person("PRO"), await db.person("PRO")];
  const [a, b] = [await post(author, "a", { views: 1 }), await post(author, "b", { views: 2 })];
  assert.equal((await db.call(me, "POST", `/posts/${a}/save`)).status, 204);
  assert.equal((await db.call(me, "POST", `/posts/${a}/save`)).status, 204);
  assert.equal((await db.call(me, "POST", `/posts/${b}/save`)).status, 204);
  assert.deepEqual(await titles(me, "/me/saved-posts"), ["b", "a"]);
  assert.deepEqual(await titles(me, "/me/saved-posts?sort=views"), ["b", "a"]);
  assert.equal((await db.call(me, "DELETE", `/posts/${b}/save`)).status, 204);
  assert.equal((await db.call(me, "DELETE", `/posts/${b}/save`)).status, 204);
  assert.deepEqual(await titles(me, "/me/saved-posts"), ["a"]);
  const rows = await run("SELECT count(*)::int AS n FROM post_saves WHERE user_id = $1::uuid", [me.id]);
  assert.equal(rows.rows[0].n, 1);
});

test("saved posts are the caller's own, and a missing post cannot be saved", async (t) => {
  if (!db) {return t.skip(SKIP);}
  const [me, other] = [await db.person("PRO"), await db.person("PRO")];
  const p = await post(other, "shared");
  await db.call(other, "POST", `/posts/${p}/save`);
  assert.deepEqual(await titles(me, "/me/saved-posts"), []);
  const missing = await db.call(me, "POST", `/posts/${crypto.randomUUID()}/save`);
  assert.equal(missing.status, 404);
  assert.equal((await db.call(me, "POST", "/posts/not-a-uuid/save")).status, 400);
});

test("saved posts page by the save time with a cursor", async (t) => {
  if (!db) {return t.skip(SKIP);}
  const [me, author] = [await db.person("PRO"), await db.person("PRO")];
  const ids = [await post(author, "one"), await post(author, "two"), await post(author, "three")];
  for (const id of ids) {await db.call(me, "POST", `/posts/${id}/save`);}
  const first = await db.call(me, "GET", "/me/saved-posts?limit=2");
  const page = viaJson<{ total: number; hasMore: boolean; nextCursor: string }>(first.body.page);
  assert.deepEqual((viaJson<Array<{ title: string }>>(first.body.data)).map((p) => p.title), ["three", "two"]);
  assert.deepEqual([page.total, page.hasMore], [3, true]);
  assert.deepEqual(await titles(me, `/me/saved-posts?limit=2&cursor=${encodeURIComponent(page.nextCursor)}`), ["one"]);
});

test("every Post response carries saved for the reader: detail, list, search, my lists, and false for a guest", async (t) => {
  if (!db) {return t.skip(SKIP);}
  const [me, other, author] = [await db.person("PRO"), await db.person("PRO"), await db.person("PRO")];
  const [kept, skipped] = [await post(author, "kept-saved-flag"), await post(author, "skipped-saved-flag")];
  await db.call(me, "POST", `/posts/${kept}/save`);
  const flags = async (who: Person, path: string): Promise<Record<string, boolean>> => {
    const res = await db!.call(who, "GET", path);
    assert.equal(res.status, 200);
    const rows = viaJson<Array<{ title: string; saved: boolean }>>((Array.isArray(res.body.data) ? res.body.data : [res.body.data]));
    return Object.fromEntries(rows.filter((p) => p.title.endsWith("-saved-flag")).map((p) => [p.title, p.saved]));
  };
  const expected = { "kept-saved-flag": true, "skipped-saved-flag": false };
  assert.deepEqual(await flags(me, "/posts?q=saved-flag"), expected);
  assert.deepEqual(await flags(me, "/search?type=posts&q=saved-flag"), expected);
  assert.deepEqual(await flags(me, `/posts/${kept}`), { "kept-saved-flag": true });
  assert.deepEqual(await flags(me, `/posts/${skipped}`), { "skipped-saved-flag": false });
  assert.deepEqual(await flags(me, "/me/saved-posts"), { "kept-saved-flag": true });
  assert.deepEqual(await flags(other, "/posts?q=saved-flag"), { "kept-saved-flag": false, "skipped-saved-flag": false });
  assert.deepEqual(await flags(author, "/me/posts"), { "kept-saved-flag": false, "skipped-saved-flag": false });
  const guest: Person = { id: "00000000-0000-0000-0000-000000000000", plan: "FREE" };
  assert.deepEqual(await flags(guest, "/posts?q=saved-flag"), { "kept-saved-flag": false, "skipped-saved-flag": false });
  await db.call(me, "DELETE", `/posts/${kept}/save`);
  assert.deepEqual(await flags(me, `/posts/${kept}`), { "kept-saved-flag": false });
});

test("deleting a post or a user takes their saves with them", async (t) => {
  if (!db) {return t.skip(SKIP);}
  const [me, author] = [await db.person("PRO"), await db.person("PRO")];
  const p = await post(author, "gone");
  await db.call(me, "POST", `/posts/${p}/save`);
  await run("DELETE FROM posts WHERE id = $1::uuid", [p]);
  assert.deepEqual(await titles(me, "/me/saved-posts"), []);
  const count = await run("SELECT count(*)::int AS n FROM post_saves WHERE post_id = $1::uuid", [p]);
  assert.equal(count.rows[0].n, 0);
});

test("me/commented-posts sorts like me/posts and rejects an unknown sort", async (t) => {
  if (!db) {return t.skip(SKIP);}
  const [me, author] = [await db.person("PRO"), await db.person("PRO")];
  const [old, fresh, talked, unread] = [
    await post(author, "old but viewed", { views: 90, comments: 1, minutesAgo: 30 }),
    await post(author, "new", { views: 5, minutesAgo: 1 }),
    await post(author, "most talked", { views: 40, comments: 3, minutesAgo: 10 }),
    await post(author, "not commented by me", { views: 500 }),
  ];
  for (const id of [old, fresh, talked]) {
    await run("INSERT INTO post_comments (id, post_id, user_id, body) VALUES ($1::uuid, $2::uuid, $3::uuid, 'c')", [crypto.randomUUID(), id, me.id]);
  }
  assert.ok(unread);
  assert.deepEqual(await titles(me, "/me/commented-posts"), ["new", "most talked", "old but viewed"]);
  assert.deepEqual(await titles(me, "/me/commented-posts?sort=views"), ["old but viewed", "most talked", "new"]);
  assert.deepEqual(await titles(me, "/me/commented-posts?sort=comments"), ["most talked", "old but viewed", "new"]);
  const bad = await db.call(me, "GET", "/me/commented-posts?sort=popular");
  assert.equal(bad.status, 422);
});
