import assert from "node:assert/strict";
import { test } from "node:test";

import { USER, recorder } from "../test-support/recorder.ts";

const NOW = new Date("2026-10-21T00:00:00Z");
const ENV = { APP_ENV: "production" };

test("google sync fetches gmail in parallel batches and writes every row in one statement", async () => {
  const { handle } = await import("../src/handler.ts");
  const { bytesToBase64, encryptAes, masterKey } = await import("../src/crypto.ts");
  const master = "parity-master-key";
  const sealed = await encryptAes(await masterKey(master), "access-token", USER, "google");
  const ids = Array.from({ length: 25 }, (_, i) => "m" + i);
  let inFlight = 0;
  let peak = 0;
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("/messages?")) return Response.json({ messages: ids.map((id) => ({ id })), historyId: "9" });
    if (url.includes("/messages/")) {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      const id = decodeURIComponent(url.split("/messages/")[1].split("?")[0]);
      return Response.json({ id, threadId: "t", snippet: "s", internalDate: "1761100000000", payload: { headers: [] } });
    }
    if (url.includes("/calendar/")) {
      return Response.json({ nextSyncToken: "s2", items: [
        { id: "e1", status: "confirmed", summary: "call", start: { dateTime: "2026-11-05T02:00:00Z" }, end: { dateTime: "2026-11-05T03:00:00Z" } },
        { id: "e2", status: "cancelled" },
      ] });
    }
    return new Response("{}", { status: 404 });
  };
  const { calls, query } = recorder((sql) => {
    if (sql.includes("FROM google_integrations")) {
      return [{
        user_id: USER, access_ciphertext: bytesToBase64(sealed.ciphertext), access_nonce: bytesToBase64(sealed.nonce),
        refresh_ciphertext: null, refresh_nonce: null, token_expires_at: null, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z",
        scopes: ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/calendar.events"],
      }];
    }
    return null;
  });
  const res = await handle(new Request("https://core.example/api/v1/integrations/google/sync", {
    method: "POST", headers: { authorization: "Bearer t", "idempotency-key": "00000000-0000-4000-8000-000000000002" },
  }), { ...ENV, GOOGLE_CLIENT_ID: "c", GOOGLE_CLIENT_SECRET: "s", TOKEN_ENCRYPTION_KEY: master, GOOGLE_GMAIL_BETA_ENABLED: "true" }, { query, now: () => NOW, fetch: fetchImpl });
  assert.equal(res.status, 202);
  assert.ok(peak > 1 && peak <= 10, `peak concurrency ${peak}`);
  const writes = calls.filter((c) => c.sql.includes("INSERT INTO google_messages"));
  assert.equal(writes.length, 1);
  assert.deepEqual(JSON.parse(String(writes[0].params[2])).map((m: { external_id: string }) => m.external_id), ids);
  assert.deepEqual(JSON.parse(String(writes[0].params[3])), ["e2"]);
  assert.deepEqual(JSON.parse(String(writes[0].params[4])).map((e: { external_id: string }) => e.external_id), ["e1"]);
});
