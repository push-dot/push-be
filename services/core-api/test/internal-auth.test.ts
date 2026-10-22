import assert from "node:assert/strict";
import { test } from "node:test";

import { actAsAllowed } from "../src/internal-auth.ts";
import { handle, type CoreEnv, type Deps } from "../src/handler.ts";
import { resetLimits } from "../src/ratelimit.ts";

const USER = "12345678-1234-5678-1234-567812345678";
const COMPANY = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OTHER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const NOW = "2026-10-21T00:00:00.000Z";
const SECRET = "internal-secret";

const env = (): CoreEnv => ({ APP_ENV: "production", INTERNAL_API_SECRET: SECRET });
const deps = (query: Deps["query"]): Deps => ({ query, now: () => new Date(NOW) });
const empty = { rows: [] as Record<string, unknown>[], rowCount: 0 };

const userRow = () => ({
  id: USER, display_name: "Ada", locale: "ko", plan: "PRO", subscription_status: "NONE",
  stripe_customer_id: null, period_ends_at: null, created_at: NOW, is_employer: false,
  email: "ada@push.app", provider: "email", company_id: COMPANY, company_role: "member",
});

const queryFor = (memberOf: string | null) => async (sql: string, params: unknown[] = []) => {
  if (sql.includes("rate_limits")) return { rows: [{ hits: 1 }], rowCount: 1 };
  if (sql.includes("SELECT 1") && sql.includes("company_members")) {
    return memberOf != null && params[0] === USER && params[1] === memberOf ? { rows: [{ ok: 1 }], rowCount: 1 } : empty;
  }
  if (sql.includes("FROM users") && sql.includes("display_name")) return { rows: [userRow()], rowCount: 1 };
  if (sql.includes("count(*)")) return { rows: [{ total: 0 }], rowCount: 1 };
  return empty;
};

const bookmarks = (headers: Record<string, string>): Request => new Request("https://core.example/api/v1/me/bookmarks", { headers });

test("act-as with the internal secret reads bookmarks", async () => {
  resetLimits();
  const res = await handle(bookmarks({
    "x-push-internal-secret": SECRET,
    "x-push-act-as": USER,
  }), env(), deps(queryFor(null)));
  assert.equal(res.status, 200);
  const body = await res.json() as { data: unknown[] };
  assert.deepEqual(body.data, []);
});

test("a wrong internal secret is 401 and a non-member company is 403", async () => {
  resetLimits();
  const wrong = await handle(bookmarks({
    "x-push-internal-secret": "nope",
    "x-push-act-as": USER,
  }), env(), deps(queryFor(COMPANY)));
  assert.equal(wrong.status, 401);
  assert.equal((await wrong.json() as { error: { code: string } }).error.code, "UNAUTHORIZED");

  resetLimits();
  const missing = await handle(bookmarks({ "x-push-act-as": USER }), env(), deps(queryFor(COMPANY)));
  assert.equal(missing.status, 401);

  resetLimits();
  const other = await handle(bookmarks({
    "x-push-internal-secret": SECRET,
    "x-push-act-as": USER,
    "x-push-company": OTHER,
  }), env(), deps(queryFor(COMPANY)));
  assert.equal(other.status, 403);
  assert.equal((await other.json() as { error: { code: string } }).error.code, "FORBIDDEN");

  resetLimits();
  const none = await handle(bookmarks({
    "x-push-internal-secret": SECRET,
    "x-push-act-as": USER,
    "x-push-company": COMPANY,
  }), env(), deps(queryFor(null)));
  assert.equal(none.status, 403);
});

test("an unknown act-as user is 401 and a secret without act-as still needs a bearer", async () => {
  resetLimits();
  const unknown = await handle(bookmarks({
    "x-push-internal-secret": SECRET,
    "x-push-act-as": OTHER,
  }), env(), deps(async (sql) => {
    if (sql.includes("FROM users") && sql.includes("display_name")) return empty;
    if (sql.includes("rate_limits")) return { rows: [{ hits: 1 }], rowCount: 1 };
    return empty;
  }));
  assert.equal(unknown.status, 401);

  resetLimits();
  const secretOnly = await handle(bookmarks({ "x-push-internal-secret": SECRET }), env(), deps(async () => empty));
  assert.equal(secretOnly.status, 401);
  assert.equal((await secretOnly.json() as { error: { code: string } }).error.code, "UNAUTHENTICATED");
});

test("act-as cannot reach routes the ai tools never use", async () => {
  for (const [method, path] of [
    ["DELETE", "/api/v1/me"],
    ["POST", "/api/v1/billing/checkout"],
    ["PUT", "/api/v1/ai/keys/OPENAI"],
    ["DELETE", `/api/v1/companies/me/members/${OTHER}`],
    ["PATCH", "/api/v1/companies/me"],
    ["GET", "/api/v1/me/bookmarks/../../ai/keys"],
  ] as const) {
    resetLimits();
    const res = await handle(new Request(`https://core.example${path}`, {
      method,
      headers: { "x-push-internal-secret": SECRET, "x-push-act-as": USER },
    }), env(), deps(queryFor(null)));
    assert.equal(res.status, 403, `${method} ${path}`);
  }
});

test("act-as may apply chat edits to a document but not touch its other writes", () => {
  const doc = "12121212-1212-4212-8212-121212121212";
  assert.equal(actAsAllowed("POST", `/api/v1/documents/${doc}/edits`), true);
  assert.equal(actAsAllowed("GET", `/api/v1/documents/${doc}/edits`), false);
  for (const sub of ["finalize", "archive", "versions", "exports"]) {
    assert.equal(actAsAllowed("POST", `/api/v1/documents/${doc}/${sub}`), false, sub);
  }
});
