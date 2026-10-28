import assert from "node:assert/strict";
import { test } from "node:test";
import { recorder } from "../test-support/recorder.ts";

import { handle, type CoreEnv, type Deps } from "../src/handler.ts";
import { resetLimits } from "../src/ratelimit.ts";

const NIL = "00000000-0000-0000-0000-000000000000";
const POSTING = "11111111-1111-4111-8111-111111111111";

const env = (): CoreEnv => ({ APP_ENV: "production", MANAGED_AI: "1", MANAGED_GO: "0" });

type Call = { sql: string; params: unknown[] };

const run = async (path: string, init?: RequestInit) => {
  resetLimits();
  const calls: Call[] = [];
  const query: Deps["query"] = async (sql, params = []) => {
    calls.push({ sql, params });
    if (sql.includes("rate_limits")) return { rows: [{ hits: 1 }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
  const res = await handle(new Request("https://core.example" + path, init), env(), {
    query,
    now: () => new Date("2026-10-21T00:00:00Z"),
  });
  return { res, calls };
};

const codeOf = async (res: Response) => (await res.json() as { error: { code: string } }).error.code;

test("guest listing binds the nil user", async () => {
  const { res, calls } = await run("/api/v1/postings");
  assert.equal(res.status, 200);
  assert.equal(calls.some((call) => call.params.includes(NIL)), true);
  assert.equal(calls.some((call) => call.sql.includes("rate_limits") && String(call.params[0]).startsWith("ip:")), true);
});

test("guest locations are public", async () => {
  const { res, calls } = await run("/api/v1/postings/locations");
  assert.equal(res.status, 200);
  const locations = calls.find((call) => call.sql.includes("GROUP BY p.location"));
  assert.ok(locations);
  assert.match(locations.sql, /\$1::uuid/);
  assert.equal(locations.params[0], NIL);
});

test("guest posting detail is not unauthenticated", async () => {
  const { res, calls } = await run(`/api/v1/postings/${POSTING}`);
  assert.notEqual(res.status, 401);
  assert.equal(res.status === 200 || res.status === 404, true);
  assert.equal(calls.some((call) => call.params.includes(NIL)), true);
});

test("guest posting search is public", async () => {
  const { res } = await run("/api/v1/search?q=kotlin&type=postings");
  assert.equal(res.status, 200);
});

test("guest search without a type stays on postings", async () => {
  const { res } = await run("/api/v1/search?q=kotlin");
  assert.equal(res.status, 200);
});

test("guest people search is unauthenticated", async () => {
  const { res } = await run("/api/v1/search?q=kotlin&type=people");
  assert.equal(res.status, 401);
  assert.equal(await codeOf(res), "UNAUTHENTICATED");
});

test("guest posts search is unauthenticated", async () => {
  const { res } = await run("/api/v1/search?q=kotlin&type=posts");
  assert.equal(res.status, 401);
  assert.equal(await codeOf(res), "UNAUTHENTICATED");
});

test("guest cannot create a posting", async () => {
  const { res } = await run("/api/v1/postings", { method: "POST" });
  assert.equal(res.status, 401);
  assert.equal(await codeOf(res), "UNAUTHENTICATED");
});

test("a bearer on the board is not replaced by the nil user", async () => {
  const { res, calls } = await run("/api/v1/postings", { headers: { authorization: "Bearer secret-token" } });
  assert.equal(res.status, 401);
  assert.equal(calls.some((call) => call.sql.includes("job_postings") && call.params.includes(NIL)), false);
  assert.equal(calls.some((call) => call.sql.includes("access_tokens")), true);
});

{
const NIL = "00000000-0000-0000-0000-000000000000";
const POSTING = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-10-21T00:00:00Z");
const ENV = { APP_ENV: "production" };
const openPosting = { id: POSTING, company: "Acme", title: "BE", created_at: "2026-10-01T00:00:00Z", revision: 1, status: "OPEN" };

test("a guest can open a public posting without writing a view row for the nil user", async () => {
  const { handle } = await import("../src/handler.ts");
  const { calls, query } = recorder((sql) => {
    if (sql.includes("INSERT INTO posting_views")) throw Object.assign(new Error("insert or update on table \"posting_views\" violates foreign key constraint"), { code: "23503" });
    if (sql.includes("FROM job_postings p WHERE p.id = $1")) return [openPosting];
    return null;
  });
  const res = await handle(new Request(`https://core.example/api/v1/postings/${POSTING}`), ENV, { query, now: () => NOW });
  assert.equal(res.status, 200);
  assert.equal(calls.some((c) => c.sql.includes("posting_views") && c.params.includes(NIL)), false);
});
}

