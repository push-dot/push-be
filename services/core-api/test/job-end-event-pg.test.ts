// Every statement that ends a chat job, run as written in its source on a migrated Postgres (BILLING_PG_URL):
// the job ends with exactly one terminal event. The rule is a trigger (migration 0055), so a fake job store
// cannot show it: the first sketch of this rule passed on the fake and wrote nothing on the real one.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";

import { CANCEL_SQL } from "../../gateway/src/routes/conversations.ts";
import { botsPg, type BotsPg, type Person } from "../test-support/bots-pg.ts";

const URL_ = process.env.BILLING_PG_URL;
const SKIP = "set BILLING_PG_URL to a migrated Postgres";
const AI = new URL("../../ai/src/app/", import.meta.url);
const NOW = "2026-11-12T03:00:00Z";

let db: BotsPg | undefined;
before(async () => { if (URL_) db = await botsPg(URL_); });
after(async () => { await db?.close(); });

/** The first UPDATE of a Python method, with its adjacent string literals joined as Python joins them. */
const statementOf = (file: string, method: string): string => {
  const source = readFileSync(new URL(file, AI), "utf8");
  const body = source.split(new RegExp(`\\n +async def ${method}\\(`))[1]?.split(/\n +(?:async )?def /)[0] ?? "";
  const literals = body.slice(body.indexOf('"UPDATE ')).match(/^(?:"(?:[^"\\]|\\.)*"\s*)+/)?.[0] ?? "";
  const sql = [...literals.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]).join("");
  assert.match(sql, /^UPDATE ai_jobs SET /, `${file} ${method}`);
  return sql;
};

const STORE = "infrastructure/store_chat_jobs.py";
const FAILED = JSON.stringify({ code: "PROVIDER_ERROR", message: "the model call failed", details: null });
const JOB_FAILED = { error: { code: "JOB_FAILED", message: "job failed", details: null } };

type Job = { id: string; thread: string; user: Person };
type Event = [type: string, payload: unknown];
type Ending = {
  /** The statement, by the name migration 0055 lists it under. */
  name: string;
  sql: () => string;
  params: (job: Job) => unknown[];
  /** Attempts already used. A job has three. */
  attempts?: number;
  /** A document flow is under way in the thread. */
  flow?: boolean;
  /** Events the run wrote before the statement. */
  wrote?: Event[];
  status: string;
  terminal: Event[];
};

const ENDINGS: Ending[] = [
  {
    name: "worker_finish after a turn that returned before the graph",
    sql: () => statementOf(STORE, "worker_finish"), params: (job) => [job.id, "{}", NOW],
    wrote: [["status", { text: "생각 중", phase: "thinking" }]],
    status: "DONE", terminal: [["done", {}]],
  },
  {
    name: "worker_finish after a turn whose runtime wrote done",
    sql: () => statementOf(STORE, "worker_finish"), params: (job) => [job.id, "{}", NOW],
    wrote: [["done", { operation: { id: "op" } }]],
    status: "DONE", terminal: [["done", { operation: { id: "op" } }]],
  },
  {
    name: "worker_fail on the last attempt",
    sql: () => statementOf(STORE, "worker_fail"), params: (job) => [job.id, FAILED, NOW],
    attempts: 2, status: "DEAD", terminal: [["error", JOB_FAILED]],
  },
  {
    name: "worker_fail with an attempt left",
    sql: () => statementOf(STORE, "worker_fail"), params: (job) => [job.id, FAILED, NOW],
    status: "RETRY", terminal: [],
  },
  {
    name: "worker_fail_final after the worker's own error",
    sql: () => statementOf(STORE, "worker_fail_final"), params: (job) => [job.id, FAILED, NOW],
    wrote: [["error", { error: JSON.parse(FAILED) }]],
    status: "FAILED", terminal: [["error", { error: JSON.parse(FAILED) }]],
  },
  {
    name: "worker_cancel",
    sql: () => statementOf(STORE, "worker_cancel"), params: (job) => [job.id, NOW],
    status: "CANCELLED", terminal: [["cancelled", { resumable: false }]],
  },
  {
    name: "dispatcher mark_retry after a lost heartbeat on the last attempt",
    sql: () => statementOf("queue/dispatcher.py", "mark_retry"), params: (job) => [NOW, [job.id]],
    attempts: 2, status: "DEAD", terminal: [["error", JOB_FAILED]],
  },
  {
    name: "admin cancel",
    sql: () => statementOf("queue/admin.py", "cancel"), params: (job) => [job.id, NOW],
    status: "CANCELLED", terminal: [["cancelled", { resumable: false }]],
  },
  {
    name: "gateway cancel while a document flow is active",
    sql: () => CANCEL_SQL, params: (job) => [job.thread, job.user.id, null],
    flow: true, status: "CANCELLED", terminal: [["cancelled", { resumable: true }]],
  },
];

const seedJob = async (type = "chat", ending: Partial<Ending> = {}): Promise<Job> => {
  const user = await db!.person("PRO");
  const [id, thread] = [crypto.randomUUID(), crypto.randomUUID()];
  await db!.pg.query("INSERT INTO conversations (id, user_id, title, resume_state) VALUES ($1::uuid, $2::uuid, 'chat', $3::jsonb)",
    [thread, user.id, ending.flow ? JSON.stringify({ status: "active" }) : null]);
  await db!.pg.query(
    `INSERT INTO ai_jobs (id, type, queue, user_id, plan, status, attempts, max_attempts, payload, conversation_id)
     VALUES ($1::uuid, $2, 'q:chat', $3::uuid, 'PRO', 'RUNNING', $4, 3, '{}', $5::uuid)`,
    [id, type, user.id, ending.attempts ?? 0, thread]);
  for (const [kind, payload] of ending.wrote ?? []) {
    await db!.pg.query("INSERT INTO chat_events (job_id, type, payload) VALUES ($1::uuid, $2, $3::jsonb)", [id, kind, JSON.stringify(payload)]);
  }
  return { id, thread, user };
};

const endOf = async (job: Job): Promise<{ status: string; terminal: Event[] }> => {
  const status = await db!.pg.query("SELECT status FROM ai_jobs WHERE id = $1::uuid", [job.id]);
  const events = await db!.pg.query(
    "SELECT type, payload FROM chat_events WHERE job_id = $1::uuid AND type IN ('done', 'error', 'cancelled') ORDER BY id", [job.id]);
  return { status: String(status.rows[0].status), terminal: events.rows.map((row) => [String(row.type), row.payload]) };
};

for (const ending of ENDINGS) {
  test(`${ending.name} leaves ${ending.terminal.length === 0 ? "no terminal event" : `one ${ending.terminal[0][0]}`}`, async (t) => {
    if (!db) return t.skip(SKIP);
    const job = await seedJob("chat", ending);
    await db.pg.query(ending.sql(), ending.params(job));
    assert.deepEqual(await endOf(job), { status: ending.status, terminal: ending.terminal });
  });
}

test("the gateway's cancel answers with the resumable its event carries", async (t) => {
  if (!db) return t.skip(SKIP);
  for (const flow of [true, false]) {
    const job = await seedJob("chat", { flow });
    const row: Record<string, unknown> = (await db.pg.query(CANCEL_SQL, [job.thread, job.user.id, null])).rows[0];
    assert.deepEqual([row.job_id, row.resumable], [job.id, flow]);
    assert.deepEqual((await endOf(job)).terminal, [["cancelled", { resumable: flow }]]);
  }
});

test("a job that ends twice, a heartbeat, a retry, and a job that is not a chat write no second event", async (t) => {
  if (!db) return t.skip(SKIP);
  const { pg } = db;
  const finish = statementOf(STORE, "worker_finish");

  const twice = await seedJob();
  await pg.query(finish, [twice.id, "{}", NOW]);
  await pg.query(finish, [twice.id, "{}", NOW]);
  // DEAD reads as FAILED through the chat_jobs view, so any write through the view moves a dead job to FAILED.
  const dead = await seedJob("chat", { attempts: 2 });
  await pg.query(statementOf(STORE, "worker_fail"), [dead.id, FAILED, NOW]);
  await pg.query("UPDATE chat_jobs SET checkpoint = '{}' WHERE id = $1::uuid", [dead.id]);
  assert.deepEqual([await endOf(twice), await endOf(dead)], [
    { status: "DONE", terminal: [["done", {}]] },
    { status: "FAILED", terminal: [["error", JOB_FAILED]] },
  ]);

  const beating = await seedJob();
  await pg.query(statementOf(STORE, "worker_touch"), [beating.id, NOW]);
  assert.deepEqual(await endOf(beating), { status: "RUNNING", terminal: [] });

  const retried = await seedJob();
  await pg.query(statementOf(STORE, "worker_fail"), [retried.id, FAILED, NOW]);
  await pg.query(statementOf(STORE, "worker_claim"), [retried.id, NOW]);
  await pg.query(finish, [retried.id, "{}", NOW]);
  assert.deepEqual(await endOf(retried), { status: "DONE", terminal: [["done", {}]] });

  const notify = await seedJob("notify");
  await pg.query(finish, [notify.id, "{}", NOW]);
  assert.deepEqual(await endOf(notify), { status: "DONE", terminal: [] });
});
