import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { base64ToBytes, decryptAes, encryptAes, masterKey, verifyPkce } from "../src/crypto.ts";
import { handle, type CoreEnv, type Deps } from "../src/handler.ts";
import { resetLimits } from "../src/ratelimit.ts";
import { verifyStripe } from "../src/routes/billing.ts";
import { decodeCursor, encodeCursor, formatJsonTimestamp } from "../src/time.ts";
import { uuid5Url } from "../src/http.ts";

const USER = "12345678-1234-5678-1234-567812345678";
const NOW = new Date("2026-10-18T00:00:00Z");
const VECTORS = JSON.parse(readFileSync(new URL("../../../packages/contracts/parity-vectors.json", import.meta.url), "utf8")) as {
  timestamp: { input: string; json: string };
  userMessageId: { jobId: string; id: string };
  pkce: { verifier: string; challenge: string };
  aes: { master: string; userId: string; provider: string; plaintext: string; nonce: string; ciphertext: string };
  stripe: { payload: string; secret: string; timestamp: number; header: string };
};

function env(extra: Partial<CoreEnv> = {}): CoreEnv {
  return {
    APP_ENV: "production",
    MANAGED_AI: "1",
    MANAGED_GO: "0",
    BYOK_MASTER_KEY: "test-master-key",
    STRIPE_SECRET_KEY: "sk_test",
    STRIPE_PRICE_PRO: "price_pro",
    ...extra,
  };
}

function deps(query: Deps["query"], extra: Partial<Deps> = {}): Deps {
  return { query, now: () => NOW, ...extra };
}

test("timestamps, cursors, uuid5, pkce, AES-GCM, and Stripe match Python", async () => {
  assert.equal(formatJsonTimestamp(VECTORS.timestamp.input), VECTORS.timestamp.json);
  const encoded = encodeCursor(VECTORS.timestamp.input, VECTORS.aes.userId);
  assert.deepEqual(decodeCursor(encoded), {
    createdAt: VECTORS.timestamp.json,
    id: VECTORS.aes.userId,
  });
  assert.equal(await uuid5Url("push:chat:" + VECTORS.userMessageId.jobId + ":user"), VECTORS.userMessageId.id);
  assert.equal(await verifyPkce(VECTORS.pkce.verifier, VECTORS.pkce.challenge), true);
  const key = await masterKey(VECTORS.aes.master);
  const nonce = base64ToBytes(VECTORS.aes.nonce);
  const opened = await decryptAes(key, base64ToBytes(VECTORS.aes.ciphertext), nonce, VECTORS.aes.userId, VECTORS.aes.provider);
  assert.equal(opened, VECTORS.aes.plaintext);
  const sealed = await encryptAes(key, VECTORS.aes.plaintext, VECTORS.aes.userId, VECTORS.aes.provider, nonce);
  let bin = "";
  for (const b of sealed.ciphertext) bin += String.fromCharCode(b);
  assert.equal(btoa(bin), VECTORS.aes.ciphertext);
  await verifyStripe(
    new TextEncoder().encode(VECTORS.stripe.payload),
    VECTORS.stripe.header,
    VECTORS.stripe.secret,
    new Date(VECTORS.stripe.timestamp * 1000),
  );
});

test("auth and idempotency errors match the Python middleware", async () => {
  resetLimits();
  const query: Deps["query"] = async (sql) => {
    if (sql.includes("rate_limits")) return { rows: [{ hits: 1 }], rowCount: 1 };
    if (sql.includes("refresh_tokens")) return { rows: [], rowCount: 0 };
    return { rows: [], rowCount: 0 };
  };
  const missing = await handle(new Request("https://core.example/api/v1/conversations", {
    method: "POST",
    body: "{}",
  }), env(), deps(query));
  assert.equal(missing.status, 401);
  assert.equal((await missing.json() as { error: { code: string; message: string } }).error.message, "missing bearer token");

  const refresh = await handle(new Request("https://core.example/api/v1/auth/refresh", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: '{"refreshToken":"nope"}',
  }), env(), deps(query));
  assert.equal(refresh.status, 401);
  assert.equal((await refresh.json() as { error: { message: string } }).error.message, "invalid refresh token");

  const key = await handle(new Request("https://core.example/api/v1/conversations", {
    method: "POST",
    headers: { authorization: "Bearer secret-token", "content-type": "application/json" },
    body: '{"title":"hi"}',
  }), env(), deps(async (sql) => {
    if (sql.includes("access_tokens")) {
      return { rows: [{ id: USER, display_name: "Ada", locale: "ko", plan: "PRO", created_at: "2026-01-02T03:04:05Z", token_expires_at: "2099-01-01T00:00:00Z" }], rowCount: 1 };
    }
    if (sql.includes("rate_limits")) return { rows: [{ hits: 1 }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  }));
  assert.equal(key.status, 400);
  const body = await key.json() as { error: { code: string; details: { field: string } } };
  assert.equal(body.error.code, "VALIDATION_ERROR");
  assert.equal(body.error.details.field, "Idempotency-Key");
});

test("an exhausted free managed chat is rejected and a paid chat is queued", async () => {
  resetLimits();
  const sqls: string[] = [];
  let scheduled = "";
  const query: Deps["query"] = async (sql) => {
    sqls.push(sql);
    if (sql.includes("access_tokens")) {
      return { rows: [{ id: USER, display_name: "Ada", locale: "ko", plan: "FREE", created_at: "2026-01-02T03:04:05Z", token_expires_at: "2099-01-01T00:00:00Z" }], rowCount: 1 };
    }
    if (sql.includes("rate_limits")) return { rows: [{ hits: 1 }], rowCount: 1 };
    if (sql.includes("FROM users")) return { rows: [{ plan: "FREE" }], rowCount: 1 };
    if (sql.includes("ai_usage")) return { rows: [{ spent: 1_800_000 }], rowCount: 1 };
    if (sql.includes("idempotency_keys") && sql.startsWith("INSERT")) return { rows: [{ id: "idem" }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
  const body = JSON.stringify({
    text: "hello",
    accessMode: "SUGGEST",
    ai: { provider: "OPENAI", model: "deepseek/deepseek-v4.1-flash", effort: "LOW" },
  });
  const denied = await handle(new Request("https://core.example/api/v1/conversations/" + USER + "/messages", {
    method: "POST",
    headers: {
      authorization: "Bearer secret-token",
      "content-type": "application/json",
      "idempotency-key": "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    },
    body,
  }), env(), deps(query));
  assert.equal(denied.status, 403);
  assert.equal((await denied.json() as { error: { code: string } }).error.code, "FEATURE_DISABLED");
  assert.equal(sqls.some((sql) => sql.includes("chat_jobs")), false);

  const api = {
    async fetch(request: Request) {
      scheduled = await request.text();
      return new Response('{"data":{"scheduled":true}}', { status: 200 });
    },
  };
  const open: Deps["query"] = async (sql) => {
    if (sql.includes("access_tokens")) {
      return { rows: [{ id: USER, display_name: "Ada", locale: "ko", plan: "FREE", created_at: "2026-01-02T03:04:05Z", token_expires_at: "2099-01-01T00:00:00Z" }], rowCount: 1 };
    }
    if (sql.includes("rate_limits")) return { rows: [{ hits: 1 }], rowCount: 1 };
    if (sql.includes("FROM users")) return { rows: [{ plan: null }], rowCount: 1 };
    if (sql.includes("ai_usage")) return { rows: [{ spent: 0 }], rowCount: 1 };
    if (sql.includes("idempotency_keys") && sql.includes("INSERT")) return { rows: [{ id: "idem-free" }], rowCount: 1 };
    if (sql.includes("chat_jobs")) return { rows: [{ id: "job-free" }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
  const opened = await handle(new Request("https://core.example/api/v1/conversations/" + USER + "/messages", {
    method: "POST",
    headers: {
      authorization: "Bearer secret-token",
      "content-type": "application/json",
      "idempotency-key": "cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    },
    body,
  }), env({ API: api }), deps(open));
  assert.equal(opened.status, 202);

  const paid: Deps["query"] = async (sql) => {
    sqls.push(sql);
    if (sql.includes("access_tokens")) {
      return { rows: [{ id: USER, display_name: "Ada", locale: "ko", plan: "PRO", created_at: "2026-01-02T03:04:05Z", token_expires_at: "2099-01-01T00:00:00Z" }], rowCount: 1 };
    }
    if (sql.includes("rate_limits")) return { rows: [{ hits: 1 }], rowCount: 1 };
    if (sql.includes("FROM users")) return { rows: [{ plan: "PRO" }], rowCount: 1 };
    if (sql.includes("ai_usage")) return { rows: [{ spent: 0 }], rowCount: 1 };
    if (sql.includes("idempotency_keys") && sql.includes("INSERT")) return { rows: [{ id: "idem-2" }], rowCount: 1 };
    if (sql.includes("chat_jobs")) return { rows: [{ id: "job-1" }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
  const queued = await handle(new Request("https://core.example/api/v1/conversations/" + USER + "/messages", {
    method: "POST",
    headers: {
      authorization: "Bearer secret-token",
      "content-type": "application/json",
      "idempotency-key": "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    },
    body,
  }), env({ API: api }), deps(paid));
  assert.equal(queued.status, 202);
  const op = await queued.json() as { data: { id: string; status: string; type: string; result: { value: { jobId: string } } } };
  assert.equal(op.data.status, "QUEUED");
  assert.equal(op.data.type, "CHAT_MESSAGE");
  assert.equal(op.data.result.value.jobId, op.data.id);
  assert.match(scheduled, /jobId/);
  const go = await handle(new Request("https://core.example/api/v1/conversations/" + USER + "/messages", {
    method: "POST",
    headers: {
      authorization: "Bearer secret-token",
      "content-type": "application/json",
      "idempotency-key": "dddddddd-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    },
    body: JSON.stringify({
      text: "hello",
      accessMode: "SUGGEST",
      ai: { provider: "OPENAI", model: "opencode-go/deepseek-v4.1-flash", effort: "LOW" },
    }),
  }), env({ API: api }), deps(paid));
  assert.equal(go.status, 202);
});

test("a conversation patch reports the current revision", async () => {
  resetLimits();
  const query: Deps["query"] = async (sql) => {
    if (sql.includes("access_tokens")) {
      return { rows: [{ id: USER, display_name: "Ada", locale: "ko", plan: "PRO", created_at: "2026-01-02T03:04:05.172000Z", token_expires_at: "2099-01-01T00:00:00Z" }], rowCount: 1 };
    }
    if (sql.includes("rate_limits")) return { rows: [{ hits: 1 }], rowCount: 1 };
    if (sql.startsWith("SELECT") && sql.includes("FROM conversations")) {
      return { rows: [{ id: USER, revision: 4, application_id: null, title: "old", pinned: false, archived: false, created_at: "2026-01-02T03:04:05.172000Z" }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  const res = await handle(new Request("https://core.example/api/v1/conversations/" + USER, {
    method: "PATCH",
    headers: {
      authorization: "Bearer secret-token",
      "content-type": "application/json",
      "idempotency-key": "cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    },
    body: '{"expectedRevision":1,"title":"new"}',
  }), env(), deps(query));
  assert.equal(res.status, 409);
  const body = await res.json() as { error: { code: string; details: { currentRevision: number } } };
  assert.equal(body.error.code, "REVISION_CONFLICT");
  assert.equal(body.error.details.currentRevision, 4);
});

test("checkout rejects an unknown plan and an empty webhook body", async () => {
  resetLimits();
  const authed: Deps["query"] = async (sql) => {
    if (sql.includes("access_tokens")) {
      return { rows: [{ id: USER, display_name: "Ada", locale: "ko", plan: "FREE", subscription_status: "NONE", created_at: "2026-01-02T03:04:05Z", token_expires_at: "2099-01-01T00:00:00Z" }], rowCount: 1 };
    }
    if (sql.includes("rate_limits")) return { rows: [{ hits: 1 }], rowCount: 1 };
    if (sql.includes("idempotency_keys") && sql.includes("INSERT")) return { rows: [{ id: "idem" }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
  const bad = await handle(new Request("https://core.example/api/v1/billing/checkout", {
    method: "POST",
    headers: {
      authorization: "Bearer secret-token",
      "content-type": "application/json",
      "idempotency-key": "dddddddd-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    },
    body: '{"planId":"FREE"}',
  }), env(), deps(authed));
  assert.equal(bad.status, 400);
  assert.equal((await bad.json() as { error: { details: { field: string } } }).error.details.field, "planId");

  const hook = await handle(new Request("https://core.example/api/v1/billing/webhook", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "",
  }), env(), deps(async (sql) => {
    if (sql.includes("rate_limits")) return { rows: [{ hits: 1 }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  }));
  assert.equal(hook.status, 400);
  assert.equal((await hook.json() as { error: { message: string } }).error.message, "unreadable body");
});
