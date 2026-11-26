// The memory routes of core on a migrated Postgres (BILLING_PG_URL): what the bots remember, as the user sees it.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { botsPg } from '../test-support/bots-pg.ts';
import type { BotsPg } from '../test-support/bots-pg.ts';

const URL_ = process.env.BILLING_PG_URL;
const SKIP = "set BILLING_PG_URL to a migrated Postgres";

let db: BotsPg | undefined;
before(async () => { if (URL_) {db = await botsPg(URL_);} });
after(async () => { await db?.close(); });

const remember = async (userId: string, text: string, at: string): Promise<string> => {
  const id = crypto.randomUUID();
  await db!.pg.query("INSERT INTO user_memories (id, user_id, text, created_at, updated_at) VALUES ($1, $2, $3, $4, $4)",
    [id, userId, text, at]);
  return id;
};

test("a user lists, corrects and forgets what the bots remember, and nobody else can", async (t) => {
  if (!db) {return t.skip(SKIP);}
  const user = await db.person("PRO");
  const remote = await remember(user.id, "원격 근무를 원해요", "2026-11-20T01:00:00Z");
  const salary = await remember(user.id, "희망 연봉은 6천만 원 이상", "2026-11-21T01:00:00Z");

  const listed = await db.call(user, "GET", "/me/memories");
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.data, [
    { id: salary, text: "희망 연봉은 6천만 원 이상", createdAt: "2026-11-21T01:00:00Z", updatedAt: "2026-11-21T01:00:00Z" },
    { id: remote, text: "원격 근무를 원해요", createdAt: "2026-11-20T01:00:00Z", updatedAt: "2026-11-20T01:00:00Z" },
  ]);

  const fixed = await db.call(user, "PATCH", `/me/memories/${remote}`, { text: "  주 2일 재택이면 괜찮아요 " });
  assert.equal(fixed.status, 200);
  assert.equal(fixed.data.text, "주 2일 재택이면 괜찮아요");
  assert.equal((await db.call(user, "PATCH", `/me/memories/${remote}`, { text: "   " })).status, 400);
  assert.equal((await db.call(user, "PATCH", `/me/memories/${remote}`, { text: "가".repeat(301) })).status, 400);

  const stranger = await db.person("PRO");
  assert.deepEqual((await db.call(stranger, "GET", "/me/memories")).body.data, []);
  assert.equal((await db.call(stranger, "PATCH", `/me/memories/${salary}`, { text: "x" })).status, 404);
  assert.equal((await db.call(stranger, "DELETE", `/me/memories/${salary}`)).status, 404);

  assert.equal((await db.call(user, "DELETE", `/me/memories/${salary}`)).status, 204);
  assert.equal((await db.call(user, "DELETE", `/me/memories/${salary}`)).status, 404);
  await remember(stranger.id, "남의 기억", "2026-11-22T01:00:00Z");
  assert.equal((await db.call(user, "DELETE", "/me/memories")).status, 204);
  assert.deepEqual((await db.call(user, "GET", "/me/memories")).body.data, []);
  const left: unknown = (await db.call(stranger, "GET", "/me/memories")).body.data;
  assert.equal(Array.isArray(left) ? left.length : 0, 1, "forgetting everything is one user's rows only");
});

test("correcting a memory into one the user already has keeps one row", async (t) => {
  if (!db) {return t.skip(SKIP);}
  const user = await db.person("PRO");
  const older = await remember(user.id, "원격 근무를 원해요", "2026-11-20T01:00:00Z");
  const kept = await remember(user.id, "재택 근무를 원해요", "2026-11-21T01:00:00Z");
  const merged = await db.call(user, "PATCH", `/me/memories/${older}`, { text: "재택 근무를 원해요" });
  assert.equal(merged.status, 200);
  assert.equal(merged.data.id, kept, "the existing memory answers");
  const left: unknown = (await db.call(user, "GET", "/me/memories")).body.data;
  assert.deepEqual(Array.isArray(left) ? left.map((row: { id: string }) => row.id) : [], [kept]);
  assert.equal((await db.call(user, "PATCH", `/me/memories/${older}`, { text: "x" })).status, 404);
  const spaced = await remember(user.id, "연봉은 6천 이상", "2026-11-22T01:00:00Z");
  const folded = await db.call(user, "PATCH", `/me/memories/${kept}`, { text: " 연봉은   6천  이상 " });
  assert.equal(folded.data.id, spaced, "inner spaces collapse like the AI's remember tool");
});
