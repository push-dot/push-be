import assert from "node:assert/strict";
import { test } from "node:test";

import { handle, resetLimits, type Deps, type FrontEnv, type Query } from "../src/handler.ts";

const USER = "12345678-1234-5678-1234-567812345678";
const JOB = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const NOW = new Date("2026-10-18T00:00:00Z");

const env = (): FrontEnv => ({
  DATABASE_URL: "postgres://example",
  CORE: { async fetch() { throw new Error("core should not be called"); } },
  APP_ENV: "production",
  MANAGED_AI: "1",
  MANAGED_GO: "0",
  SSE_MAX_POLLS: "3",
});

const deps = (query: Query): Deps => ({
  query,
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

const authQuery = (events: () => Record<string, unknown>[]): Query => {
  return async (sql) => {
    if (sql.includes("chat_events")) return events();
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
    if (sql.includes("FROM conversations")) return [{ id: USER }];
    if (sql.includes("FROM chat_jobs")) return [{ id: JOB }];
    return [];
  };
};

const stream = async (query: Query): Promise<string> => {
  const res = await handle(new Request(
    `https://push-be.example/api/v1/conversations/${USER}/messages/stream/active`,
    { headers: { authorization: "Bearer secret-token" } },
  ), env(), deps(query));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/event-stream");
  return res.text();
};

test("structured rows keep their fields and an unknown type does not end the stream", async () => {
  resetLimits();
  let reads = 0;
  const text = await stream(authQuery(() => {
    reads += 1;
    if (reads > 1) return [{ id: 99, type: "token", payload: { text: "second-poll" } }];
    return [
      { id: 10, type: "token", payload: { text: "hi", extra: true } },
      { id: 11, type: "tool", payload: { name: "read", state: "run", summary: "file" } },
      { id: 12, type: "todo", payload: { items: [{ id: "t1", text: "draft", state: "now" }] } },
      { id: 13, type: "diff", payload: {
        documentId: "doc-1", revisionId: "rev-1",
        hunks: [{ line: 4, sign: "+", text: "line" }],
      } },
      { id: 14, type: "approval", payload: {
        id: "ap-1", kind: "DOCUMENT_EDIT", title: "Apply?",
        options: [{ id: "apply", label: "Apply" }],
      } },
      { id: 15, type: "choice", payload: { id: "ch-1", options: [{ id: "a", label: "A" }] } },
      { id: 16, type: "fit", payload: {
        score: 7.4,
        parts: { techStack: 8, experienceLink: 5.5, careerLevel: 6, keyword: 4, domain: 3 },
        topGap: "tests",
      } },
      { id: 17, type: "future", payload: { note: "later" } },
      { id: 18, type: "status", payload: { text: "still going" } },
      { id: 19, type: "done", payload: { operation: { status: "SUCCEEDED" } } },
      { id: 20, type: "token", payload: { text: "after-done" } },
    ];
  }));
  const frames = framesOf(text);
  assert.deepEqual(frames[0], { type: "token", text: "hi", seq: 10 });
  assert.deepEqual(frames[1], { type: "tool", name: "read", state: "run", summary: "file", seq: 11 });
  assert.deepEqual(frames[2], {
    type: "todo", seq: 12, items: [{ id: "t1", text: "draft", state: "now" }],
  });
  assert.deepEqual(frames[3], {
    type: "diff", seq: 13, documentId: "doc-1", revisionId: "rev-1",
    hunks: [{ line: 4, sign: "+", text: "line" }],
  });
  assert.deepEqual(frames[4], {
    type: "approval", seq: 14, id: "ap-1", kind: "DOCUMENT_EDIT", title: "Apply?",
    options: [{ id: "apply", label: "Apply" }],
  });
  assert.deepEqual(frames[5], {
    type: "choice", seq: 15, id: "ch-1", options: [{ id: "a", label: "A" }],
  });
  assert.deepEqual(frames[6], {
    type: "fit", seq: 16, score: 7.4, topGap: "tests",
    parts: { techStack: 8, experienceLink: 5.5, careerLevel: 6, keyword: 4, domain: 3 },
  });
  assert.deepEqual(frames[7], { type: "future", note: "later", seq: 17 });
  assert.deepEqual(frames[8], { type: "status", text: "still going", seq: 18 });
  assert.deepEqual(frames[9], { type: "done", operation: { status: "SUCCEEDED" }, seq: 19 });
  assert.equal(frames.length, 10);
  assert.equal(reads, 1);
  assert.equal(text.includes("after-done"), false);
  assert.equal(text.includes("second-poll"), false);
});

test("cancelled ends the poll and does not forward later rows", async () => {
  resetLimits();
  let reads = 0;
  const text = await stream(authQuery(() => {
    reads += 1;
    if (reads > 1) return [{ id: 99, type: "token", payload: { text: "second-poll" } }];
    return [
      { id: 4, type: "cancelled", payload: {} },
      { id: 5, type: "token", payload: { text: "after-cancel" } },
    ];
  }));
  assert.deepEqual(framesOf(text), [{ type: "cancelled", seq: 4 }]);
  assert.equal(reads, 1);
  assert.equal(text.includes("after-cancel"), false);
  assert.equal(text.includes("second-poll"), false);
});

test("a done row that waits for the user keeps awaiting", async () => {
  resetLimits();
  const text = await stream(authQuery(() => [
    { id: 20, type: "approval", payload: { id: "a1", kind: "TOOL_ACTION", title: "지원", options: [] } },
    { id: 21, type: "done", payload: { awaiting: "approval" } },
  ]));
  const done = framesOf(text).find((frame) => frame.type === "done");
  assert.deepEqual(done, { type: "done", operation: null, awaiting: "approval", seq: 21 });
});
