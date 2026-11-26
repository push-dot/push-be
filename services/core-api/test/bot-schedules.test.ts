import assert from "node:assert/strict";
import { test } from "node:test";

import { handle } from "../src/handler.ts";
import type { CoreEnv, Deps } from "../src/handler.ts";
import { resetLimits } from "../src/ratelimit.ts";
import { nextRunAt } from "../src/routes/bot-schedules.ts";
import type { Timing } from "../src/routes/bot-schedules.ts";
import { USER, readJson, recorder } from "../test-support/recorder.ts";
import type { Row } from "../test-support/recorder.ts";

const BOT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CONV = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const SCHEDULE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "99999999-9999-4999-8999-999999999999";
// Thursday 2026-11-26 09:15 KST, when the cron runs a 9 o'clock schedule.
const NOW = new Date("2026-11-26T00:15:00.000Z");

const env: CoreEnv = { APP_ENV: "production", INTERNAL_JOB_TOKEN: "job-secret", QUEUE_BACKEND: "redis", DISPATCH_ORIGIN: "" };

const daily = (hour: number): Timing => ({ cadence: "DAILY", hour, weekday: null });

test("nextRunAt is the first matching Korea-time hour strictly after the moment", () => {
  const cases: Array<[Timing, string, string]> = [
    [daily(9), "2026-11-25T23:00:00Z", "2026-11-26T00:00:00Z"],
    [daily(9), "2026-11-26T00:00:00Z", "2026-11-27T00:00:00Z"],
    [daily(9), "2026-11-26T00:15:00Z", "2026-11-27T00:00:00Z"],
    [daily(0), "2026-11-26T14:59:00Z", "2026-11-26T15:00:00Z"],
    [daily(23), "2026-11-26T15:00:00Z", "2026-11-27T14:00:00Z"],
    [daily(9), "2026-11-30T03:00:00Z", "2026-12-01T00:00:00Z"],
    [daily(9), "2026-12-31T05:00:00Z", "2027-01-01T00:00:00Z"],
    [daily(9), "2028-02-28T05:00:00Z", "2028-02-29T00:00:00Z"],
    [{ cadence: "WEEKDAYS", hour: 9, weekday: null }, "2026-11-27T05:00:00Z", "2026-11-30T00:00:00Z"],
    [{ cadence: "WEEKDAYS", hour: 9, weekday: null }, "2026-11-25T23:00:00Z", "2026-11-26T00:00:00Z"],
    [{ cadence: "WEEKLY", hour: 9, weekday: 1 }, "2026-11-26T00:15:00Z", "2026-11-30T00:00:00Z"],
    [{ cadence: "WEEKLY", hour: 9, weekday: 4 }, "2026-11-26T00:15:00Z", "2026-12-03T00:00:00Z"],
    [{ cadence: "WEEKLY", hour: 9, weekday: 4 }, "2026-11-25T23:59:00Z", "2026-11-26T00:00:00Z"],
    [{ cadence: "WEEKLY", hour: 2, weekday: 0 }, "2026-12-26T18:00:00Z", "2027-01-02T17:00:00Z"],
  ];
  for (const [timing, after, expected] of cases) {
    assert.equal(nextRunAt(timing, new Date(after)).getTime(), Date.parse(expected), `${JSON.stringify(timing)} after ${after}`);
  }
});

type Stored = { id: string; user_id: string; bot_id: string; prompt: string; cadence: string; hour: number; weekday: number | null;
  enabled: boolean; next_run_at: string; last_run_at: string | null; last_error: string | null; last_job_id?: string; plan?: string };

const stored = (extra: Partial<Stored> = {}): Stored => ({
  id: SCHEDULE, user_id: USER, bot_id: BOT, prompt: "새 공고 3개 찾아 줘", cadence: "DAILY", hour: 9, weekday: null, enabled: true,
  next_run_at: "2026-11-26T00:00:00Z", last_run_at: null, last_error: null, plan: "FREE", ...extra,
});

type World = { schedules: Array<Stored>; due?: Array<Stored>; count?: number; noConsent?: Set<string>; busy?: Set<string>; deleting?: Set<string> };

const fake = (world: World) => {
  const jobs: Array<{ userId: string; payload: Row; key: unknown }> = [];
  const byId = (id: unknown): Stored | undefined => world.schedules.find((row) => row.id === id);
  const db = recorder((sql, params) => {
    if (sql.includes("FROM bots b WHERE b.id = $1")) {return params[0] === BOT ? [{ id: BOT, kind: "company", user_id: USER }] : [];}
    if (sql.includes("user_consents")) {return [{ reference_data: !world.noConsent?.has(String(params[0])) }];}
    if (sql.includes("count(*)::int AS n FROM bot_schedules")) {return [{ n: world.count ?? world.schedules.length }];}
    if (sql.startsWith("INSERT INTO bot_schedules")) {
      return [{ id: String(params[0]), bot_id: String(params[2]), prompt: String(params[3]), cadence: String(params[4]), hour: Number(params[5]),
        weekday: params[6] === null ? null : Number(params[6]), enabled: true, next_run_at: String(params[7]), last_run_at: null, last_error: null }];
    }
    if (sql.includes("FROM bot_schedules s")) {return (world.due ?? world.schedules.filter((row) => row.enabled && row.next_run_at <= String(params[0]))).map((row) => ({ ...row }));}
    if (sql.startsWith("SELECT id, bot_id, prompt") && sql.includes("WHERE id = $1")) {return world.schedules.filter((row) => row.id === params[0]);}
    if (sql.startsWith("SELECT id, bot_id, prompt")) {return world.schedules.filter((row) => row.bot_id === params[1]);}
    if (sql.startsWith("UPDATE bot_schedules SET prompt")) {
      const row = byId(params[0]);
      if (!row) {return [];}
      Object.assign(row, { prompt: params[3], cadence: params[4], hour: params[5], weekday: params[6], enabled: params[7], next_run_at: params[8] });
      return [row];
    }
    if (sql.startsWith("UPDATE bot_schedules SET next_run_at")) {
      const row = byId(params[0]);
      if (!row || row.next_run_at !== params[1]) {return [];}
      Object.assign(row, { next_run_at: params[2], last_run_at: params[3] });
      return [{ id: row.id }];
    }
    if (sql.startsWith("UPDATE bot_schedules SET last_job_id")) {Object.assign(byId(params[0]) ?? {}, { last_job_id: params[1], last_error: null });}
    if (sql.startsWith("UPDATE bot_schedules SET last_error")) {Object.assign(byId(params[0]) ?? {}, { last_error: params[1] });}
    if (sql.startsWith("DELETE FROM bot_schedules")) {return byId(params[0]) ? [{}] : [];}
    if (sql.includes("is_employer") && sql.includes("FROM users WHERE id = $1")) {
      return [{ id: String(params[0]), display_name: "Ada", locale: "ko", plan: "PRO", created_at: "2026-01-01T00:00:00Z", is_employer: false, provider: "email" }];
    }
    if (sql.includes("deletion_requested_at IS NULL FOR SHARE")) {return world.deleting?.has(String(params[0])) ? [] : [{ id: String(params[0]) }];}
    if (sql.startsWith("SELECT 1 AS busy")) {return world.busy?.has(String(params[1])) ? [{ busy: 1 }] : [];}
    if (sql.startsWith("SELECT id FROM conversations WHERE bot_id")) {return [{ id: CONV }];}
    if (sql.includes("FROM conversations c LEFT JOIN companies")) {return [{ id: CONV, company_id: null, company_plan: null, user_plan: "FREE" }];}
    if (sql.includes("count(*)::int AS n FROM ai_jobs")) {return [{ n: 0 }];}
    if (sql.includes("balance_after")) {return [{ balance_after: "100000000" }];}
    if (sql.includes("INSERT INTO ai_jobs")) {
      const payload: Row = JSON.parse(String(params[7]));
      jobs.push({ userId: String(params[3]), payload, key: params[8] });
      return [{ id: String(params[0]), queue: String(params[2]) }];
    }
    if (sql.startsWith("WITH conv")) {return [{ id: CONV }];}
    return null;
  });
  return { ...db, jobs };
};

const deps = (query: Deps["query"]): Deps => ({ query, now: () => NOW, fetch: async () => new Response("{}", { status: 200 }) });

const call = async (query: Deps["query"], method: string, path: string, body?: unknown): Promise<Response> => {
  resetLimits();
  return handle(new Request("https://core.example" + path, {
    method,
    headers: { authorization: "Bearer t", "idempotency-key": crypto.randomUUID(), "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env, deps(query));
};

const run = (query: Deps["query"], token = "job-secret"): Promise<Response> =>
  handle(new Request("https://core.example/api/v1/internal/bots/schedules/run", {
    method: "POST", headers: { authorization: `Bearer ${token}` },
  }), env, deps(query));

type Envelope = { data: Row; error?: { code: string; details: Row } };

test("POST saves a schedule with its first run in Korea time", async () => {
  const db = fake({ schedules: [] });
  const res = await call(db.query, "POST", `/api/v1/bots/${BOT}/schedules`, { prompt: "새 공고 3개 찾아 줘", cadence: "WEEKLY", hour: 9, weekday: 1 });
  assert.equal(res.status, 201);
  const { data } = await readJson<Envelope>(res);
  assert.deepEqual({ ...data, id: "" }, {
    id: "", botId: BOT, prompt: "새 공고 3개 찾아 줘", cadence: "WEEKLY", hour: 9, weekday: 1, enabled: true,
    nextRunAt: "2026-11-30T00:00:00Z", lastRunAt: null, lastError: null,
  });
});

test("POST rejects bad timing, a bad prompt, a sixth schedule and a user without consent", async () => {
  const bad: Array<[Row, string]> = [
    [{ prompt: "x", cadence: "WEEKLY", hour: 9 }, "weekday"],
    [{ prompt: "x", cadence: "DAILY", hour: 9, weekday: 2 }, "weekday"],
    [{ prompt: "x", cadence: "WEEKLY", hour: 9, weekday: 7 }, "weekday"],
    [{ prompt: "x", cadence: "DAILY", hour: 24 }, "hour"],
    [{ prompt: "x", cadence: "DAILY", hour: -1 }, "hour"],
    [{ prompt: "x", cadence: "DAILY", hour: 9.5 }, "hour"],
    [{ prompt: "x", cadence: "MONTHLY", hour: 9 }, "cadence"],
    [{ prompt: "", cadence: "DAILY", hour: 9 }, "prompt"],
    [{ prompt: "   ", cadence: "DAILY", hour: 9 }, "prompt"],
    [{ prompt: "가".repeat(501), cadence: "DAILY", hour: 9 }, "prompt"],
  ];
  for (const [body, field] of bad) {
    const res = await call(fake({ schedules: [] }).query, "POST", `/api/v1/bots/${BOT}/schedules`, body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal((await readJson<Envelope>(res)).error?.details.field, field, JSON.stringify(body));
  }
  const extra = await call(fake({ schedules: [] }).query, "POST", `/api/v1/bots/${BOT}/schedules`, { prompt: "x", cadence: "DAILY", hour: 9, enabled: false });
  assert.equal(extra.status, 400);
  assert.equal((await call(fake({ schedules: [] }).query, "POST", `/api/v1/bots/${BOT}/schedules`, { prompt: "가".repeat(500), cadence: "DAILY", hour: 9 })).status, 201);

  const full = fake({ schedules: [], count: 5 });
  const limited = await call(full.query, "POST", `/api/v1/bots/${BOT}/schedules`, { prompt: "x", cadence: "DAILY", hour: 9 });
  assert.equal(limited.status, 403);
  const limitBody = await readJson<Envelope>(limited);
  assert.equal(limitBody.error?.code, "SCHEDULE_LIMIT");
  assert.equal(limitBody.error?.details.limit, 5);
  assert.equal(full.calls.some((c) => c.sql.startsWith("INSERT INTO bot_schedules")), false);

  const refused = await call(fake({ schedules: [], noConsent: new Set([USER]) }).query, "POST", `/api/v1/bots/${BOT}/schedules`, { prompt: "x", cadence: "DAILY", hour: 9 });
  assert.equal(refused.status, 403);
  assert.equal((await readJson<Envelope>(refused)).error?.code, "CONSENT_REQUIRED");
});

test("PATCH moves nextRunAt only when the timing changes or the schedule is enabled again", async () => {
  const world: World = { schedules: [stored({ cadence: "WEEKLY", weekday: 1, next_run_at: "2026-11-30T00:00:00Z" })] };
  const db = fake(world);
  const path = `/api/v1/bots/${BOT}/schedules/${SCHEDULE}`;

  const renamed = await readJson<Envelope>(await call(db.query, "PATCH", path, { prompt: "마감 임박 공고 알려 줘" }));
  assert.equal(renamed.data.prompt, "마감 임박 공고 알려 줘");
  assert.equal(renamed.data.nextRunAt, "2026-11-30T00:00:00Z");
  assert.equal(renamed.data.weekday, 1);

  const daily = await readJson<Envelope>(await call(db.query, "PATCH", path, { cadence: "DAILY" }));
  assert.equal(daily.data.weekday, null);
  assert.equal(daily.data.nextRunAt, "2026-11-27T00:00:00Z");

  const weeklyWithout = await call(db.query, "PATCH", path, { cadence: "WEEKLY" });
  assert.equal(weeklyWithout.status, 400);

  await call(db.query, "PATCH", path, { enabled: false });
  world.schedules[0].next_run_at = "2026-11-20T00:00:00Z";
  const paused = await readJson<Envelope>(await call(db.query, "PATCH", path, { prompt: "그대로" }));
  assert.equal(paused.data.enabled, false);
  assert.equal(paused.data.nextRunAt, "2026-11-20T00:00:00Z");
  const resumed = await readJson<Envelope>(await call(db.query, "PATCH", path, { enabled: true }));
  assert.equal(resumed.data.nextRunAt, "2026-11-27T00:00:00Z");

  const missing = await call(db.query, "PATCH", `/api/v1/bots/${BOT}/schedules/${OTHER}`, { enabled: true });
  assert.equal(missing.status, 404);
});

test("GET lists and DELETE removes a schedule of the bot", async () => {
  const db = fake({ schedules: [stored()] });
  const list = await readJson<{ data: Array<Row> }>(await call(db.query, "GET", `/api/v1/bots/${BOT}/schedules`));
  assert.deepEqual(list.data.map((row) => row.id), [SCHEDULE]);
  assert.equal((await call(db.query, "DELETE", `/api/v1/bots/${BOT}/schedules/${SCHEDULE}`)).status, 204);
  assert.equal((await call(db.query, "DELETE", `/api/v1/bots/${BOT}/schedules/${OTHER}`)).status, 404);
});

test("the run sends each due prompt once, as ALWAYS_ASK, and a failing row does not stop the rest", async () => {
  const blocked = "77777777-7777-4777-8777-777777777777";
  const busyBot = "66666666-6666-4666-8666-666666666666";
  const world: World = {
    schedules: [
      stored(),
      stored({ id: OTHER, user_id: blocked, prompt: "동의 없음" }),
      stored({ id: "55555555-5555-4555-8555-555555555555", bot_id: busyBot, prompt: "카드 대기 중" }),
      stored({ id: "44444444-4444-4444-8444-444444444444", next_run_at: "2026-11-27T00:00:00Z" }),
    ],
    noConsent: new Set([blocked]),
    busy: new Set([busyBot]),
  };
  const db = fake(world);
  const res = await run(db.query);
  assert.equal(res.status, 200);
  assert.deepEqual((await readJson<Envelope>(res)).data, { ran: 1, failed: 2 });

  assert.equal(db.jobs.length, 1);
  const [job] = db.jobs;
  assert.equal(job.userId, USER);
  assert.equal(job.payload.text, "새 공고 3개 찾아 줘");
  assert.equal(job.payload.accessMode, "ALWAYS_ASK");
  assert.equal(job.payload.access_mode, "ALWAYS_ASK");
  assert.equal(job.payload.ai, null);
  assert.equal(job.key, `schedule:${SCHEDULE}:2026-11-26T00:00:00Z`);

  const [sent, refused, busy, later] = world.schedules;
  assert.equal(Date.parse(sent.next_run_at), Date.parse("2026-11-27T00:00:00Z"));
  assert.equal(sent.last_run_at, NOW.toISOString());
  assert.equal(sent.last_error, null);
  assert.equal(typeof sent.last_job_id, "string");
  assert.equal(refused.last_error, "CONSENT_REQUIRED");
  assert.equal(Date.parse(refused.next_run_at), Date.parse("2026-11-27T00:00:00Z"));
  assert.equal(busy.last_error, "BOT_BUSY");
  assert.equal(later.last_run_at, null);
});

test("an overlapping run that read the same slot sends nothing", async () => {
  const world: World = { schedules: [stored()] };
  const db = fake(world);
  const stale = { ...world.schedules[0] };
  assert.deepEqual((await readJson<Envelope>(await run(db.query))).data, { ran: 1, failed: 0 });
  world.due = [stale];
  assert.deepEqual((await readJson<Envelope>(await run(db.query))).data, { ran: 0, failed: 0 });
  assert.equal(db.jobs.length, 1);
});

test("the run sends nothing for an owner who asked to delete the account after the due rows were read", async () => {
  const world: World = { schedules: [stored()], deleting: new Set([USER]) };
  const db = fake(world);
  assert.deepEqual((await readJson<Envelope>(await run(db.query))).data, { ran: 0, failed: 1 });
  assert.equal(db.jobs.length, 0);
  assert.equal(world.schedules[0].last_error, "ACCOUNT_DELETING");
  assert.ok(db.calls.some((call) => call.sql.includes("deletion_requested_at IS NULL FOR SHARE") && call.params[0] === USER));
});

test("the run needs the internal job token", async () => {
  assert.equal((await run(fake({ schedules: [stored()] }).query, "wrong")).status, 401);
});
