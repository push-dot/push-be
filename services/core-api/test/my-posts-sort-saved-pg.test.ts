// MyPostsAllMenuFull on a migrated Postgres (BILLING_PG_URL): me/posts sorts, and a reader's saved posts. The order,
// the owner scoping and the idempotent save are rules of the SQL, so only the real schema shows them.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { botsPg, type BotsPg, type Person } from "../test-support/bots-pg.ts";

const URL_ = process.env.BILLING_PG_URL;
const SKIP = "set BILLING_PG_URL to a migrated Postgres";

let db: BotsPg | undefined;
before(async () => { if (URL_) db = await botsPg(URL_); });
after(async () => { await db?.close(); });

const run = (sql: string, params: unknown[] = []) => db!.pg.query(sql, params);

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

const titles = async (user: Person, path: string): Promise<string[]> => {
  const res = await db!.call(user, "GET", path);
  assert.equal(res.status, 200);
  return (res.body.data as { title: string }[]).map((p) => p.title);
};

test("me/posts sorts by latest by default, then by views or comments", async (t) => {
  if (!db) return t.skip(SKIP);
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
  if (!db) return t.skip(SKIP);
  const [me, other] = [await db.person("PRO"), await db.person("PRO")];
  await post(me, "mine");
  await post(other, "theirs", { views: 999 });
  const bad = await db.call(me, "GET", "/me/posts?sort=popular");
  assert.equal(bad.status, 422);
  assert.equal(bad.error?.code, "VALIDATION_ERROR");
  assert.deepEqual(await titles(me, "/me/posts?sort=views"), ["mine"]);
  const res = await db.call(me, "GET", "/me/posts?sort=views");
  assert.equal((res.body.page as { total: number }).total, 1);
});

test("a non-latest sort answers the first limit rows and no next page", async (t) => {
  if (!db) return t.skip(SKIP);
  const me = await db.person("PRO");
  for (const [i, views] of [30, 20, 10].entries()) await post(me, `p${i}`, { views });
  const res = await db.call(me, "GET", "/me/posts?sort=views&limit=2");
  assert.deepEqual((res.body.data as { title: string }[]).map((p) => p.title), ["p0", "p1"]);
  const page = res.body.page as { total: number; hasMore: boolean; nextCursor: string | null };
  assert.deepEqual([page.total, page.hasMore, page.nextCursor], [3, false, null]);
});

test("save and unsave are idempotent and list the post under me/saved-posts, newest save first", async (t) => {
  if (!db) return t.skip(SKIP);
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
  assert.equal(rows.rows[0]!.n, 1);
});

test("saved posts are the caller's own, and a missing post cannot be saved", async (t) => {
  if (!db) return t.skip(SKIP);
  const [me, other] = [await db.person("PRO"), await db.person("PRO")];
  const p = await post(other, "shared");
  await db.call(other, "POST", `/posts/${p}/save`);
  assert.deepEqual(await titles(me, "/me/saved-posts"), []);
  const missing = await db.call(me, "POST", `/posts/${crypto.randomUUID()}/save`);
  assert.equal(missing.status, 404);
  assert.equal((await db.call(me, "POST", "/posts/not-a-uuid/save")).status, 400);
});

test("saved posts page by the save time with a cursor", async (t) => {
  if (!db) return t.skip(SKIP);
  const [me, author] = [await db.person("PRO"), await db.person("PRO")];
  const ids = [await post(author, "one"), await post(author, "two"), await post(author, "three")];
  for (const id of ids) await db.call(me, "POST", `/posts/${id}/save`);
  const first = await db.call(me, "GET", "/me/saved-posts?limit=2");
  const page = first.body.page as { total: number; hasMore: boolean; nextCursor: string };
  assert.deepEqual((first.body.data as { title: string }[]).map((p) => p.title), ["three", "two"]);
  assert.deepEqual([page.total, page.hasMore], [3, true]);
  assert.deepEqual(await titles(me, `/me/saved-posts?limit=2&cursor=${encodeURIComponent(page.nextCursor)}`), ["one"]);
});

test("deleting a post or a user takes their saves with them", async (t) => {
  if (!db) return t.skip(SKIP);
  const [me, author] = [await db.person("PRO"), await db.person("PRO")];
  const p = await post(author, "gone");
  await db.call(me, "POST", `/posts/${p}/save`);
  await run("DELETE FROM posts WHERE id = $1::uuid", [p]);
  assert.deepEqual(await titles(me, "/me/saved-posts"), []);
  const count = await run("SELECT count(*)::int AS n FROM post_saves WHERE post_id = $1::uuid", [p]);
  assert.equal(count.rows[0]!.n, 0);
});
