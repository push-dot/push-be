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
let ownBaseline = false;
before(async () => { if (URL_) {db = await botsPg(URL_);} });
after(async () => {
  if (db && users.length) {
    await db.pg.query("DELETE FROM notification_dedupes WHERE dedupe_key = ANY(SELECT 'watch:new:' || u || ':' || $2 FROM unnest($1::uuid[]) u)", [users, company]);
    await db.pg.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [users]);
    await db.pg.query("DELETE FROM job_postings WHERE company_id = $1::uuid", [company]);
  }
  if (db && ownBaseline) {await db.pg.query("DELETE FROM notification_dedupes WHERE dedupe_key = 'watch:baseline'");}
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
  ownBaseline = (await db.pg.query(
    "INSERT INTO notification_dedupes (dedupe_key, created_at) VALUES ('watch:baseline', now() - interval '1 day') "
    + "ON CONFLICT (dedupe_key) DO NOTHING RETURNING dedupe_key")).rows.length === 1;
  await db.pg.query("UPDATE notification_dedupes SET created_at = LEAST(created_at, now() - interval '1 day') WHERE dedupe_key = 'watch:baseline'");
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

test("a cleanup of one user's watch keys restarts only that user's keys from now", async (t) => {
  if (!db) {return t.skip(SKIP);}
  const [mine, theirs] = [crypto.randomUUID(), crypto.randomUUID()];
  const company = crypto.randomUUID();
  const keys = {
    news: `watch:new:${mine}:${company}`, other: `watch:new:${theirs}:${company}`,
    closed: `watch:closed:${mine}:${crypto.randomUUID()}`, stale: `watch:closed:${mine}:${crypto.randomUUID()}`,
    deadline: `deadline:${crypto.randomUUID()}`,
  };
  const baselineBefore = (await db.pg.query(
    "INSERT INTO notification_dedupes (dedupe_key, created_at) VALUES ('watch:baseline', now() - interval '90 days') "
    + "ON CONFLICT (dedupe_key) DO UPDATE SET created_at = notification_dedupes.created_at RETURNING created_at")).rows[0]?.created_at;
  await db.pg.query(
    "INSERT INTO notification_dedupes (dedupe_key, created_at) VALUES ($1, now() - interval '60 days'), ($2, now() - interval '60 days'), "
    + "($3, now() - interval '1 day'), ($4, now() - interval '10 days'), ($5, now() - interval '60 days')",
    [keys.news, keys.other, keys.closed, keys.stale, keys.deadline]);
  await db.pg.query("DELETE FROM notification_dedupes WHERE dedupe_key = ANY($1::text[])", [[keys.news, keys.closed, keys.stale, keys.deadline]]);

  const left = new Map((await db.pg.query(
    "SELECT dedupe_key, now() - created_at < interval '1 minute' AS fresh FROM notification_dedupes WHERE dedupe_key = ANY($1::text[])",
    [[...Object.values(keys), "watch:baseline"]])).rows.map((row) => [String(row.dedupe_key), row.fresh === true]));
  assert.equal(left.get(keys.news), true, "the removed watermark is back at now, so that user hears nothing older");
  assert.equal(left.get(keys.closed), true, "a recent close stays sent");
  assert.equal(left.has(keys.stale), false, "a close older than the 2-day lookback can go");
  assert.equal(left.has(keys.deadline), false, "other keys are not touched");
  assert.equal(left.get(keys.other), false, "another follower's watermark is unchanged");
  const baselineAfter = (await db.pg.query("SELECT created_at FROM notification_dedupes WHERE dedupe_key = 'watch:baseline'")).rows[0]?.created_at;
  assert.equal(String(baselineAfter), String(baselineBefore), "the shared baseline is unchanged");
  ownBaseline = true;
});
