import assert from "node:assert/strict";
import { test } from "node:test";

import { handle, type CoreEnv, type Deps } from "../src/handler.ts";
import { resetLimits } from "../src/ratelimit.ts";

const USER = "12345678-1234-5678-1234-567812345678";
const OTHER = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const NOW = new Date("2026-10-18T00:00:00Z");

function env(): CoreEnv {
  return { APP_ENV: "production", MANAGED_AI: "1", MANAGED_GO: "0" };
}

function deps(query: Deps["query"]): Deps {
  return { query, now: () => NOW };
}

type Call = { sql: string; params: unknown[] };

function authed(seen: Call[], employer: boolean, extra?: Deps["query"]): Deps["query"] {
  return async (sql, params = []) => {
    seen.push({ sql, params });
    if (sql.includes("rate_limits")) return { rows: [{ hits: 1 }], rowCount: 1 };
    if (sql.includes("access_tokens")) {
      return {
        rows: [{
          id: USER, display_name: "Ada", locale: "ko", plan: "FREE",
          subscription_status: "NONE", created_at: "2026-01-02T03:04:05Z",
          token_expires_at: "2099-01-01T00:00:00Z",
        }],
        rowCount: 1,
      };
    }
    if (sql.includes("idempotency_keys") && sql.includes("INSERT")) {
      return { rows: [{ id: "11111111-1111-4111-8111-111111111111" }], rowCount: 1 };
    }
    if (sql.includes("idempotency_keys")) return { rows: [], rowCount: 1 };
    if (sql.includes("is_employer")) {
      return { rows: [{ is_employer: employer, display_name: "Ada" }], rowCount: 1 };
    }
    if (extra) return extra(sql, params);
    if (sql.includes("count(*)")) return { rows: [{ total: 0 }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
}

function post(path: string, body: unknown, key: string): Request {
  return new Request("https://core.example" + path, {
    method: "POST",
    headers: {
      authorization: "Bearer secret-token",
      "content-type": "application/json",
      "idempotency-key": key,
    },
    body: JSON.stringify(body),
  });
}

test("posting filters become SQL parameters", async () => {
  resetLimits();
  const seen: Call[] = [];
  const res = await handle(new Request(
    "https://core.example/api/v1/postings?q=" + encodeURIComponent("백엔드")
      + "&category=dev,data&skills=Kotlin,Java&careerYears=1-3,10%2B"
      + "&location=" + encodeURIComponent("서울,원격")
      + "&employmentType=full_time,intern&limit=2",
    { headers: { authorization: "Bearer secret-token" } },
  ), env(), deps(authed(seen, false)));
  assert.equal(res.status, 200);
  const body = await res.json() as { data: unknown[]; page: { total: number; hasMore: boolean } };
  assert.deepEqual(body.data, []);
  assert.equal(body.page.total, 0);
  assert.equal(body.page.hasMore, false);
  const list = seen.find((call) => call.sql.includes("FROM job_postings") && call.sql.includes("ORDER BY"));
  assert.ok(list, "expected a job_postings list query");
  assert.match(list.sql, /closed_at IS NULL/);
  assert.match(list.sql, /job_category = ANY/);
  assert.match(list.sql, /employment_type = ANY/);
  assert.match(list.sql, /jsonb_array_elements_text\(p\.skills\)/);
  const flat = JSON.stringify(list.params);
  for (const value of ["dev", "data", "Kotlin", "Java", "1-3", "10+", "서울", "원격", "full_time", "intern", "백엔드", "ㅂㅇㄷ"]) {
    assert.ok(flat.includes(value), `missing SQL param ${value}`);
  }
});

test("bookmarking the same posting twice is idempotent", async () => {
  resetLimits();
  const seen: Call[] = [];
  let inserts = 0;
  const query = authed(seen, false, async (sql) => {
    if (sql.includes("FROM job_postings") && sql.includes("closed_at IS NULL")) {
      return { rows: [{ id: OTHER }], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO bookmarks")) {
      inserts += 1;
      assert.match(sql, /ON CONFLICT \(user_id, posting_id\) DO NOTHING/);
      return { rows: [], rowCount: 0 };
    }
    return { rows: [], rowCount: 0 };
  });
  const first = await handle(post(`/api/v1/postings/${OTHER}/bookmark`, {}, "11111111-1111-4111-8111-111111111111"), env(), deps(query));
  const second = await handle(post(`/api/v1/postings/${OTHER}/bookmark`, {}, "22222222-2222-4222-8222-222222222222"), env(), deps(query));
  assert.equal(first.status, 204);
  assert.equal(second.status, 204);
  assert.equal(await first.text(), "");
  assert.equal(await second.text(), "");
  assert.equal(inserts, 2);
});

test("a non-employer cannot create a posting", async () => {
  resetLimits();
  const seen: Call[] = [];
  const res = await handle(post("/api/v1/postings", {
    title: "Backend",
    jobCategory: "dev",
    careerMin: 1,
    careerMax: 3,
    location: "서울 강남구",
    employmentType: "full_time",
    description: "Build APIs",
  }, "33333333-3333-4333-8333-333333333333"), env(), deps(authed(seen, false)));
  assert.equal(res.status, 403);
  assert.equal((await res.json() as { error: { code: string } }).error.code, "FORBIDDEN");
  assert.equal(seen.some((call) => call.sql.includes("INSERT INTO job_postings")), false);
});

test("following yourself is rejected", async () => {
  resetLimits();
  const seen: Call[] = [];
  const res = await handle(post(`/api/v1/users/${USER}/follow`, {}, "44444444-4444-4444-8444-444444444444"), env(), deps(authed(seen, false)));
  assert.equal(res.status, 400);
  const body = await res.json() as { error: { code: string; details: { field: string } } };
  assert.equal(body.error.code, "VALIDATION_ERROR");
  assert.equal(body.error.details.field, "userId");
  assert.equal(seen.some((call) => call.sql.includes("INSERT INTO follows")), false);
});

test("an unknown post category is 422", async () => {
  resetLimits();
  const seen: Call[] = [];
  const res = await handle(post("/api/v1/posts", {
    category: "nope",
    title: "hello",
    body: "world",
  }, "55555555-5555-4555-8555-555555555555"), env(), deps(authed(seen, false)));
  assert.equal(res.status, 422);
  const body = await res.json() as { error: { code: string; details: { field: string } } };
  assert.equal(body.error.code, "VALIDATION_ERROR");
  assert.equal(body.error.details.field, "category");
  assert.equal(seen.some((call) => call.sql.includes("INSERT INTO posts")), false);
});
