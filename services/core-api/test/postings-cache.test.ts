import assert from "node:assert/strict";
import { test } from "node:test";

import { handle, type CoreEnv, type Deps } from "../src/handler.ts";
import { resetLimits } from "../src/ratelimit.ts";
import { ReadCache, READ_CACHE_TTL_MS } from "../src/read-cache.ts";

const ADA = "12345678-1234-5678-1234-567812345678";
const BOB = "87654321-4321-5678-1234-567812345678";
const COMPANY = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const POSTING = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const START = Date.parse("2026-10-21T00:00:00.000Z");

type Call = { sql: string; params: unknown[] };

const env = (): CoreEnv => ({ APP_ENV: "production", MANAGED_AI: "1" });

const empty = { rows: [] as Record<string, unknown>[], rowCount: 0 };

const world = () => {
  const seen: Call[] = [];
  const clock = { ms: START };
  const cache = new ReadCache();
  const hashes: string[] = [];
  let total = 7;
  const bookmarkedBy = new Set([ADA]);
  const query: Deps["query"] = async (sql, params = []) => {
    seen.push({ sql, params });
    if (sql.includes("rate_limits")) return { rows: [{ hits: 1 }], rowCount: 1 };
    if (sql.includes("access_tokens")) {
      if (!hashes.includes(String(params[0]))) hashes.push(String(params[0]));
      const user = hashes.indexOf(String(params[0])) === 1 ? BOB : ADA;
      return {
        rows: [{
          id: user, display_name: "U", locale: "ko", plan: "FREE", subscription_status: "NONE",
          created_at: "2026-10-01T00:00:00Z", token_expires_at: "2099-01-01T00:00:00Z", is_employer: false,
        }],
        rowCount: 1,
      };
    }
    if (sql.includes("company_members") && sql.includes("verified_at")) {
      return { rows: [{ id: COMPANY, name: "Acme", verified_at: "2026-10-01T00:00:00Z" }], rowCount: 1 };
    }
    if (sql.includes("UPDATE job_postings")) {
      return { rows: [{ id: POSTING, revision: 3, closed_at: "2026-10-21T00:00:00Z", company: "Acme", title: "T" }], rowCount: 1 };
    }
    if (sql.includes("FROM job_postings WHERE id = $1 AND company_id")) {
      return { rows: [{ id: POSTING, revision: 2, closed_at: null }], rowCount: 1 };
    }
    if (sql.includes("jsonb_array_elements_text(COALESCE(p.skills")) {
      return { rows: [{ id: "Go", count: 4 }, { id: "SQL", count: 2 }], rowCount: 2 };
    }
    if (sql.includes("GROUP BY p.job_category")) return { rows: [{ id: "dev", count: 5 }], rowCount: 1 };
    if (sql.includes("GROUP BY p.employment_type")) return { rows: [{ id: "full_time", count: 5 }], rowCount: 1 };
    if (sql.includes("GROUP BY p.location")) return { rows: [{ id: "서울 강남구", count: 5 }], rowCount: 1 };
    if (sql.includes("career_0")) return { rows: [{ career_0: 1, career_1_3: 2, career_4_6: 0, career_7_9: 0, career_10: 0 }], rowCount: 1 };
    if (sql.includes("count(*)::int AS total")) return { rows: [{ total }], rowCount: 1 };
    if (sql.includes("FROM search_queries")) return { rows: [{ term: "go", count: 3 }], rowCount: 1 };
    if (sql.includes("ORDER BY") && sql.includes("FROM job_postings")) {
      const user = String(params[0]);
      return {
        rows: [{ id: POSTING, company: "Acme", title: "T", created_at: "2026-10-20T00:00:00Z", bookmarked: bookmarkedBy.has(user), applied: false, closed_at: null }],
        rowCount: 1,
      };
    }
    return empty;
  };
  const deps: Deps = { query, cache, now: () => new Date(clock.ms) };
  const get = (path: string, token = "ada-token") => handle(
    new Request("https://core.example/api/v1" + path, { headers: { authorization: `Bearer ${token}` } }), env(), deps);
  const close = () => handle(new Request(`https://core.example/api/v1/postings/${POSTING}/close`, {
    method: "POST",
    headers: { authorization: "Bearer ada-token", "content-type": "application/json", "idempotency-key": "33333333-3333-4333-8333-333333333333" },
    body: JSON.stringify({ expectedRevision: 2 }),
  }), env(), { ...deps, query: async (sql, params = []) => (sql.includes("idempotency_keys") ? (sql.includes("INSERT") ? { rows: [{ id: "11111111-1111-4111-8111-111111111111" }], rowCount: 1 } : empty) : query(sql, params)) });
  const aggregates = () => seen.filter((c) => !c.sql.startsWith("UPDATE") && c.sql.includes("job_postings") && (c.sql.includes("count(*)") || c.sql.includes("GROUP BY")));
  const lists = () => seen.filter((c) => c.sql.includes("ORDER BY") && c.sql.includes("FROM job_postings") && !c.sql.includes("count(*)"));
  return { seen, clock, cache, query, get, close, aggregates, lists, setTotal: (n: number) => { total = n; } };
};

type ListBody = { data: { id: string; bookmarked: boolean }[]; page: { total: number } };

test("GET /postings reads the total from Postgres once a minute, and the rows every time", async () => {
  resetLimits();
  const w = world();
  const first = await (await w.get("/postings")).json() as ListBody;
  const second = await (await w.get("/postings")).json() as ListBody;
  assert.equal(first.page.total, 7);
  assert.equal(second.page.total, 7);
  assert.equal(w.aggregates().length, 1);
  assert.equal(w.lists().length, 2);
});

test("the cache holds no user value: Bob gets his own bookmark flag and Ada's cached total", async () => {
  resetLimits();
  const w = world();
  const ada = await (await w.get("/postings")).json() as ListBody;
  const bob = await (await w.get("/postings", "bob-token")).json() as ListBody;
  assert.equal(ada.data[0].bookmarked, true);
  assert.equal(bob.data[0].bookmarked, false);
  assert.equal(ada.page.total, bob.page.total);
  assert.equal(w.aggregates().length, 1, "Bob did not run a second count");
  assert.deepEqual(w.lists().map((c) => c.params[0]), [ADA, BOB], "each list ran with its own user id");
  const counted = w.aggregates()[0];
  assert.equal(counted.sql.includes("bookmarks"), false);
  assert.equal(counted.sql.replace(/\$1\b/g, "").includes(ADA), false);
});

test("a different filter is a different cache entry", async () => {
  resetLimits();
  const w = world();
  await w.get("/postings?category=dev");
  w.setTotal(9);
  const other = await (await w.get("/postings?category=design")).json() as ListBody;
  const again = await (await w.get("/postings?category=dev")).json() as ListBody;
  assert.equal(other.page.total, 9);
  assert.equal(again.page.total, 7);
  assert.equal(w.aggregates().length, 2);
});

test("a free-text search is never cached", async () => {
  resetLimits();
  const w = world();
  await w.get("/postings?q=" + encodeURIComponent("백엔드"));
  await w.get("/postings?q=" + encodeURIComponent("백엔드"));
  assert.equal(w.aggregates().length, 2);
  assert.equal(w.cache.size, 0);
});

test("the total is read again 60 seconds later", async () => {
  resetLimits();
  const w = world();
  await w.get("/postings");
  w.clock.ms += READ_CACHE_TTL_MS - 1;
  await w.get("/postings");
  assert.equal(w.aggregates().length, 1);
  w.setTotal(8);
  w.clock.ms += 1;
  const later = await (await w.get("/postings")).json() as ListBody;
  assert.equal(later.page.total, 8);
  assert.equal(w.aggregates().length, 2);
});

test("GET /postings/facets runs its five aggregates once, for every user", async () => {
  resetLimits();
  const w = world();
  const first = await (await w.get("/postings/facets")).json() as { data: Record<string, unknown> };
  assert.equal(w.aggregates().length, 5);
  const second = await (await w.get("/postings/facets", "bob-token")).json() as { data: Record<string, unknown> };
  assert.equal(w.aggregates().length, 5, "the second read ran no aggregate");
  assert.deepEqual(second.data, first.data);
  assert.deepEqual(Object.keys(first.data).sort(), ["career", "category", "employmentType", "location", "skills"]);
});

test("a facet filter keeps its own entry, and the facet a filter skips keeps the unfiltered one", async () => {
  resetLimits();
  const w = world();
  await w.get("/postings/facets");
  await w.get("/postings/facets?category=dev");
  assert.equal(w.aggregates().length, 9, "the category facet ignores the category filter, so only four are new");
  await w.get("/postings/facets?category=dev");
  assert.equal(w.aggregates().length, 9);
});

test("GET /search/trending reads the skill counts once and the search terms every time", async () => {
  resetLimits();
  const w = world();
  const first = await (await w.get("/search/trending")).json() as { data: { terms: unknown[]; skills: { id: string; count: number }[] } };
  await w.get("/search/trending", "bob-token");
  assert.deepEqual(first.data.skills, [{ id: "Go", count: 4 }, { id: "SQL", count: 2 }]);
  assert.equal(w.seen.filter((c) => c.sql.includes("jsonb_array_elements_text")).length, 1);
  assert.equal(w.seen.filter((c) => c.sql.includes("FROM search_queries")).length, 2);
});

test("trending and the unfiltered facet skills run the same statement, so they share one entry", async () => {
  resetLimits();
  const w = world();
  await w.get("/search/trending");
  await w.get("/postings/facets");
  assert.equal(w.seen.filter((c) => c.sql.includes("jsonb_array_elements_text")).length, 1);
  await w.get("/postings/facets?category=dev");
  assert.equal(w.seen.filter((c) => c.sql.includes("jsonb_array_elements_text")).length, 2, "a filtered tally is a different statement");
});

test("closing a posting drops the cached counts in the same isolate", async () => {
  resetLimits();
  const w = world();
  await w.get("/postings");
  assert.equal((await w.close()).status, 200);
  w.setTotal(6);
  const after = await (await w.get("/postings")).json() as ListBody;
  assert.equal(after.page.total, 6);
  assert.equal(w.aggregates().length, 2);
});

test("without a cache every read goes to Postgres", async () => {
  resetLimits();
  const w = world();
  const bare = (path: string) => handle(new Request("https://core.example/api/v1" + path, { headers: { authorization: "Bearer ada-token" } }), env(), { query: w.query });
  await bare("/postings");
  await bare("/postings");
  assert.equal(w.seen.filter((c) => c.sql.includes("count(*)::int AS total")).length, 2);
});
