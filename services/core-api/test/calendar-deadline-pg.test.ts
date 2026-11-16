// A posting's deadline enters the calendar when the user bookmarks or applies (migration 0063), on a migrated
// Postgres (BILLING_PG_URL): one event per user and posting, committed with the bookmark or application.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { botsPg, type BotsPg, type Person } from "../test-support/bots-pg.ts";

const URL_ = process.env.BILLING_PG_URL;
const SKIP = "set BILLING_PG_URL to a migrated Postgres";

let db: BotsPg | undefined;
before(async () => { if (URL_) db = await botsPg(URL_); });
after(async () => { await db?.close(); });

const sql = async (text: string, params: unknown[] = []) => (await db!.pg.query(text, params)).rows;

/** A posting whose deadline is `days` from today (Seoul), or none. */
const posting = async (company: string, days: number | null): Promise<string> => {
  const id = await db!.posting(company);
  if (days !== null) await sql("UPDATE job_postings SET deadline = (now() AT TIME ZONE 'Asia/Seoul')::date + $2::int WHERE id = $1", [id, days]);
  return id;
};

const eventsOf = async (user: Person) => {
  const from = new Date(Date.now() - 30 * 86400_000).toISOString();
  const to = new Date(Date.now() + 300 * 86400_000).toISOString();
  const res = await db!.call(user, "GET", `/calendar/events?from=${from}&to=${to}&limit=100`);
  assert.equal(res.status, 200);
  return res.body.data as Array<Record<string, unknown>>;
};

test("a bookmark adds one deadline event, and bookmarking again adds none", async (t) => {
  if (!db) return t.skip(SKIP);
  const user = await db.person("PRO");
  const id = await posting("마감클라우드", 5);
  assert.equal((await db.call(user, "POST", `/postings/${id}/bookmark`)).status, 204);
  assert.equal((await db.call(user, "POST", `/postings/${id}/bookmark`)).status, 204);

  const events = await eventsOf(user);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "DEADLINE");
  assert.equal(events[0].source, "POSTING");
  assert.equal(events[0].title, "마감클라우드 Backend");
  assert.equal(events[0].timeZone, "Asia/Seoul");
  assert.equal(events[0].applicationId, null);
  const [row] = await sql("SELECT to_char(starts_at AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD HH24:MI') AS at, (SELECT deadline FROM job_postings WHERE id = $2)::text AS day FROM calendar_events WHERE user_id = $1", [user.id, id]);
  assert.equal(row.at, `${row.day} 23:59`, "the last minute of the deadline day");
});

test("a posting without a deadline or with a passed one adds nothing on bookmark", async (t) => {
  if (!db) return t.skip(SKIP);
  const user = await db.person("PRO");
  for (const days of [null, -1]) {
    const id = await posting("무마감", days);
    assert.equal((await db.call(user, "POST", `/postings/${id}/bookmark`)).status, 204);
  }
  assert.deepEqual(await eventsOf(user), []);
});

test("un-bookmarking removes the event, and an event the user made by hand stays", async (t) => {
  if (!db) return t.skip(SKIP);
  const user = await db.person("PRO");
  const id = await posting("해제클라우드", 3);
  const hand = await db.call(user, "POST", "/calendar/events", {
    type: "CUSTOM", title: "직접 만든 일정", startsAt: new Date(Date.now() + 86400_000).toISOString(), endsAt: new Date(Date.now() + 2 * 86400_000).toISOString(),
  });
  assert.equal(hand.status, 201);
  await db.call(user, "POST", `/postings/${id}/bookmark`);
  assert.equal((await eventsOf(user)).length, 2);

  assert.equal((await db.call(user, "DELETE", `/postings/${id}/bookmark`)).status, 204);
  assert.deepEqual((await eventsOf(user)).map((e) => e.title), ["직접 만든 일정"]);
});

test("applying adds the event when there was no bookmark, and links it when there was", async (t) => {
  if (!db) return t.skip(SKIP);
  const user = await db.person("PRO");
  const plain = await posting("지원만", 4);
  const marked = await posting("북마크후지원", 6);
  await db.call(user, "POST", `/postings/${marked}/bookmark`);

  const a = await db.call(user, "POST", `/postings/${plain}/apply`, {});
  const b = await db.call(user, "POST", `/postings/${marked}/apply`, {});
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  const again = await db.call(user, "POST", `/postings/${marked}/apply`, {});
  assert.equal(again.data.id, b.data.id, "a second apply answers with the same application");

  const events = await eventsOf(user);
  assert.equal(events.length, 2, "one event per posting");
  const byApp = new Map(events.map((e) => [e.applicationId, e]));
  assert.ok(byApp.has(a.data.id) && byApp.has(b.data.id), "both events point at their application");
});

test("an applied posting keeps its event after the bookmark is removed", async (t) => {
  if (!db) return t.skip(SKIP);
  const user = await db.person("PRO");
  const id = await posting("지원유지", 4);
  await db.call(user, "POST", `/postings/${id}/bookmark`);
  await db.call(user, "POST", `/postings/${id}/apply`, {});
  assert.equal((await db.call(user, "DELETE", `/postings/${id}/bookmark`)).status, 204);
  assert.equal((await eventsOf(user)).length, 1);
});

test("a past deadline shows only when the user applied", async (t) => {
  if (!db) return t.skip(SKIP);
  const user = await db.person("PRO");
  const id = await posting("지난마감", -2);
  await db.call(user, "POST", `/postings/${id}/bookmark`);
  assert.deepEqual(await eventsOf(user), []);
  assert.equal((await db.call(user, "POST", `/postings/${id}/apply`, {})).status, 201);
  assert.equal((await eventsOf(user)).length, 1);
});

test("deleting a bookmark from the materials bin removes its event, and restoring brings it back", async (t) => {
  if (!db) return t.skip(SKIP);
  const user = await db.person("PRO");
  const id = await posting("보관함", 7);
  await db.call(user, "POST", `/postings/${id}/bookmark`);
  assert.equal((await eventsOf(user)).length, 1);

  assert.equal((await db.call(user, "DELETE", `/materials/posting/${id}`)).status, 204);
  assert.deepEqual(await eventsOf(user), []);
  assert.equal((await db.call(user, "POST", `/materials/posting/${id}/restore`)).status, 200);
  assert.equal((await eventsOf(user)).length, 1);
});
