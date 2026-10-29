import assert from "node:assert/strict";
import { test } from "node:test";

import { handle, type CoreEnv, type Deps } from "../src/handler.ts";
import { resetLimits } from "../src/ratelimit.ts";

const USER = "12345678-1234-5678-1234-567812345678";
const COMPANY = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CONV = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const NOW = new Date("2026-10-18T00:00:00Z");

const INTENTS = ["match_posting", "fit", "gaps", "experience", "boost"] as const;

const env = (): CoreEnv => ({
  APP_ENV: "production",
  MANAGED_AI: "1",
  AI_ORIGIN: "http://ai.example",
});

const authRow = {
  id: USER,
  display_name: "Ada",
  locale: "ko",
  plan: "FREE",
  created_at: "2026-01-02T03:04:05Z",
  token_expires_at: "2099-01-01T00:00:00Z",
};

const post = (body: string, key: string) => new Request(
  "https://core.example/api/v1/conversations/" + CONV + "/messages",
  {
    method: "POST",
    headers: {
      authorization: "Bearer secret-token",
      "content-type": "application/json",
      "idempotency-key": key,
    },
    body,
  },
);

const deps = (query: Deps["query"]): Deps => ({ query, now: () => NOW });

test("personal conversations accept quick-start intents", async () => {
  for (const [index, intent] of INTENTS.entries()) {
    resetLimits();
    let payload = "";
    const res = await handle(post(JSON.stringify({
      text: "시작해 주세요",
      accessMode: "AUTO",
      intent,
    }), `bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeee1${index}`), env(), deps(async (sql, next) => {
      if (sql.includes("access_tokens")) return { rows: [authRow], rowCount: 1 };
      if (sql.includes("rate_limits")) return { rows: [{ hits: 1 }], rowCount: 1 };
      if (sql.includes("idempotency_keys") && sql.includes("INSERT")) return { rows: [{ id: "idem" }], rowCount: 1 };
      if (sql.includes("idempotency_keys") && sql.includes("UPDATE")) return { rows: [], rowCount: 1 };
      if (sql.includes("user_consents")) return { rows: [{ reference_data: true }], rowCount: 1 };
      if (sql.includes("chat_jobs")) {
        payload = String(next?.[3]);
        return { rows: [{ id: "job-1" }], rowCount: 1 };
      }
      if (sql.includes("co.verified_at")) {
        return { rows: [{ company_id: null, plan: null, verified_at: null }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }));
    assert.equal(res.status, 202, intent);
    assert.equal(JSON.parse(payload).intent, intent);
  }
});

test("an unknown intent is rejected", async () => {
  resetLimits();
  const res = await handle(post(JSON.stringify({
    text: "시작해 주세요",
    accessMode: "AUTO",
    intent: "nope",
  }), "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeee20"), env(), deps(async (sql) => {
    if (sql.includes("access_tokens")) return { rows: [authRow], rowCount: 1 };
    if (sql.includes("rate_limits")) return { rows: [{ hits: 1 }], rowCount: 1 };
    if (sql.includes("idempotency_keys") && sql.includes("INSERT")) return { rows: [{ id: "idem" }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  }));
  assert.equal(res.status, 400);
  const body = await res.json() as { error: { message: string; details?: { field?: string } } };
  assert.equal(body.error.message, "unsupported intent");
  assert.equal(body.error.details?.field, "intent");
});

test("a company conversation rejects a personal quick-start intent", async () => {
  resetLimits();
  let queued = false;
  const res = await handle(post(JSON.stringify({
    text: "시작해 주세요",
    accessMode: "AUTO",
    intent: "match_posting",
  }), "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeee21"), env(), deps(async (sql) => {
    if (sql.includes("access_tokens")) return { rows: [authRow], rowCount: 1 };
    if (sql.includes("rate_limits")) return { rows: [{ hits: 1 }], rowCount: 1 };
    if (sql.includes("idempotency_keys") && sql.includes("INSERT")) return { rows: [{ id: "idem" }], rowCount: 1 };
    if (sql.includes("idempotency_keys") && sql.includes("UPDATE")) return { rows: [], rowCount: 1 };
    if (sql.includes("chat_jobs")) {
      queued = true;
      return { rows: [{ id: "job-1" }], rowCount: 1 };
    }
    if (sql.includes("co.verified_at")) {
      return { rows: [{ company_id: COMPANY, plan: "PRO", verified_at: NOW.toISOString() }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }));
  assert.equal(res.status, 400);
  assert.equal(queued, false);
});
