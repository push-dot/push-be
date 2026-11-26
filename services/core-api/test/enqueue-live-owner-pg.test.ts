// A scheduled run's enqueue on a migrated Postgres (BILLING_PG_URL): the deletion check and the job write are one transaction.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { HttpError } from "../src/http.ts";
import { enqueueJob } from "../src/jobs/enqueue.ts";
import { botsPg } from '../test-support/bots-pg.ts';
import type { BotsPg } from '../test-support/bots-pg.ts';

const URL_ = process.env.BILLING_PG_URL;
const SKIP = "set BILLING_PG_URL to a migrated Postgres";

let db: BotsPg | undefined;
before(async () => { if (URL_) {db = await botsPg(URL_);} });
after(async () => { await db?.close(); });

const jobs = async (userId: string): Promise<number> =>
  Number((await db!.pg.query("SELECT count(*)::int AS n FROM ai_jobs WHERE user_id = $1::uuid", [userId])).rows[0]?.n ?? 0);

test("a deletion request committing during a live-owner enqueue leaves no job", async (t) => {
  if (!db || !db.pg.transaction) {return t.skip(SKIP);}
  const user = await db.person("PRO");
  let enqueue: Promise<unknown> = Promise.resolve();
  await db.pg.transaction(async (tx) => {
    await tx("UPDATE users SET deletion_requested_at = now() WHERE id = $1::uuid", [user.id]);
    enqueue = enqueueJob(db!.pg.query, { type: "chat", userId: user.id, plan: "PRO", payload: {}, liveOwner: true }, db!.pg.transaction)
      .then(() => "queued", (error: unknown) => error);
    const settled = await Promise.race([enqueue.then(() => "settled"), new Promise((resolve) => { setTimeout(() => resolve("waiting"), 300); })]);
    assert.equal(settled, "waiting", "the enqueue waits for the deletion request to commit");
  });
  const outcome = await enqueue;
  assert.ok(outcome instanceof HttpError && outcome.code === "ACCOUNT_DELETING", `got ${String(outcome)}`);
  assert.equal(await jobs(user.id), 0);
});

test("a live owner still gets the job, and a plain enqueue ignores the flag it was not given", async (t) => {
  if (!db || !db.pg.transaction) {return t.skip(SKIP);}
  const live = await db.person("PRO");
  await enqueueJob(db.pg.query, { type: "chat", userId: live.id, plan: "PRO", payload: {}, liveOwner: true }, db.pg.transaction);
  assert.equal(await jobs(live.id), 1);
  const leaving = await db.person("PRO");
  await db.pg.query("UPDATE users SET deletion_requested_at = now() WHERE id = $1::uuid", [leaving.id]);
  await assert.rejects(
    enqueueJob(db.pg.query, { type: "chat", userId: leaving.id, plan: "PRO", payload: {}, liveOwner: true }, db.pg.transaction),
    (error: unknown) => error instanceof HttpError && error.code === "ACCOUNT_DELETING");
  await enqueueJob(db.pg.query, { type: "chat", userId: leaving.id, plan: "PRO", payload: {}, idempotencyKey: crypto.randomUUID() }, db.pg.transaction);
  assert.equal(await jobs(leaving.id), 1);
});
