// The gateway's bot rules on a fake database, so they run where there is no Postgres.
// test/bot-thread-pg.test.ts runs the same rules on the real schema.
import assert from "node:assert/strict";
import { test } from "node:test";

import { handle, resetLimits, type Deps, type FrontEnv, type Query } from "../src/handler.ts";
import { isBotThreadProbe, STORED } from "./fakes.ts";

const USER = "12345678-1234-5678-1234-567812345678";
const THREAD = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BOT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const JOB = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const SINCE = "2026-10-18T00:00:00.000000Z";
const BASE = "https://push-be.example/api/v1";

const forwarded: string[] = [];
const env: FrontEnv = {
  APP_ENV: "production",
  SSE_MAX_POLLS: "1",
  AI_ORIGIN: "https://ai.example.test",
  AI_SHARED_SECRET: "secret",
  CORE: { fetch: async (request) => { forwarded.push(request.url); return new Response("{}", { status: 200 }); } },
};

const world = (events: Record<string, unknown>[]): Deps => {
  const query: Query = async (sql, params) => {
    if (isBotThreadProbe(sql)) return params[0] === THREAD ? [{ "?column?": 1 }] : [];
    if (sql.includes("FROM chat_events")) return events.map((row, index) => ({ id: index + 1, created_at: STORED, ...row }));
    if (sql.includes("FROM bots b")) return [{ bot_id: BOT, job_id: JOB }];
    if (sql.includes("access_tokens")) {
      return [{
        id: USER, display_name: "Ada", locale: "ko", created_at: "2026-01-02T03:04:05Z", expires_at: "2099-01-01T00:00:00Z",
        hits: 1, conversation_id: USER, job_id: JOB,
      }];
    }
    return [];
  };
  return { query, sleep: async () => {}, now: () => new Date("2026-10-18T00:00:00Z"), fetch: async (input) => { forwarded.push(String(input)); return new Response("{}"); } };
};

const call = (method: string, path: string, deps: Deps): Promise<Response> => {
  resetLimits();
  return handle(new Request(BASE + path, { method, headers: { authorization: "Bearer secret-token" }, body: method === "GET" ? undefined : "{}" }), env, deps);
};

const framesOf = async (res: Response): Promise<Record<string, unknown>[]> => (await res.text()).split("\n\n")
  .map((block) => block.split("\n").find((line) => line.startsWith("data: ")))
  .filter((line): line is string => line !== undefined)
  .map((line) => JSON.parse(line.slice("data: ".length)) as Record<string, unknown>);

test("a path that names a bot's thread is 404 before any route, whichever worker owns the route", async () => {
  forwarded.length = 0;
  for (const [method, path] of [
    ["GET", ""], ["GET", "/messages"], ["GET", "/messages/stream/active"], ["POST", "/stream/cancel"],
    ["PATCH", ""], ["DELETE", ""], ["POST", "/messages"], ["POST", "/approvals/x"], ["GET", "/turns"], ["POST", "/share"],
  ]) {
    const res = await call(method, `/conversations/${THREAD}${path}`, world([]));
    assert.deepEqual([res.status, ((await res.json()) as { error: { code: string } }).error.code], [404, "NOT_FOUND"], `${method} ${path}`);
  }
  for (const id of [`%7B${THREAD}%7D`, `urn:uuid:${THREAD}`, "not-an-id"]) {
    assert.equal((await call("GET", `/conversations/${id}/turns`, world([]))).status, 400, id);
  }
  assert.deepEqual(forwarded, []);
  assert.equal((await call("GET", `/conversations/${USER}/turns`, world([]))).status, 200, "a conversation is forwarded");
  assert.equal((await call("GET", "/conversations/shared/some-token", world([]))).status, 200, "a share token is not an id");
});

const RUN: Record<string, unknown>[] = [
  { type: "status", payload: { text: "대기 중", phase: "queued", since: SINCE, ahead: 2, extra: "not sent" } },
  { type: "status", payload: { text: "공고를 읽는 중" } },
  { type: "status", payload: { text: "확인을 기다리고 있어요", phase: "waiting", since: SINCE, for: "confirm", cardId: "card-1" } },
  { type: "cancelled", payload: { resumable: true } },
];
const STAMP = { at: STORED, turn: JOB };
const QUEUED = { type: "status", text: "대기 중", phase: "queued", since: SINCE, ahead: 2, seq: 1, ...STAMP };
const WAITING = { type: "status", text: "확인을 기다리고 있어요", phase: "waiting", since: SINCE, for: "confirm", cardId: "card-1", seq: 3, ...STAMP };
const CANCELLED = { type: "cancelled", resumable: true, seq: 4, ...STAMP };

test("a conversation stream sends a status with the fields that say what the run does, or with its text alone", async () => {
  const res = await call("GET", `/conversations/${USER}/messages/stream/active`, world(RUN));
  assert.deepEqual(await framesOf(res), [QUEUED, { type: "status", text: "공고를 읽는 중", seq: 2, ...STAMP }, WAITING, CANCELLED]);
});

test("a bot stream sends no status that has no phase", async () => {
  const res = await call("GET", `/bots/${BOT}/stream`, world(RUN));
  assert.deepEqual(await framesOf(res), [QUEUED, WAITING, CANCELLED]);
});
