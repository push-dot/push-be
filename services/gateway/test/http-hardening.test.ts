import assert from "node:assert/strict";
import { test } from "node:test";

import { handle, resetLimits, type Deps, type FrontEnv, type Query } from "../src/handler.ts";
import { requestIdOf } from "../src/http.ts";

const USER = "12345678-1234-5678-1234-567812345678";
const env = { API: { fetch: async () => new Response("{}") }, APP_ENV: "production" } as FrontEnv;

test("a client request id outside [A-Za-z0-9._:-] is replaced, not echoed or forwarded", () => {
  const rid = (value: string) => requestIdOf(new Request("https://x.test/", { headers: { "x-request-id": value } }));
  assert.equal(rid("req_abc-1.2:3"), "req_abc-1.2:3");
  for (const bad of ["a b", "<script>", "a\tb", "x".repeat(129), "ä"]) {
    assert.match(rid(bad), /^req_[0-9a-f-]{36}$/, bad);
  }
});

test("responses vary on Origin whether or not the origin is allowed", async () => {
  for (const origin of ["http://localhost:5173", "https://evil.example"]) {
    const res = await handle(new Request("https://push-be.example/healthz", { headers: { origin } }), env, { query: async () => [] } as Deps);
    assert.match(res.headers.get("vary") || "", /Origin/, origin);
  }
  const preflight = await handle(new Request("https://push-be.example/api/v1/auth/me", {
    method: "OPTIONS", headers: { origin: "http://localhost:5173" },
  }), env, { query: async () => [] } as Deps);
  assert.equal(preflight.headers.get("vary"), "Origin");
});

test("a cursor timestamp is sent to Postgres in canonical ISO form", async () => {
  resetLimits();
  const seen: unknown[][] = [];
  const query: Query = async (sql, params) => {
    if (sql.includes("access_tokens")) {
      seen.push(params);
      return [{ id: USER, created_at: "2026-01-02T03:04:05Z", expires_at: "2099-01-01T00:00:00Z", hits: 1, rows: [] }];
    }
    return [];
  };
  const cursor = encodeURIComponent(btoa(`Sun, 01 Mar 2026 00:00:00 GMT|${USER}`));
  const res = await handle(new Request(`https://push-be.example/api/v1/conversations?cursor=${cursor}`, {
    headers: { authorization: "Bearer tok" },
  }), env, { query, now: () => new Date("2026-10-18T00:00:00Z") } as Deps);
  assert.equal(res.status, 200);
  assert.equal(seen[0][8], "2026-03-01T00:00:00Z");
});
