import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";

import { botsPg, type BotsPg } from "../test-support/bots-pg.ts";

const URL_ = process.env.BILLING_PG_URL;
const SKIP = "set BILLING_PG_URL to a migrated Postgres";
const BACKFILL = readFileSync(new URL("../../../db/migrations/0064_calendar_deadline_backfill.sql", import.meta.url), "utf8");

let db: BotsPg | undefined;
before(async () => { if (URL_) db = await botsPg(URL_); });
after(async () => { await db?.close(); });

const sql = async (text: string, params: unknown[] = []) => (await db!.pg.query(text, params)).rows;

const posting = async (company: string, days: number | null): Promise<string> => {
  const id = await db!.posting(company);
  if (days !== null) await sql("UPDATE job_postings SET deadline = (now() AT TIME ZONE 'Asia/Seoul')::date + $2::int WHERE id = $1", [id, days]);
  return id;
};

const events = (user: string) => sql(
  "SELECT id, posting_id, application_id, revision, title, time_zone, source, type, to_char(starts_at AT TIME ZONE 'Asia/Seoul', 'HH24:MI') AS at FROM calendar_events WHERE user_id = $1 ORDER BY title", [user]);

test("the backfill gives old bookmarks and applications their deadline event, once", async (t) => {
  if (!db) return t.skip(SKIP);
  const user = await db.person("PRO");
  const marked = await posting("백필북마크", 5);
  const applied = await posting("백필지원", 6);
  const both = await posting("백필둘다", 7);
  const pastMark = await posting("백필지난북마크", -2);
  const pastApplied = await posting("백필지난지원", -2);
  const noDeadline = await posting("백필무마감", null);

  for (const id of [marked, both, pastMark, noDeadline]) assert.equal((await db.call(user, "POST", `/postings/${id}/bookmark`)).status, 204);
  const apps = new Map<string, string>();
  for (const id of [applied, both, pastApplied]) {
    const res = await db.call(user, "POST", `/postings/${id}/apply`, {});
    assert.equal(res.status, 201);
    apps.set(id, String(res.data.id));
  }
  await db.call(user, "POST", "/calendar/events", {
    type: "CUSTOM", title: "직접 만든 일정", startsAt: new Date(Date.now() + 86400_000).toISOString(), endsAt: new Date(Date.now() + 2 * 86400_000).toISOString(),
  });
  await sql("DELETE FROM calendar_events WHERE user_id = $1 AND posting_id IS NOT NULL", [user.id]);
  await sql("INSERT INTO calendar_events (id, user_id, type, title, starts_at, ends_at, source, posting_id) SELECT gen_random_uuid(), $1, 'DEADLINE', 'old', now(), now(), 'POSTING', $2::uuid", [user.id, both]);
  assert.equal((await events(user.id)).length, 2);

  await sql(BACKFILL);
  const first = await events(user.id);
  const byPosting = new Map(first.map((e) => [e.posting_id as string | null, e]));
  assert.equal(first.length, 5, "the manual event plus one per posting that earns one");
  assert.ok(!byPosting.has(pastMark) && !byPosting.has(noDeadline));
  assert.equal(byPosting.get(marked)!.application_id, null);
  assert.equal(byPosting.get(applied)!.application_id, apps.get(applied));
  assert.equal(byPosting.get(pastApplied)!.application_id, apps.get(pastApplied));
  assert.equal(byPosting.get(both)!.application_id, apps.get(both), "an event that was only bookmarked gets the application link");
  assert.equal(byPosting.get(both)!.title, "old", "an existing event keeps its own columns");
  const made = byPosting.get(marked)!;
  assert.equal(made.title, "백필북마크 Backend");
  assert.deepEqual([made.type, made.source, made.time_zone, made.at], ["DEADLINE", "POSTING", "Asia/Seoul", "23:59"]);

  await sql(BACKFILL);
  await sql(BACKFILL);
  assert.deepEqual(await events(user.id), first, "a rerun changes nothing");
});
