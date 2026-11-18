// Delete and restore rules of links and sources on a migrated Postgres (BILLING_PG_URL).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { botsPg, type BotsPg } from "../test-support/bots-pg.ts";

const URL_ = process.env.BILLING_PG_URL;
const SKIP = "set BILLING_PG_URL to a migrated Postgres";

let db: BotsPg | undefined;
before(async () => { if (URL_) db = await botsPg(URL_); });
after(async () => { await db?.close(); });

const sql = async (text: string, params: unknown[] = []) => (await db!.pg.query(text, params)).rows;

test("DELETE /me/links/{id} answers 204 on a repeat, and a live link is not restored", async (t) => {
  if (!db) return t.skip(SKIP);
  const user = await db.person("PRO");
  const id = crypto.randomUUID();
  await sql("INSERT INTO user_links (id, user_id, kind, url, title) VALUES ($1, $2, 'portfolio', 'https://example.com/a', 'a')", [id, user.id]);

  assert.equal((await db.call(user, "POST", `/me/links/${id}/restore`)).status, 404, "a live link has nothing to restore");
  assert.equal((await db.call(user, "DELETE", `/me/links/${id}`)).status, 204);
  assert.equal((await db.call(user, "DELETE", `/me/links/${id}`)).status, 204, "the repeat");
  assert.equal((await db.call(user, "DELETE", `/me/links/${crypto.randomUUID()}`)).status, 404, "a link that never existed");
  assert.equal((await db.call(user, "POST", `/me/links/${id}/restore`)).status, 200);
  assert.equal((await sql("SELECT deleted_at FROM user_links WHERE id = $1", [id]))[0].deleted_at, null);
});

test("DELETE /sources deletes an unreferenced resume and leaves its profile pointing at nothing", async (t) => {
  if (!db) return t.skip(SKIP);
  const user = await db.person("PRO");
  const id = crypto.randomUUID();
  await sql(
    `INSERT INTO sources (id, user_id, file_name, mime_type, size, sha256, path, content, page_count)
     VALUES ($1, $2, 'cv.pdf', 'application/pdf', 10, 'h', 'db://sources/test', '\\x255044'::bytea, 1)`, [id, user.id]);
  await sql("INSERT INTO profiles (user_id, resume_source_id) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET resume_source_id = $2", [user.id, id]);

  assert.equal((await db.call(user, "DELETE", `/sources/${id}`)).status, 204);
  assert.equal((await sql("SELECT count(*)::int AS n FROM sources WHERE id = $1", [id]))[0].n, 0);
  const [profile] = await sql("SELECT resume_source_id FROM profiles WHERE user_id = $1", [user.id]);
  assert.equal(profile.resume_source_id, null, "the profile survives with no pinned resume");
  assert.equal((await db.call(user, "DELETE", `/sources/${id}`)).status, 404);
});
