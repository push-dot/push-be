// The company-bot posting watch on a migrated Postgres (BILLING_PG_URL): a company opening many postings at once
// must reach every follower once without any run reading more than 500 rows.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { DUE_WATCH } from "../src/routes/notification-jobs.ts";
import { botsPg } from '../test-support/bots-pg.ts';
import type { BotsPg } from '../test-support/bots-pg.ts';

const URL_ = process.env.BILLING_PG_URL;
const SKIP = "set BILLING_PG_URL to a migrated Postgres";
const FOLLOWERS = 600;
const OPENED = 40;

let db: BotsPg | undefined;
let users: Array<string> = [];
let company = "";
before(async () => { if (URL_) {db = await botsPg(URL_);} });
after(async () => {
  if (db && users.length) {
    await db.pg.query("DELETE FROM notification_dedupes WHERE dedupe_key = ANY(SELECT 'watch:new:' || u || ':' || $2 FROM unnest($1::uuid[]) u)", [users, company]);
    await db.pg.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [users]);
    await db.pg.query("DELETE FROM job_postings WHERE company_id = $1::uuid", [company]);
  }
  await db?.close();
});

const run = async (): Promise<Array<string>> => {
  const now = Date.now();
  const at = (days: number) => new Date(now - days * 86_400_000).toISOString();
  const rows = (await db!.pg.query(DUE_WATCH, [new Date(now).toISOString(), at(2), at(30)])).rows;
  assert.ok(rows.length <= 500, `a run reads at most 500 rows, read ${rows.length}`);
  return rows.filter((row) => users.includes(String(row.user_id))).map((row) => {
    assert.equal(Number(row.n), OPENED, "one row carries all of the company's new postings");
    return String(row.user_id);
  });
};

test("600 followers of a company that opens 40 postings each hear once, at most 500 rows a run", async (t) => {
  if (!db) {return t.skip(SKIP);}
  const source = await db.posting("와치컴퍼니");
  company = String((await db.pg.query("SELECT company_id FROM job_postings WHERE id = $1::uuid", [source])).rows[0]?.company_id);
  await db.pg.query("INSERT INTO notification_dedupes (dedupe_key, created_at) VALUES ('watch:baseline', now() - interval '1 day') "
    + "ON CONFLICT (dedupe_key) DO UPDATE SET created_at = LEAST(notification_dedupes.created_at, EXCLUDED.created_at)");
  users = (await db.pg.query(
    "INSERT INTO users (id, provider, provider_subject, display_name, plan) "
    + "SELECT g, 'test', g::text, 'watch', 'FREE' FROM (SELECT gen_random_uuid() AS g FROM generate_series(1, $1::int)) x RETURNING id",
    [FOLLOWERS])).rows.map((row) => String(row.id));
  await db.pg.query(
    "INSERT INTO bots (id, user_id, kind, company_name, posting_id, display_name, created_at, updated_at) "
    + "SELECT gen_random_uuid(), u, 'company', '와치컴퍼니', $2::uuid, '와치컴퍼니', now() - interval '5 days', now() - interval '5 days' FROM unnest($1::uuid[]) u",
    [users, source]);
  await db.pg.query(
    "INSERT INTO job_postings (id, company_id, company, title, job_category, career_min, location, employment_type, description, status) "
    + "SELECT gen_random_uuid(), company_id, company, 'opening ' || g, job_category, career_min, location, employment_type, description, 'OPEN' "
    + "FROM job_postings, generate_series(1, $2::int) g WHERE id = $1::uuid",
    [source, OPENED]);

  const heard: Array<string> = [];
  for (let i = 0; i < 6 && heard.length < FOLLOWERS; i++) {heard.push(...await run());}
  assert.equal(heard.length, FOLLOWERS, "every follower heard");
  assert.equal(new Set(heard).size, FOLLOWERS, "each follower heard once");
  assert.deepEqual(await run(), [], "a later run has nothing left");
});
