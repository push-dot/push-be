import assert from "node:assert/strict";
import { test } from "node:test";

import { handle, type CoreEnv, type Deps } from "../src/handler.ts";
import { resetLimits } from "../src/ratelimit.ts";
import { encodeCursor } from "../src/time.ts";

const USER = "12345678-1234-5678-1234-567812345678";
const POSTING = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const NOW = "2026-10-21T00:00:00.000Z";
const GUEST = "00000000-0000-0000-0000-000000000000";

type Call = { sql: string; params: unknown[] };

const env = (): CoreEnv => ({ APP_ENV: "production", MANAGED_AI: "1", MANAGED_GO: "0" });
const deps = (query: Deps["query"]): Deps => ({ query, now: () => new Date(NOW) });

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
  if (sql.includes("idempotency_keys") && sql.includes("INSERT")) {
    return { rows: [{ id: "11111111-1111-4111-8111-111111111111" }], rowCount: 1 };
  }
  if (sql.includes("idempotency_keys")) return { rows: [], rowCount: 0 };
  if (sql.includes("is_employer") && sql.includes("FROM users") && !sql.includes("access_tokens")) {
    return { rows: [{ is_employer: false, display_name: "Ada" }], rowCount: 1 };
  }
  return extra(sql, params);
};

const empty = { rows: [] as Record<string, unknown>[], rowCount: 0 };

const openRow = {
  id: POSTING,
  company: "Acme",
  title: "Backend",
  description: "Build APIs",
  status: "OPEN",
  applicant_count: 9,
  revision: 1,
  closed_at: null,
  created_at: NOW,
};

test("home sort accepts latest, deadline, and popular, and a 7-day deadline window", async () => {
  resetLimits();
  const seen: Call[] = [];
  const popular = await handle(
    new Request("https://core.example/api/v1/postings?sort=popular&deadlineWithin=7", {
      headers: { authorization: "Bearer secret-token" },
    }),
    env(),
    deps(authed(seen, async (sql) => {
      if (sql.includes("count(*)") && sql.includes("job_postings")) return { rows: [{ total: 1 }], rowCount: 1 };
      if (sql.includes("ORDER BY") && sql.includes("job_postings")) return { rows: [openRow], rowCount: 1 };
      return empty;
    })),
  );
  assert.equal(popular.status, 200);
  const popularBody = await popular.json() as { data: Record<string, unknown>[] };
  assert.equal(Object.hasOwn(popularBody.data[0], "applicantCount"), false);
  const ordered = seen.find((call) => call.sql.includes("ORDER BY") && call.sql.includes("job_postings"));
  assert.ok(ordered);
  assert.match(ordered.sql, /to_jsonb\(p\) ->> 'view_count'/);
  assert.match(ordered.sql, /view_count'\)::int, 0\) DESC/);
  assert.equal(ordered.params.includes("2026-10-21"), true);
  assert.equal(ordered.params.includes("2026-10-28"), true);

  resetLimits();
  const deadlineSeen: Call[] = [];
  const deadline = await handle(
    new Request("https://core.example/api/v1/postings?sort=deadline&cursor=" + encodeCursor("2026-10-01T00:00:00.000Z", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), {
      headers: { authorization: "Bearer secret-token" },
    }),
    env(),
    deps(authed(deadlineSeen, async () => empty)),
  );
  assert.equal(deadline.status, 200);
  const deadlineSql = deadlineSeen.find((call) => call.sql.includes("ORDER BY") && call.sql.includes("job_postings"));
  assert.ok(deadlineSql);
  assert.match(deadlineSql.sql, /p\.deadline ASC NULLS LAST/);
  assert.doesNotMatch(deadlineSql.sql, /created_at, p\.id\) </);

  resetLimits();
  const bad = await handle(
    new Request("https://core.example/api/v1/postings?sort=hot", { headers: { authorization: "Bearer secret-token" } }),
    env(),
    deps(authed([], async () => empty)),
  );
  assert.equal(bad.status, 422);
});

test("detail view counts once per user per day and a public detail includes applicantCount", async () => {
  resetLimits();
  let inserted = true;
  const seen: Call[] = [];
  const query = authed(seen, async (sql) => {
    if (sql.includes("company_members") && !sql.includes("access_tokens")) return empty;
    if (sql.includes("INSERT INTO posting_views")) {
      return inserted ? { rows: [{ posting_id: POSTING }], rowCount: 1 } : empty;
    }
    if (sql.includes("UPDATE") && sql.includes("view_count")) return { rows: [{ id: POSTING }], rowCount: 1 };
    if (sql.includes("FROM job_postings") && sql.includes("closed_at IS NULL")) return { rows: [openRow], rowCount: 1 };
    return empty;
  });
  const first = await handle(
    new Request(`https://core.example/api/v1/postings/${POSTING}`, { headers: { authorization: "Bearer secret-token" } }),
    env(),
    deps(query),
  );
  assert.equal(first.status, 200);
  const firstBody = await first.json() as { data: { applicantCount: number } };
  assert.equal(firstBody.data.applicantCount, 9);
  assert.equal(seen.filter((call) => call.sql.includes("UPDATE") && call.sql.includes("view_count")).length, 1);
  assert.equal(seen.some((call) => call.sql.includes("INSERT INTO posting_views") && call.params.includes(USER)), true);

  inserted = false;
  resetLimits();
  const secondSeen: Call[] = [];
  const second = await handle(
    new Request(`https://core.example/api/v1/postings/${POSTING}`, { headers: { authorization: "Bearer secret-token" } }),
    env(),
    deps(authed(secondSeen, async (sql) => {
      if (sql.includes("company_members") && !sql.includes("access_tokens")) return empty;
      if (sql.includes("INSERT INTO posting_views")) return empty;
      if (sql.includes("FROM job_postings") && sql.includes("closed_at IS NULL")) return { rows: [openRow], rowCount: 1 };
      return empty;
    })),
  );
  assert.equal(second.status, 200);
  assert.equal(secondSeen.some((call) => call.sql.includes("UPDATE") && call.sql.includes("view_count")), false);

  resetLimits();
  const guestSeen: Call[] = [];
  const guest = await handle(
    new Request(`https://core.example/api/v1/postings/${POSTING}`),
    env(),
    deps(async (sql, params = []) => {
      guestSeen.push({ sql, params });
      if (sql.includes("rate_limits")) return { rows: [{ hits: 1 }], rowCount: 1 };
      if (sql.includes("INSERT INTO posting_views")) return { rows: [{ posting_id: POSTING }], rowCount: 1 };
      if (sql.includes("UPDATE") && sql.includes("view_count")) return { rows: [{ id: POSTING }], rowCount: 1 };
      if (sql.includes("FROM job_postings") && sql.includes("closed_at IS NULL")) return { rows: [openRow], rowCount: 1 };
      return empty;
    }),
  );
  assert.equal(guest.status, 200);
  // posting_views.user_id references users, so the nil guest id cannot be stored (23503 on Postgres).
  assert.equal(guestSeen.some((call) => call.sql.includes("INSERT INTO posting_views") && call.params.includes(GUEST)), false);
});
