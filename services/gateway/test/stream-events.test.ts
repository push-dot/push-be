import assert from "node:assert/strict";
import { test } from "node:test";

import { handle, resetLimits } from '../src/handler.ts';
import type { Deps, FrontEnv, Query } from '../src/handler.ts';
import { complete, STORED } from "./fakes.ts";

const USER = "12345678-1234-5678-1234-567812345678";
const JOB = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const NOW = new Date("2026-10-18T00:00:00Z");
const STAMP = { at: STORED, turn: JOB };
const SURFACE = [{ version: "v0.9.1", createSurface: { surfaceId: "s", catalogId: "https://push.app/a2ui/catalogs/push/v1/catalog.json" } }];
const SURFACE_1 = [{ version: "1.0", createSurface: { surfaceId: "s", catalogId: "https://push.app/a2ui/catalogs/push/v1/catalog.json" } }];
/** A live card row stores its surface once per A2UI version. */
const a2ui = (surfaceId: string) => ({ "v0.9.1": { surfaceId, messages: SURFACE }, "1.0": { surfaceId, messages: SURFACE_1 } });

const env = (): FrontEnv => ({
  DATABASE_URL: "postgres://example",
  CORE: { async fetch() { throw new Error("core should not be called"); } },
  APP_ENV: "production",
  MANAGED_AI: "1",
  SSE_MAX_POLLS: "3",
});

const deps = (query: Query): Deps => ({
  query: complete(query),
  sleep: async () => {},
  now: () => NOW,
});

type Row = Awaited<ReturnType<Query>>[number];

const framesOf = (text: string): Array<Row> => {
  const frames: Array<Row> = [];
  for (const block of text.split("\n\n")) {
    const line = block.split("\n").find((item) => item.startsWith("data: "));
    if (!line) {continue;}
    frames.push(JSON.parse(line.slice("data: ".length)));
  }
  return frames;
};

const authQuery = (events: () => Array<Row>): Query => {
  return async (sql) => {
    if (sql.includes("chat_events")) {return events();}
    if (sql.includes("access_tokens")) {
      return [{
        id: USER,
        display_name: "Ada",
        locale: "ko",
        created_at: "2026-01-02T03:04:05Z",
        expires_at: "2099-01-01T00:00:00Z",
        hits: 1,
        conversation_id: USER,
        job_id: JOB,
      }];
    }
    if (sql.includes("FROM conversations")) {return [{ id: USER }];}
    if (sql.includes("FROM chat_jobs")) {return [{ id: JOB }];}
    return [];
  };
};

const stream = async (query: Query, headers: Record<string, string> = {}): Promise<string> => {
  const res = await handle(new Request(
    `https://push-be.example/api/v1/conversations/${USER}/messages/stream/active`,
    { headers: { authorization: "Bearer secret-token", ...headers } },
  ), env(), deps(query));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/event-stream");
  return res.text();
};

test("structured rows keep their fields and an unknown type does not end the stream", async () => {
  resetLimits();
  let reads = 0;
  const text = await stream(authQuery((): Array<Row> => {
    reads += 1;
    if (reads > 1) {return [{ id: 99, type: "token", payload: { text: "second-poll" } }];}
    return [
      { id: 10, type: "token", payload: { text: "hi", extra: true } },
      { id: 11, type: "tool", payload: { name: "read", state: "run", summary: "file" } },
      { id: 12, type: "todo", payload: { items: [{ id: "t1", text: "draft", state: "now" }] } },
      { id: 13, type: "diff", payload: {
        documentId: "doc-1", revisionId: "rev-1",
        hunks: [{ line: 4, sign: "+", text: "line" }], sid: "s-13", a2ui: a2ui("s-13"),
      } },
      { id: 14, type: "approval", payload: {
        id: "ap-1", kind: "DOCUMENT_EDIT", title: "Apply?",
        options: [{ id: "apply", label: "Apply" }], a2ui: a2ui("ap-1"),
      } },
      { id: 15, type: "choice", payload: { id: "ch-1", auto: true, options: [{ id: "a", label: "A" }] } },
      { id: 16, type: "fit", payload: { score: 7.4, sid: "s-16", a2ui: a2ui("s-16") } },
      { id: 17, type: "future", payload: { note: "later" } },
      { id: 18, type: "status", payload: { text: "still going" } },
      { id: 19, type: "done", payload: { operation: { status: "SUCCEEDED" } } },
      { id: 20, type: "token", payload: { text: "after-done" } },
    ];
  }));
  const frames = framesOf(text);
  assert.deepEqual(frames[0], { type: "token", text: "hi", seq: 10, ...STAMP });
  assert.deepEqual(frames[1], { type: "tool", name: "read", state: "run", summary: "file", seq: 11, ...STAMP });
  // A card row is sent as its surface; one without a surface (todo stored before surfaces, an auto-picked choice) is not sent.
  assert.deepEqual(frames[2], { type: "a2ui", kind: "diff", surfaceId: "s-13", messages: SURFACE, seq: 13, ...STAMP });
  assert.deepEqual(frames[3], { type: "a2ui", kind: "approval", surfaceId: "ap-1", messages: SURFACE, seq: 14, ...STAMP });
  assert.deepEqual(frames[4], { type: "a2ui", kind: "fit", surfaceId: "s-16", messages: SURFACE, seq: 16, ...STAMP });
  assert.deepEqual(frames[5], { type: "future", note: "later", seq: 17, ...STAMP });
  assert.deepEqual(frames[6], { type: "status", text: "still going", seq: 18, ...STAMP });
  assert.deepEqual(frames[7], { type: "done", operation: { status: "SUCCEEDED" }, seq: 19, ...STAMP });
  assert.equal(frames.length, 8);
  assert.equal(reads, 1);
  assert.equal(text.includes("after-done"), false);
  assert.equal(text.includes("second-poll"), false);
});

test("cancelled ends the poll and does not forward later rows", async () => {
  resetLimits();
  let reads = 0;
  const text = await stream(authQuery((): Array<Row> => {
    reads += 1;
    if (reads > 1) {return [{ id: 99, type: "token", payload: { text: "second-poll" } }];}
    return [
      { id: 4, type: "cancelled", payload: {} },
      { id: 5, type: "token", payload: { text: "after-cancel" } },
    ];
  }));
  assert.deepEqual(framesOf(text), [{ type: "cancelled", resumable: false, seq: 4, ...STAMP }]);
  assert.equal(reads, 1);
  assert.equal(text.includes("after-cancel"), false);
  assert.equal(text.includes("second-poll"), false);
});

test("a done row that waits for the user keeps awaiting", async () => {
  resetLimits();
  const text = await stream(authQuery((): Array<Row> => [
    { id: 20, type: "approval", payload: { id: "a1", kind: "TOOL_ACTION", title: "지원", options: [] } },
    { id: 21, type: "done", payload: { awaiting: "approval" } },
  ]));
  const done = framesOf(text).find((frame) => frame.type === "done");
  assert.deepEqual(done, { type: "done", operation: null, awaiting: "approval", seq: 21, ...STAMP });
});

test("replay skips markdown file cards and keeps other file cards", async () => {
  resetLimits();
  const text = await stream(authQuery((): Array<Row> => [
    { id: 1, type: "file", payload: { name: "05_final_resume.md", mime: "text/markdown" } },
    { id: 2, type: "file", payload: { name: "03_draft_resume_v1.md", mime: "text/plain" } },
    { id: 3, type: "file", payload: { name: "김서준_모아페이_백엔드.pdf", mime: "application/pdf" } },
    { id: 4, type: "done", payload: { operation: null } },
  ]));
  const frames = framesOf(text);
  assert.equal(frames.some((frame) => String(frame.name ?? "").endsWith(".md")), false);
  assert.deepEqual(
    frames.find((frame) => frame.type === "file"),
    { type: "file", name: "김서준_모아페이_백엔드.pdf", mime: "application/pdf", seq: 3, ...STAMP },
  );
});

const PLAN_ROWS = (): Array<Row> => [
  { id: 1, type: "plan", payload: { id: "strategy", sid: "p", a2ui: a2ui("p") } },
  { id: 2, type: "done", payload: { operation: null } },
];

const messagesFor = async (headers: Record<string, string>) => {
  resetLimits();
  return framesOf(await stream(authQuery(PLAN_ROWS), headers)).find((frame) => frame.type === "a2ui")?.messages;
};

test("a card frame carries the A2UI version the request names, v0.9.1 by default", async () => {
  assert.deepEqual(await messagesFor({}), SURFACE);
  assert.deepEqual(await messagesFor({ "A2UI-Version": "v0.9.1" }), SURFACE);
  assert.deepEqual(await messagesFor({ "A2UI-Version": "1.0" }), SURFACE_1);
  assert.deepEqual(await messagesFor({ "A2UI-Version": "0.8" }), SURFACE);
});

test("a card row with no surface of the asked version is not sent", async () => {
  resetLimits();
  const text = await stream(authQuery((): Array<Row> => [
    { id: 1, type: "plan", payload: { id: "strategy", a2ui: { "v0.9.1": { surfaceId: "p", messages: SURFACE } } } },
    { id: 2, type: "done", payload: { operation: null } },
  ]), { "A2UI-Version": "1.0" });
  assert.deepEqual(framesOf(text).map((frame) => frame.type), ["done"]);
});
