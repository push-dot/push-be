// The posting read paths on a migrated Postgres (BILLING_PG_URL): the index the counts rely on, and the column
// reads that replaced to_jsonb(...) ->> '...'. Each check compares against the old expression on the same rows.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { handle } from "../src/handler.ts";
import { resetLimits } from "../src/ratelimit.ts";
import { searchFields } from "../src/hangul.ts";
import { botsPg, type BotsPg } from "../test-support/bots-pg.ts";
import { recorder } from "../test-support/recorder.ts";

const URL_ = process.env.BILLING_PG_URL;
const SKIP = "set BILLING_PG_URL to a migrated Postgres";

let db: BotsPg | undefined;
before(async () => { if (URL_) db = await botsPg(URL_); });
after(async () => { await db?.close(); });

const sql = async (text: string, params: unknown[] = []) => (await db!.pg.query(text, params)).rows;

const sqlOf = async (path: string): Promise<{ sql: string; params: unknown[] }[]> => {
  resetLimits();
  const { calls, query } = recorder();
  const res = await handle(new Request("https://core.example/api/v1" + path, { headers: { authorization: "Bearer t" } }), { APP_ENV: "production" }, { query });
  assert.equal(res.status, 200);
  return calls.filter((c) => c.sql.includes("FROM job_postings"));
};

test("the open-postings index is usable by every count and facet statement the routes send", { skip: URL_ ? false : SKIP }, async () => {
  const statements = [
    ...await sqlOf("/postings"),
    ...await sqlOf("/postings?category=dev&careerYears=1-3"),
    ...await sqlOf("/postings/facets"),
    ...await sqlOf("/search/trending"),
  ].filter((c) => /count\(\*\)/.test(c.sql) && c.sql.includes("status = 'OPEN'"));
  assert.ok(statements.length >= 6, `captured ${statements.length} statements`);
  const plans = await db!.pg.transaction!(async (q) => {
    await q("SET LOCAL enable_seqscan = off");
    const out: string[] = [];
    for (const c of statements.filter((s) => !s.sql.includes("jsonb_array_elements_text"))) {
      const plan = await q("EXPLAIN (FORMAT JSON) " + c.sql, c.params);
      out.push(JSON.stringify(plan.rows[0]["QUERY PLAN"]));
    }
    return out;
  });
  assert.ok(plans.length >= 5);
  for (const plan of plans) assert.match(plan, /idx_postings_open_facets/);
});

test("the popular sort returns the same order as the JSON expression it replaced", { skip: URL_ ? false : SKIP }, async () => {
  const user = await db!.person("FREE");
  const ids: string[] = [];
  const views = [0, 3, 3, 9, 1, 3];
  for (const [i, view] of views.entries()) {
    const id = await db!.posting(`order-${i}`);
    await sql("UPDATE job_postings SET view_count = $2, created_at = $3::timestamptz WHERE id = $1", [id, view, i < 3 ? "2026-11-01T00:00:00Z" : `2026-11-0${i}T00:00:00Z`]);
    ids.push(id);
  }
  const api = await db!.call(user, "GET", "/postings?sort=popular&limit=100");
  assert.equal(api.status, 200);
  const got = (api.body.data as { id: string }[]).map((r) => r.id).filter((id) => ids.includes(id));
  const old = (await sql(
    `SELECT id FROM job_postings p WHERE p.status = 'OPEN' AND p.closed_at IS NULL AND id = ANY($1::uuid[])
     ORDER BY COALESCE((to_jsonb(p) ->> 'view_count')::int, 0) DESC, p.created_at DESC, p.id DESC`, [ids])).map((r) => String(r.id));
  assert.deepEqual(got, old);
  assert.equal(got.length, ids.length);
});

test("view_count cannot be NULL, so the column read needs no COALESCE", { skip: URL_ ? false : SKIP }, async () => {
  const id = await db!.posting("not-null");
  await assert.rejects(sql("UPDATE job_postings SET view_count = NULL WHERE id = $1", [id]), /null value|23502/);
});

test("people search hides an account in its deletion grace period, as the JSON read did", { skip: URL_ ? false : SKIP }, async () => {
  const me = await db!.person("FREE");
  const staying = await db!.person("FREE");
  const leaving = await db!.person("FREE");
  for (const [who, headline] of [[staying, "zqpgstay"], [leaving, "zqpgleave"]] as const) {
    const f = searchFields(headline);
    await sql("INSERT INTO profiles (user_id, headline, search_text, search_choseong, search_jamo) VALUES ($1,$2,$3,$4,$5)", [who.id, headline, f.text, f.choseong, f.jamo]);
    await sql("INSERT INTO user_settings (user_id, profile_public) VALUES ($1,true) ON CONFLICT (user_id) DO UPDATE SET profile_public = true", [who.id]);
  }
  await sql("UPDATE users SET deletion_requested_at = now() WHERE id = $1", [leaving.id]);
  const res = await db!.call(me, "GET", "/search?type=people&limit=100&q=zqpg");
  assert.equal(res.status, 200);
  assert.deepEqual((res.body.data as { userId?: string; id?: string }[]).map((r) => r.userId ?? r.id), [staying.id]);
  const [{ same }] = await sql(
    `SELECT bool_and((to_jsonb(u) ->> 'deletion_requested_at' IS NULL) = (u.deletion_requested_at IS NULL)) AS same FROM users u`);
  assert.equal(same, true);
});
