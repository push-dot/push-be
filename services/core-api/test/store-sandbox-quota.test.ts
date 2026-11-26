import assert from "node:assert/strict";
import { test } from "node:test";

import { handle } from '../src/handler.ts';
import type { CoreEnv, Deps } from '../src/handler.ts';
import { resetLimits } from "../src/ratelimit.ts";
import type { Row } from "../test-support/recorder.ts";

const USER = "12345678-1234-5678-1234-567812345678";
const NOW = new Date("2026-10-22T00:00:00Z");

type Call = { sql: string; params: Array<unknown> };

const authRow = {
  id: USER, display_name: "Ada", locale: "ko", plan: "FREE", subscription_status: "NONE",
  created_at: "2026-01-02T03:04:05Z", token_expires_at: "2099-01-01T00:00:00Z",
};

const queryOf = (seen: Array<Call>, usage: Row | null = null): Deps["query"] => async (sql, params = []) => {
  seen.push({ sql, params });
  if (sql.includes("access_tokens")) {return { rows: [authRow], rowCount: 1 };}
  if (sql.includes("rate_limits")) {return { rows: [{ hits: 1 }], rowCount: 1 };}
  if (sql.includes("idempotency_keys") && sql.includes("INSERT")) {return { rows: [{ id: "idem" }], rowCount: 1 };}
  if (sql.includes("INSERT INTO iap_subscriptions")) {return { rows: [{ user_id: USER }], rowCount: 1 };}
  if (usage && /FROM (sources|upload_images) WHERE user_id/.test(sql) && sql.includes("count(*)")) {return { rows: [usage], rowCount: 1 };}
  if (sql.includes("INSERT INTO ai_jobs")) {return { rows: [{ id: String(params[0]), queue: String(params[2]) }], rowCount: 1 };}
  return { rows: [], rowCount: 0 };
};

const envOf = (extra: Partial<CoreEnv> = {}): CoreEnv => ({
  APP_ENV: "production", PAYMENTS_ENABLED: "1", APPLE_BUNDLE_ID: "com.push.app", IAP_PRODUCT_PRO: "ios.pro", ...extra,
});

const verify = (env: CoreEnv, sandbox: boolean, seen: Array<Call>, key: string) => handle(
  new Request("https://core.example/api/v1/billing/iap/verify", {
    method: "POST",
    headers: { authorization: "Bearer t", "idempotency-key": key, "content-type": "application/json" },
    body: JSON.stringify({ platform: "APP_STORE", productId: "ios.pro", signedTransaction: "jws" }),
  }),
  env,
  {
    query: queryOf(seen), now: () => NOW,
    stores: {
      verifyApple: async () => ({ productId: "ios.pro", originalTransactionId: "tx-1", expiresAt: "2026-11-21T00:00:00.000Z", consumable: false, sandbox }),
      googleLinkedToken: async () => undefined,
      verifyGoogle: async () => { throw new Error("unused"); },
      decodeAppleNotification: async () => { throw new Error("unused"); },
      decodeGoogleNotification: async () => { throw new Error("unused"); },
    },
  },
);

test("production refuses a sandbox purchase unless the user is allowlisted", async () => {
  resetLimits();
  const refused: Array<Call> = [];
  const res = await verify(envOf(), true, refused, "99999999-9999-4999-8999-000000000001");
  assert.equal(res.status, 400);
  assert.equal(refused.some((c) => c.sql.includes("INSERT INTO iap_subscriptions") || c.sql.includes("UPDATE users")), false);
  const other: Array<Call> = [];
  assert.equal((await verify(envOf({ STORE_SANDBOX_USER_IDS: "someone-else" }), true, other, "99999999-9999-4999-8999-000000000002")).status, 400);
  const allowed: Array<Call> = [];
  assert.equal((await verify(envOf({ STORE_SANDBOX_USER_IDS: `x, ${USER}` }), true, allowed, "99999999-9999-4999-8999-000000000003")).status, 200);
  assert.equal(allowed.some((c) => c.sql.includes("INSERT INTO iap_subscriptions")), true);
  const live: Array<Call> = [];
  assert.equal((await verify(envOf(), false, live, "99999999-9999-4999-8999-000000000004")).status, 200);
});

test("development accepts sandbox purchases", async () => {
  resetLimits();
  const res = await verify(envOf({ APP_ENV: "development" }), true, [], "99999999-9999-4999-8999-000000000005");
  assert.equal(res.status, 200);
});

const sourceUpload = () => {
  const form = new FormData();
  form.set("kind", "RESUME");
  form.set("file", new File(["hello"], "cv.txt", { type: "text/plain" }));
  return new Request("https://core.example/api/v1/sources", {
    method: "POST", headers: { authorization: "Bearer t", "idempotency-key": "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1" }, body: form,
  });
};

const imageUpload = () => {
  const form = new FormData();
  form.set("file", new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0])], "a.jpg", { type: "image/jpeg" }));
  return new Request("https://core.example/api/v1/uploads/images", {
    method: "POST", headers: { authorization: "Bearer t", "idempotency-key": "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee2" }, body: form,
  });
};

const quotaCases: Array<[string, () => Request, string, Row]> = [
  ["sources by count", sourceUpload, "INSERT INTO sources", { files: 100, bytes: 0 }],
  ["sources by bytes", sourceUpload, "INSERT INTO sources", { files: 1, bytes: 300 << 20 }],
  ["images by count", imageUpload, "INSERT INTO upload_images", { files: 300, bytes: 0 }],
  ["images by bytes", imageUpload, "INSERT INTO upload_images", { files: 1, bytes: 200 << 20 }],
];

for (const [name, request, insert, usage] of quotaCases) {
  test(`upload over quota is refused with 413: ${name}`, async () => {
    resetLimits();
    const seen: Array<Call> = [];
    const res = await handle(request(), { APP_ENV: "production" }, { query: queryOf(seen, usage), now: () => NOW });
    assert.equal(res.status, 413);
    assert.equal(seen.some((c) => c.sql.includes(insert) || c.sql.includes("INSERT INTO ai_jobs")), false);
  });
}

test("upload under quota still succeeds", async () => {
  resetLimits();
  const seen: Array<Call> = [];
  const res = await handle(imageUpload(), { APP_ENV: "production" }, { query: queryOf(seen, { files: 5, bytes: 1000 }), now: () => NOW });
  assert.equal(res.status, 201);
});
