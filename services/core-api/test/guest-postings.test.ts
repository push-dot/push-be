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

test("locations group by city only when asked and reject other levels", async () => {
  const city = await run("/api/v1/postings/locations?level=city");
  assert.equal(city.res.status, 200);
  const grouped = city.calls.find((call) => call.sql.includes("regexp_split_to_array"));
  assert.ok(grouped);
  assert.match(grouped.sql, /GROUP BY 1 ORDER BY 2 DESC, 1 ASC/);

  const district = await run("/api/v1/postings/locations?level=district");
  assert.equal(district.res.status, 200);
  assert.ok(district.calls.find((call) => call.sql.includes("GROUP BY p.location ORDER BY count DESC, p.location ASC")));

  const bad = await run("/api/v1/postings/locations?level=country");
  assert.equal(bad.res.status, 400);
  assert.equal(await codeOf(bad.res), "VALIDATION_ERROR");
});

test("city locations return summed counts from the grouped rows", async () => {
  resetLimits();
  const query: Deps["query"] = async (sql) => {
    if (sql.includes("rate_limits")) return { rows: [{ hits: 1 }], rowCount: 1 };
    if (sql.includes("regexp_split_to_array")) return { rows: [{ location: "서울", count: 5 }, { location: "경기", count: 2 }], rowCount: 2 };
    return { rows: [], rowCount: 0 };
  };
  const res = await handle(new Request("https://core.example/api/v1/postings/locations?level=city"), env(), { query, now: () => new Date("2026-10-21T00:00:00Z") });
  assert.deepEqual((await res.json() as { data: unknown }).data, [{ location: "서울", count: 5 }, { location: "경기", count: 2 }]);
});

test("employmentType facet lists every type with zeros and ignores its own filter", async () => {
  resetLimits();
  const seen: Call[] = [];
  const query: Deps["query"] = async (sql, params = []) => {
    seen.push({ sql, params });
    if (sql.includes("rate_limits")) return { rows: [{ hits: 1 }], rowCount: 1 };
    if (sql.includes("GROUP BY p.employment_type")) return { rows: [{ id: "intern", count: 4 }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
  const res = await handle(new Request("https://core.example/api/v1/postings/facets?employmentType=full_time&category=dev"), env(), { query, now: () => new Date("2026-10-21T00:00:00Z") });
  assert.equal(res.status, 200);
  const body = await res.json() as { data: { employmentType: { id: string; count: number }[] } };
  assert.deepEqual(body.data.employmentType, [
    { id: "full_time", count: 0 }, { id: "contract", count: 0 }, { id: "intern", count: 4 },
    { id: "freelance", count: 0 }, { id: "dispatch", count: 0 },
  ]);
  const own = seen.find((call) => call.sql.includes("GROUP BY p.employment_type"));
  assert.ok(own);
  assert.doesNotMatch(own.sql, /p\.employment_type = ANY/);
  assert.match(own.sql, /p\.job_category = ANY/);
  const category = seen.find((call) => call.sql.includes("GROUP BY p.job_category"));
  assert.ok(category);
  assert.match(category.sql, /p\.employment_type = ANY/);
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


test("guest skill search is public and binds the query and limit", async () => {
  const { res, calls } = await run("/api/v1/skills?q=%20Kot%20&limit=5");
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json() as { data: unknown[] }).data, []);
  const call = calls.find((c) => c.sql.includes("jsonb_array_elements_text"))!;
  assert.deepEqual(call.params, [NIL, "Kot", 5]);
  assert.match(call.sql, /strpos\(lower\(sk\), lower\(\$2::text\)\) > 0/);
});

test("skill search defaults to 20 skills and rejects a bad limit or a long query", async () => {
  const { calls } = await run("/api/v1/skills");
  assert.deepEqual(calls.find((c) => c.sql.includes("jsonb_array_elements_text"))!.params, [NIL, "", 20]);
  for (const path of ["/api/v1/skills?limit=0", "/api/v1/skills?limit=51", "/api/v1/skills?limit=x", "/api/v1/skills?q=" + "a".repeat(41)]) {
    const { res } = await run(path);
    assert.equal(res.status, 400, path);
    assert.equal(await codeOf(res), "VALIDATION_ERROR");
  }
});

test("skill search maps rows to name and postingCount", async () => {
  resetLimits();
  const query: Deps["query"] = async (sql) => {
    if (sql.includes("rate_limits")) return { rows: [{ hits: 1 }], rowCount: 1 };
    if (sql.includes("jsonb_array_elements_text")) return { rows: [{ name: "Kotlin", posting_count: 12 }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
  const res = await handle(new Request("https://core.example/api/v1/skills?q=kot"), env(), { query, now: () => new Date("2026-10-21T00:00:00Z") });
  assert.deepEqual((await res.json() as { data: unknown }).data, [{ name: "Kotlin", postingCount: 12 }]);
});
