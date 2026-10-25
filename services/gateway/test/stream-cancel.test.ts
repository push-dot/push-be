import assert from "node:assert/strict";
import { test } from "node:test";

import { memoryCache } from "../src/middleware/cache.ts";
import { handle, resetLimits, type Deps, type FrontEnv, type Query } from "../src/handler.ts";

const USER = "12345678-1234-5678-1234-567812345678";
const CONV = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const JOB = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const NOW = new Date("2026-10-18T00:00:00Z");

const env = (): FrontEnv => ({
  DATABASE_URL: "postgres://example",
  API: { async fetch() { throw new Error("python should not be called"); } },
  CORE: { async fetch() { throw new Error("core should not be called"); } },
  APP_ENV: "production",
  MANAGED_AI: "1",
  MANAGED_GO: "0",
  SSE_MAX_POLLS: "3",
});

const deps = (query: Query): Deps => ({
  query,
  cache: memoryCache(() => NOW.getTime()),
  sleep: async () => {},
  now: () => NOW,
});

const framesOf = (text: string): Record<string, unknown>[] => {
  const frames: Record<string, unknown>[] = [];
  for (const block of text.split("\n\n")) {
    const line = block.split("\n").find((item) => item.startsWith("data: "));
    if (!line) continue;
    frames.push(JSON.parse(line.slice("data: ".length)) as Record<string, unknown>);
  }
  return frames;
};

const authRow = (job: boolean): Record<string, unknown> => ({
  id: USER,
  display_name: "Ada",
  locale: "ko",
  created_at: "2026-01-02T03:04:05Z",
  expires_at: "2099-01-01T00:00:00Z",
  hits: 1,
  conversation_id: CONV,
  job_id: job ? JOB : null,
});

// The cancel is one statement: find the job, mark it, record the event.
// The fake applies it the way Postgres would for the given job state.
const cancelQuery = (
  sqls: string[],
  events: Record<string, unknown>[],
  selectJob: boolean,
  updateHits: boolean,
): Query => {
  return async (sql) => {
    sqls.push(sql);
    if (sql.includes("UPDATE chat_jobs")) {
      const cancelled = selectJob && updateHits;
      if (cancelled) events.push({ id: 4, type: "cancelled", payload: {} });
      return [{ conversation_id: CONV, job_id: cancelled ? JOB : null }];
    }
    if (sql.includes("chat_events")) return events.slice();
    if (sql.includes("access_tokens")) return [authRow(selectJob)];
    return [];
  };
};

const cancel = async (query: Query): Promise<Response> => {
  return handle(new Request(
    `https://push-be.example/api/v1/conversations/${CONV}/stream/cancel`,
    { method: "POST", headers: { authorization: "Bearer secret-token" } },
  ), env(), deps(query));
};

test("active job cancels, records the event, and the next SSE read ends", async () => {
  resetLimits();
  const sqls: string[] = [];
  const events: Record<string, unknown>[] = [];
  const res = await cancel(cancelQuery(sqls, events, true, true));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { data: { jobId: JOB, status: "CANCELLED" } });
  const writes = sqls.filter((sql) => sql.includes("UPDATE chat_jobs") || sql.includes("INSERT INTO chat_events"));
  assert.equal(writes.length, 1);
  assert.match(writes[0], /UPDATE chat_jobs SET status = 'CANCELLED'.*WHERE id = \(SELECT id FROM job\) AND status IN \('PENDING', 'RUNNING'\)/);
  assert.match(writes[0], /INSERT INTO chat_events \(job_id, type, payload\) SELECT id, 'cancelled', '\{\}'::jsonb FROM cancelled/);
  const stream = await handle(new Request(
    `https://push-be.example/api/v1/conversations/${CONV}/messages/stream/active`,
    { headers: { authorization: "Bearer secret-token" } },
  ), env(), deps(cancelQuery(sqls, events, true, true)));
  assert.equal(stream.status, 200);
  assert.deepEqual(framesOf(await stream.text()), [{ type: "cancelled", seq: 4 }]);
  assert.equal(sqls.filter((sql) => sql.includes("FROM chat_events")).length, 1);
});

test("no active job is a conflict and records no event", async () => {
  resetLimits();
  const sqls: string[] = [];
  const events: Record<string, unknown>[] = [];
  const res = await cancel(cancelQuery(sqls, events, false, false));
  assert.equal(res.status, 409);
  assert.equal((await res.json() as { error: { code: string } }).error.code, "CONFLICT");
  assert.equal(events.length, 0);
});

test("a job that is no longer pending or running is a conflict", async () => {
  resetLimits();
  const sqls: string[] = [];
  const events: Record<string, unknown>[] = [];
  const res = await cancel(cancelQuery(sqls, events, true, false));
  assert.equal(res.status, 409);
  assert.equal((await res.json() as { error: { code: string } }).error.code, "CONFLICT");
  assert.equal(events.length, 0);
});
