import assert from "node:assert/strict";
import { test } from "node:test";

import { handle, type CoreEnv, type Deps } from "../src/handler.ts";
import { resetLimits } from "../src/ratelimit.ts";

const USER = "12345678-1234-5678-1234-567812345678";
const NOW = "2026-10-21T00:00:00.000Z";

const env = (): CoreEnv => ({ APP_ENV: "production", MANAGED_AI: "1", MANAGED_GO: "0" });
const empty = { rows: [] as Record<string, unknown>[], rowCount: 0 };

const deps = (): Deps => ({
  now: () => new Date(NOW),
  query: async (sql, params = []) => {
    if (sql.includes("rate_limits")) return { rows: [{ hits: 1 }], rowCount: 1 };
    if (sql.includes("access_tokens")) {
      return {
        rows: [{
          id: USER, display_name: "Ada", locale: "ko", plan: "PRO", subscription_status: "NONE",
          created_at: NOW, token_expires_at: "2099-01-01T00:00:00Z", is_employer: false,
          email: "ada@push.app", provider: "email",
        }],
        rowCount: 1,
      };
    }
    if (sql.includes("idempotency_keys") && sql.includes("INSERT")) return { rows: [{ id: "1" }], rowCount: 1 };
    if (sql.includes("FROM users")) return { rows: [{ plan: "PRO", is_employer: false }], rowCount: 1 };
    if (sql.includes("user_consents")) return { rows: [{ reference_data: true }], rowCount: 1 };
    if (sql.includes("co.verified_at")) return { rows: [{ company_id: null, plan: null, verified_at: null }], rowCount: 1 };
    if (sql.includes("chat_jobs")) return { rows: [{ id: String(params[2]) }], rowCount: 1 };
    return empty;
  },
});

const message = (ai: Record<string, unknown>, key: string): Request => new Request(
  "https://core.example/api/v1/conversations/" + USER + "/messages",
  {
    method: "POST",
    headers: { authorization: "Bearer secret-token", "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify({ text: "hi", ai }),
  },
);

const AI = { provider: "OPENAI", model: "gpt-x", effort: "LOW" };

test("the ai keys routes are gone", async () => {
  for (const [method, path] of [
    ["GET", "/api/v1/ai/keys"],
    ["PUT", "/api/v1/ai/keys/OPENAI"],
    ["DELETE", "/api/v1/ai/keys/OPENAI"],
    ["POST", "/api/v1/ai/keys/OPENAI/test"],
  ] as const) {
    resetLimits();
    const res = await handle(new Request("https://core.example" + path, {
      method,
      headers: {
        authorization: "Bearer secret-token",
        "content-type": "application/json",
        "idempotency-key": "dddddddd-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      },
      body: method === "PUT" || method === "POST" ? JSON.stringify({ key: "sk-12345678" }) : undefined,
    }), env(), deps());
    assert.equal(res.status, 404, `${method} ${path}`);
    assert.equal((await res.json() as { error: { code: string } }).error.code, "NOT_FOUND");
  }
});

test("a message stores the plan effort and ignores the client value", async () => {
  const scheduled = { ...env(), AI_ORIGIN: "https://ai.example.test" };
  const capture = (slot: { payload: string }): Deps => ({
    ...deps(),
    fetch: async () => new Response("ok"),
    query: async (sql, params = []) => {
      if (sql.includes("INSERT INTO chat_jobs")) slot.payload = String(params[3] ?? "");
      return deps().query(sql, params);
    },
  });
  resetLimits();
  const sent = { payload: "" };
  const res = await handle(message({ provider: "OPENAI", model: "gpt-x", effort: "HIGH" }, "cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee"), scheduled, capture(sent));
  assert.equal(res.status, 202);
  assert.equal(JSON.parse(sent.payload).ai.effort, "MEDIUM");

  resetLimits();
  const omittedSlot = { payload: "" };
  const omitted = await handle(message({ provider: "OPENAI", model: "gpt-x" }, "dddddddd-bbbb-4ccc-8ddd-eeeeeeeeeeee"), scheduled, capture(omittedSlot));
  assert.equal(omitted.status, 202);
  assert.equal(JSON.parse(omittedSlot.payload).ai.effort, "MEDIUM");

  resetLimits();
  const bad = await handle(message({ provider: "OPENAI", model: "gpt-x", effort: "HUGE" }, "eeeeeeee-bbbb-4ccc-8ddd-eeeeeeeeeeee"), env(), deps());
  assert.equal(bad.status, 400);
  assert.equal((await bad.json() as { error: { code: string } }).error.code, "VALIDATION_ERROR");
});

test("a message is accepted whatever provider the client names", async () => {
  resetLimits();
  const res = await handle(message({ ...AI, provider: "CLAUDE" }, "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee"), { ...env(), AI_ORIGIN: "https://ai.example.test" }, { ...deps(), fetch: async () => new Response("ok") });
  assert.equal(res.status, 202);
});
