import assert from "node:assert/strict";
import { test } from "node:test";

import { handle, type CoreEnv, type Deps } from "../src/handler.ts";
import { resetLimits } from "../src/ratelimit.ts";

const USER = "12345678-1234-5678-1234-567812345678";
const NOW = new Date("2026-10-18T00:00:00Z");

function env(extra: Partial<CoreEnv> = {}): CoreEnv {
  return {
    APP_ENV: "production",
    MANAGED_AI: "1",
    MANAGED_GO: "0",
    BYOK_MASTER_KEY: "test-master-key",
    ...extra,
  };
}

function paidQuery(): Deps["query"] {
  return async (sql) => {
    if (sql.includes("access_tokens")) {
      return {
        rows: [{
          id: USER, display_name: "Ada", locale: "ko", plan: "PRO",
          created_at: "2026-01-02T03:04:05Z", token_expires_at: "2099-01-01T00:00:00Z",
        }],
        rowCount: 1,
      };
    }
    if (sql.includes("rate_limits")) return { rows: [{ hits: 1 }], rowCount: 1 };
    if (sql.includes("FROM users")) return { rows: [{ plan: "PRO" }], rowCount: 1 };
    if (sql.includes("ai_usage")) return { rows: [{ spent: 0 }], rowCount: 1 };
    if (sql.includes("idempotency_keys") && sql.includes("INSERT")) {
      return { rows: [{ id: "idem" }], rowCount: 1 };
    }
    if (sql.includes("chat_jobs")) return { rows: [{ id: "job-1" }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
}

function message(key: string): Request {
  return new Request("https://core.example/api/v1/conversations/" + USER + "/messages", {
    method: "POST",
    headers: {
      authorization: "Bearer secret-token",
      "content-type": "application/json",
      "idempotency-key": key,
    },
    body: JSON.stringify({
      text: "hello",
      accessMode: "SUGGEST",
      ai: {
        provider: "OPENAI",
        model: "deepseek/deepseek-v4.1-flash",
        credentialMode: "MANAGED",
        effort: "LOW",
      },
    }),
  });
}

test("core schedules the Cloudflare workflow when AI_ORIGIN is unset", async () => {
  resetLimits();
  let calls = 0;
  const api = {
    async fetch() {
      calls += 1;
      return new Response('{"data":{"scheduled":true}}', { status: 200 });
    },
  };
  const res = await handle(message("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"), env({
    API: api,
    AI_ORIGIN: "  ",
  }), { query: paidQuery(), now: () => NOW });
  assert.equal(res.status, 202);
  assert.equal(calls, 1);
  const op = await res.json() as { data: { status: string; type: string } };
  assert.equal(op.data.status, "QUEUED");
  assert.equal(op.data.type, "CHAT_MESSAGE");
});

test("core wakes the VPS when AI_ORIGIN is set and still queues if the wake fails", async () => {
  resetLimits();
  let calls = 0;
  const sqls: string[] = [];
  const woke = { url: "", secret: "", internal: "", body: "" };
  const query = paidQuery();
  const wrapped: Deps["query"] = async (sql, params) => {
    sqls.push(sql);
    return query(sql, params);
  };
  const api = {
    async fetch() {
      calls += 1;
      return new Response("nope", { status: 500 });
    },
  };
  const res = await handle(message("bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee"), env({
    API: api,
    AI_ORIGIN: "https://ai.example.test/",
    AI_SHARED_SECRET: "s3cret",
  }), {
    query: wrapped,
    now: () => NOW,
    fetch: async (input, init) => {
      const headers = new Headers(init?.headers);
      woke.url = String(input);
      woke.secret = headers.get("x-push-ai-secret") || "";
      woke.internal = headers.get("x-push-internal") || "";
      woke.body = String(init?.body || "");
      return new Response("no", { status: 500 });
    },
  });
  assert.equal(res.status, 202);
  assert.equal(calls, 0);
  assert.equal(woke.url, "https://ai.example.test/internal/chat/schedule");
  assert.equal(woke.secret, "s3cret");
  assert.equal(woke.internal, "1");
  assert.match(woke.body, /jobId/);
  assert.equal(sqls.some((sql) => sql.includes("chat_jobs")), true);
  const op = await res.json() as { data: { status: string; result: { value: { jobId: string } }; id: string } };
  assert.equal(op.data.status, "QUEUED");
  assert.equal(op.data.result.value.jobId, op.data.id);
});
