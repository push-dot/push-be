import assert from "node:assert/strict";
import { test } from "node:test";

import { handle, resetLimits, type Deps, type FrontEnv, type Query } from "../src/handler.ts";
import { ownerOf } from "../src/routes/owner.ts";

const CONV = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const JOB = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const NOW = new Date("2026-10-22T00:00:00Z");

const env = (core: (request: Request) => Promise<Response>): FrontEnv => ({
  DATABASE_URL: "postgres://example",
  CORE: { fetch: core },
  APP_ENV: "production",
  SSE_MAX_POLLS: "3",
});

const deps = (query: Query): Deps => ({ query, sleep: async () => {}, now: () => NOW });

const send = (body: unknown = { text: "안녕", accessMode: "AUTO" }): Request =>
  new Request(`https://push-be.example/api/v1/conversations/${CONV}/messages/stream`, {
    method: "POST",
    headers: { authorization: "Bearer t", "content-type": "application/json" },
    body: JSON.stringify(body),
  });

test("the gateway queues the message in core and streams that job's events", async () => {
  resetLimits();
  const forwarded: { path: string; body: string }[] = [];
  const reads: unknown[][] = [];
  const res = await handle(send(), env(async (request) => {
    forwarded.push({ path: new URL(request.url).pathname, body: await request.text() });
    return new Response(JSON.stringify({ data: { id: JOB, status: "QUEUED", result: { kind: "CHAT_MESSAGE", value: { jobId: JOB } } } }),
      { status: 202, headers: { "content-type": "application/json" } });
  }), deps(async (sql, params = []) => {
    if (!sql.includes("chat_events")) return [];
    reads.push(params);
    if (reads.length > 1) return [];
    return [
      { id: 7, type: "status", payload: { text: "대기 중" } },
      { id: 8, type: "token", payload: { text: "안녕하세요" } },
      { id: 9, type: "done", payload: { operation: { id: "op-1" } } },
    ];
  }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/event-stream");
  const text = await res.text();
  assert.ok(text.startsWith("retry: 400\n\n"));
  assert.match(text, /id: 7\ndata: \{"type": "status", "text": "\\ub300\\uae30 \\uc911", "seq": 7\}/);
  assert.match(text, /"type": "done", "operation": \{"id": "op-1"\}/);
  assert.deepEqual(forwarded, [{ path: `/api/v1/conversations/${CONV}/messages/stream`, body: JSON.stringify({ text: "안녕", accessMode: "AUTO" }) }]);
  assert.deepEqual(reads[0], [JOB, 0]);
});

test("core errors come back as JSON before any stream", async () => {
  for (const [status, code] of [[402, "INSUFFICIENT_CREDITS"], [429, "QUEUE_BUSY"], [403, "PLAN_REQUIRED"], [403, "BUSINESS_NOT_VERIFIED"]] as const) {
    resetLimits();
    const res = await handle(send(), env(async () => new Response(
      JSON.stringify({ error: { code, message: "no", details: null } }),
      { status, headers: { "content-type": "application/json" } },
    )), deps(async () => { throw new Error("no event reads on an error"); }));
    assert.equal(res.status, status);
    assert.equal(res.headers.get("content-type"), "application/json");
    assert.equal((await res.json() as { error: { code: string } }).error.code, code);
  }
});

test("chat stream messages are owned by core", () => {
  assert.equal(ownerOf("POST", `/api/v1/conversations/${CONV}/messages/stream`), "core");
});
