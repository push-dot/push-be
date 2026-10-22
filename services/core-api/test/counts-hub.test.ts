import assert from "node:assert/strict";
import { test } from "node:test";

import { handle, type CoreEnv, type Deps } from "../src/handler.ts";
import { resetLimits } from "../src/ratelimit.ts";

const USER = "12345678-1234-5678-1234-567812345678";
const OTHER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const NOW = "2026-10-21T00:00:00.000Z";

type Call = { sql: string; params: unknown[] };

const env = (): CoreEnv => ({ APP_ENV: "production", MANAGED_AI: "1", MANAGED_GO: "0" });
const deps = (query: Deps["query"]): Deps => ({ query, now: () => new Date(NOW) });
const empty = { rows: [] as Record<string, unknown>[], rowCount: 0 };

const authed = (seen: Call[], extra: Deps["query"]): Deps["query"] => async (sql, params = []) => {
  seen.push({ sql, params });
  if (sql.includes("rate_limits")) return { rows: [{ hits: 1 }], rowCount: 1 };
  if (sql.includes("access_tokens")) {
    return {
      rows: [{
        id: USER, display_name: "Ada", locale: "ko", plan: "FREE", subscription_status: "NONE",
        created_at: NOW, token_expires_at: "2099-01-01T00:00:00Z", is_employer: false,
      }],
      rowCount: 1,
    };
  }
  if (sql.includes("idempotency_keys")) return { rows: [], rowCount: 0 };
  if (sql.includes("is_employer") && sql.includes("FROM users") && !sql.includes("access_tokens")) {
    return { rows: [{ is_employer: false }], rowCount: 1 };
  }
  return extra(sql, params);
};

const get = (path: string): Request => new Request("https://core.example" + path, {
  headers: { authorization: "Bearer secret-token" },
});

test("search counts return tab totals and store the term", async () => {
  resetLimits();
  const seen: Call[] = [];
  const res = await handle(new Request("https://core.example/api/v1/search/counts?q=kotlin"), env(), deps(async (sql, params = []) => {
    seen.push({ sql, params });
    if (sql.includes("rate_limits")) return { rows: [{ hits: 1 }], rowCount: 1 };
    if (sql.includes("INSERT INTO search_queries")) return empty;
    if (sql.includes("count(*)") && sql.includes("job_postings")) return { rows: [{ total: 2 }], rowCount: 1 };
    if (sql.includes("count(*)") && sql.includes("profiles")) return { rows: [{ total: 3 }], rowCount: 1 };
    if (sql.includes("count(*)") && sql.includes("posts")) return { rows: [{ total: 4 }], rowCount: 1 };
    return empty;
  }));
  assert.equal(res.status, 200);
  const body = await res.json() as { data: { postings: number; people: number; posts: number } };
  assert.deepEqual(body.data, { postings: 2, people: 3, posts: 4 });
  assert.equal(seen.some((call) => call.sql.includes("INSERT INTO search_queries") && call.params.includes("kotlin")), true);
});

test("trending returns recent terms and open-posting skills", async () => {
  resetLimits();
  const res = await handle(new Request("https://core.example/api/v1/search/trending"), env(), deps(async (sql) => {
    if (sql.includes("rate_limits")) return { rows: [{ hits: 1 }], rowCount: 1 };
    if (sql.includes("FROM search_queries")) return { rows: [{ term: "kotlin", count: 4 }], rowCount: 1 };
    if (sql.includes("jsonb_array_elements_text")) return { rows: [{ id: "Kotlin", count: 2 }], rowCount: 1 };
    return empty;
  }));
  assert.equal(res.status, 200);
  const body = await res.json() as { data: { terms: { term: string; count: number }[]; skills: { id: string; count: number }[] } };
  assert.deepEqual(body.data.terms, [{ term: "kotlin", count: 4 }]);
  assert.deepEqual(body.data.skills, [{ id: "Kotlin", count: 2 }]);

  resetLimits();
  const missing = await handle(new Request("https://core.example/api/v1/search/trending"), env(), deps(async (sql) => {
    if (sql.includes("rate_limits")) return { rows: [{ hits: 1 }], rowCount: 1 };
    if (sql.includes("search_queries")) throw Object.assign(new Error('relation "search_queries" does not exist'), { code: "42P01" });
    if (sql.includes("jsonb_array_elements_text")) return { rows: [{ id: "Go", count: 1 }], rowCount: 1 };
    return empty;
  }));
  assert.equal(missing.status, 200);
  const missingBody = await missing.json() as { data: { terms: unknown[]; skills: { id: string }[] } };
  assert.deepEqual(missingBody.data.terms, []);
  assert.equal(missingBody.data.skills[0].id, "Go");
});

test("posting facets include skills with a positive count", async () => {
  resetLimits();
  const res = await handle(new Request("https://core.example/api/v1/postings/facets"), env(), deps(async (sql) => {
    if (sql.includes("rate_limits")) return { rows: [{ hits: 1 }], rowCount: 1 };
    if (sql.includes("jsonb_array_elements_text")) return { rows: [{ id: "Kotlin", count: 2 }, { id: "Go", count: 0 }], rowCount: 2 };
    if (sql.includes("career_0")) return { rows: [{ career_0: 0, career_1_3: 0, career_4_6: 0, career_7_9: 0, career_10: 0 }], rowCount: 1 };
    return empty;
  }));
  assert.equal(res.status, 200);
  const body = await res.json() as { data: { skills: { id: string; count: number }[] } };
  assert.deepEqual(body.data.skills, [{ id: "Kotlin", count: 2 }]);
});

test("hub tenure and status filters accept comma lists", async () => {
  resetLimits();
  const seen: Call[] = [];
  const res = await handle(get("/api/v1/profiles?tenure=0-2,3-5&status=seeking,feedback"), env(), deps(authed(seen, async (sql) => {
    if (sql.includes("SELECT email FROM users")) return { rows: [{ email: "ada@acme.com" }], rowCount: 1 };
    if (sql.includes("count(*)")) return { rows: [{ total: 1 }], rowCount: 1 };
    if (sql.includes("FROM profiles")) {
      return { rows: [{ user_id: OTHER, display_name: "Bea", updated_at: NOW, career_status: "seeking" }], rowCount: 1 };
    }
    return empty;
  })));
  assert.equal(res.status, 200);
  const body = await res.json() as { page: { total: number } };
  assert.equal(body.page.total, 1);
  const sql = seen.find((call) => call.sql.includes("FROM profiles") && call.sql.includes("tenure_years"));
  assert.ok(sql);
  assert.match(sql.sql, /OR/);
  assert.equal(sql.params.includes(0), true);
  assert.equal(sql.params.includes(2), true);
  assert.equal(sql.params.includes(3), true);
  assert.equal(sql.params.includes(5), true);
  assert.match(sql.sql, /career_status = ANY/);
  assert.equal(sql.params.includes("seeking\u001ffeedback"), true);

  resetLimits();
  const bad = await handle(get("/api/v1/profiles?tenure=0-2,nope"), env(), deps(authed([], async () => empty)));
  assert.equal(bad.status, 422);
});

test("popular posts from the last week sort by view count", async () => {
  resetLimits();
  const seen: Call[] = [];
  const res = await handle(get("/api/v1/posts?sort=popular&period=week"), env(), deps(authed(seen, async (sql) => {
    if (sql.includes("FROM posts") || sql.includes("posts p")) {
      return { rows: [{ id: OTHER, user_id: USER, display_name: "Ada", title: "Hi", body: "There", view_count: 3, created_at: NOW, comment_count: 0 }], rowCount: 1 };
    }
    return empty;
  })));
  assert.equal(res.status, 200);
  const sql = seen.find((call) => call.sql.includes("ORDER BY") && call.sql.includes("posts"));
  assert.ok(sql);
  assert.match(sql.sql, /view_count DESC/);
  assert.equal(sql.params.includes("2026-10-14T00:00:00.000Z"), true);

  resetLimits();
  const bad = await handle(get("/api/v1/posts?sort=hot"), env(), deps(authed([], async () => empty)));
  assert.equal(bad.status, 422);
  const period = await handle(get("/api/v1/posts?period=month"), env(), deps(authed([], async () => empty)));
  assert.equal(period.status, 422);
});

test("counted lists include page.total", async () => {
  const cases = [
    ["/api/v1/me/bookmarks", "bookmarks"],
    ["/api/v1/me/offers?box=sent", "offers"],
    ["/api/v1/me/follows", "follows"],
    ["/api/v1/me/posts", "posts"],
    ["/api/v1/me/commented-posts", "post_comments"],
    ["/api/v1/search?type=postings&q=kotlin", "job_postings"],
  ] as const;
  for (const [path, marker] of cases) {
    resetLimits();
    const res = await handle(get(path), env(), deps(authed([], async (sql) => {
      if (sql.includes("SELECT email FROM users")) return { rows: [{ email: "" }], rowCount: 1 };
      if (sql.includes("count(*)") && sql.includes(marker)) return { rows: [{ total: 6 }], rowCount: 1 };
      if (sql.includes("INSERT INTO search_queries")) return empty;
      if (marker === "job_postings" && sql.includes("job_postings")) return { rows: [{ id: OTHER, title: "Backend", created_at: NOW }], rowCount: 1 };
      if (marker === "offers" && sql.includes("offers")) return { rows: [{ id: OTHER, created_at: NOW }], rowCount: 1 };
      if (marker === "follows" && sql.includes("follows")) return { rows: [{ user_id: OTHER, updated_at: NOW, relation_created_at: NOW }], rowCount: 1 };
      if (marker === "posts" && sql.includes("posts")) return { rows: [{ id: OTHER, user_id: USER, created_at: NOW }], rowCount: 1 };
      if (marker === "post_comments" && sql.includes("posts")) return { rows: [{ id: OTHER, user_id: USER, created_at: NOW }], rowCount: 1 };
      if (marker === "bookmarks" && sql.includes("job_postings")) return { rows: [{ id: OTHER, created_at: NOW, bookmark_created_at: NOW }], rowCount: 1 };
      return empty;
    })));
    assert.equal(res.status, 200, path);
    const body = await res.json() as { page: { total?: number } };
    assert.equal(body.page.total, 6, path);
  }
});
