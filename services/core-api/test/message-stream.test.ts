import assert from "node:assert/strict";
import { test } from "node:test";

import { handle, type CoreEnv, type Deps } from "../src/handler.ts";
import { resetLimits } from "../src/ratelimit.ts";

const USER = "12345678-1234-5678-1234-567812345678";
const CONV = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const COMPANY = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const NOW = new Date("2026-10-22T00:00:00Z");

type Row = Record<string, unknown>;
type World = { company?: Row | null; balance?: string; depth?: number; consent?: boolean };

const env = (extra: Partial<CoreEnv> = {}): CoreEnv => ({
  APP_ENV: "production", AI_ORIGIN: "https://ai.example.test", MANAGED_AI: "1", ...extra,
});

const fake = (world: World = {}) => {
  const sqls: string[] = [];
  const query: Deps["query"] = async (sql, params = []) => {
    sqls.push(sql);
    const rows = (list: Row[]) => ({ rows: list, rowCount: list.length });
    if (sql.includes("access_tokens")) {
      return rows([{ id: USER, display_name: "Ada", locale: "ko", plan: "PRO", created_at: "2026-01-02T03:04:05Z", token_expires_at: "2099-01-01T00:00:00Z" }]);
    }
    if (sql.includes("rate_limits")) return rows([{ hits: 1 }]);
    if (sql.includes("user_consents")) return rows([{ reference_data: world.consent !== false }]);
    if (sql.includes("co.verified_at")) return rows(world.company ? [world.company] : [{ company_id: null }]);
    if (sql.includes("FROM conversations c LEFT JOIN companies")) {
      const company = world.company;
      return rows([{ id: CONV, company_id: company?.company_id ?? null, company_plan: company?.plan ?? null, user_plan: "PRO" }]);
    }
    if (sql.includes("count(*)::int AS n FROM ai_jobs")) return rows([{ n: world.depth ?? 0 }]);
    if (sql.includes("balance_after")) return rows([{ balance_after: world.balance ?? "100000000" }]);
    if (sql.includes("INSERT INTO ai_jobs")) return rows([{ id: params[0], queue: params[2] }]);
    if (sql.startsWith("WITH conv")) return rows([{ id: params[2] }]);
    return rows([]);
  };
  return { query, sqls };
};

const stream = (body: Row = { text: "안녕", accessMode: "AUTO" }): Request =>
  new Request(`https://core.example/api/v1/conversations/${CONV}/messages/stream`, {
    method: "POST",
    headers: { authorization: "Bearer t", "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const deps = (query: Deps["query"]): Deps => ({ query, now: () => NOW, fetch: async () => new Response("{}", { status: 200 }) });

const errorCode = async (res: Response): Promise<string> => (await res.json() as { error: { code: string } }).error.code;

test("a stuck dispatcher kick does not hold the chat response", async () => {
  resetLimits();
  let handedOff = false;
  const res = await handle(stream(), env({
    QUEUE_BACKEND: "redis",
    DISPATCH_ORIGIN: "https://dispatch.test",
    DISPATCH_SECRET: "d",
  }), {
    query: fake().query,
    now: () => NOW,
    fetch: () => new Promise(() => {}),
    waitUntil: () => { handedOff = true; },
  });
  assert.equal(res.status, 202);
  assert.equal(handedOff, true);
});

test("the stream route queues a job without an Idempotency-Key on both backends", async () => {
  for (const backend of ["postgres", "redis"]) {
    resetLimits();
    const db = fake();
    const res = await handle(stream(), env({ QUEUE_BACKEND: backend }), deps(db.query));
    assert.equal(res.status, 202, backend);
    const body = await res.json() as { data: { result: { value: { jobId: string } } } };
    assert.match(body.data.result.value.jobId, /^[0-9a-f-]{36}$/);
    const insert = db.sqls.find((sql) => sql.startsWith("WITH conv")) || "";
    assert.match(insert, /UPDATE approvals SET status = 'REJECTED'/, backend);
    assert.equal(db.sqls.some((sql) => sql.includes("INSERT INTO ai_jobs")), backend === "redis");
  }
});

test("the stream route rejects before queueing: plan gate, unverified company, credits, backpressure", async () => {
  resetLimits();
  const basic = await handle(stream({ text: "면접", accessMode: "AUTO", intent: "interview" }),
    env(), deps(fake({ company: { company_id: COMPANY, plan: "BASIC", verified_at: NOW.toISOString() } }).query));
  assert.equal(basic.status, 403);
  assert.equal(await errorCode(basic), "PLAN_REQUIRED");

  resetLimits();
  const unverified = await handle(stream(), env(), deps(fake({ company: { company_id: COMPANY, plan: "PRO", verified_at: null } }).query));
  assert.equal(unverified.status, 403);
  assert.equal(await errorCode(unverified), "BUSINESS_NOT_VERIFIED");

  resetLimits();
  const broke = fake({ balance: "0" });
  const poor = await handle(stream(), env({ QUEUE_BACKEND: "redis" }), deps(broke.query));
  assert.equal(poor.status, 402);
  assert.equal(await errorCode(poor), "INSUFFICIENT_CREDITS");
  assert.ok(!broke.sqls.some((sql) => sql.includes("INSERT INTO ai_jobs")));

  resetLimits();
  const busy = await handle(stream(), env({ QUEUE_BACKEND: "redis" }), deps(fake({ depth: 1_000_000 }).query));
  assert.equal(busy.status, 429);
  const error = (await busy.json() as { error: { code: string; details: { retryAfterSec: number; ahead: number } } }).error;
  assert.equal(error.code, "QUEUE_BUSY");
  assert.equal(error.details.ahead, 1_000_000);
  assert.equal(typeof error.details.retryAfterSec, "number");
});

test("redis idempotent stream retry does not re-run approval rejection or status events", async () => {
  resetLimits();
  const JOB = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const KEY = "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  let inserts = 0;
  const sqls: string[] = [];
  const query: Deps["query"] = async (sql, params = []) => {
    const rows = (list: Row[]) => ({ rows: list, rowCount: list.length });
    if (sql.includes("SELECT id, queue FROM ai_jobs WHERE user_id")) {
      if (inserts > 0) return rows([{ id: JOB, queue: "personal.chat" }]);
      return rows([]);
    }
    if (sql.startsWith("WITH conv")) {
      sqls.push(sql);
      return rows([{ id: CONV }]);
    }
    if (sql.includes("INSERT INTO ai_jobs")) {
      inserts += 1;
      return rows([{ id: params[0], queue: params[2] }]);
    }
    if (sql.includes("access_tokens")) {
      return rows([{ id: USER, display_name: "Ada", locale: "ko", plan: "PRO", created_at: "2026-01-02T03:04:05Z", token_expires_at: "2099-01-01T00:00:00Z" }]);
    }
    if (sql.includes("rate_limits")) return rows([{ hits: 1 }]);
    if (sql.includes("user_consents")) return rows([{ reference_data: true }]);
    if (sql.includes("co.verified_at")) return rows([{ company_id: null }]);
    if (sql.includes("FROM conversations c LEFT JOIN companies")) {
      return rows([{ id: CONV, company_id: null, company_plan: null, user_plan: "PRO" }]);
    }
    if (sql.includes("count(*)::int AS n FROM ai_jobs")) return rows([{ n: 0 }]);
    if (sql.includes("balance_after")) return rows([{ balance_after: "100000000" }]);
    return rows([]);
  };
  const run = () => handle(new Request(`https://core.example/api/v1/conversations/${CONV}/messages/stream`, {
    method: "POST",
    headers: { authorization: "Bearer t", "content-type": "application/json", "idempotency-key": KEY },
    body: JSON.stringify({ text: "안녕", accessMode: "AUTO" }),
  }), env({ QUEUE_BACKEND: "redis" }), deps(query));
  assert.equal((await run()).status, 202);
  assert.equal((await run()).status, 202);
  assert.equal(sqls.length, 2);
  assert.match(sqls[1], /EXISTS \(SELECT 1 FROM msg\)/);
  assert.match(sqls[1], /INSERT INTO chat_events \(job_id, type, payload\) SELECT j\.id, 'status', [\s\S]* FROM ai_jobs j WHERE j\.id = \$3 AND EXISTS \(SELECT 1 FROM msg\)/);
});

test("a personal stream without reference consent is 403 before queueing", async () => {
  resetLimits();
  const db = fake({ consent: false });
  const res = await handle(stream(), env(), deps(db.query));
  assert.equal(res.status, 403);
  assert.equal(await errorCode(res), "CONSENT_REQUIRED");
  assert.equal(db.sqls.some((sql) => sql.startsWith("WITH conv") || sql.includes("INSERT INTO ai_jobs")), false);
});
