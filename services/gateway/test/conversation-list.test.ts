import assert from "node:assert/strict";
import { test } from "node:test";

import { memoryCache } from "../src/middleware/cache.ts";
import { handle, resetLimits, type Deps, type FrontEnv, type Query } from "../src/handler.ts";
import { encodeCursor } from "../src/time.ts";

const USER = "12345678-1234-5678-1234-567812345678";
const COMPANY = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const NEEDS_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const RUNNING_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DONE_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const POSTING_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const APP_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const NOW = new Date("2026-10-18T00:00:00Z");
const RAW_Q = "100%_a\\b";
const ESCAPED_Q = "%100\\%\\_a\\\\b%";
const LONG_PREVIEW = "가".repeat(160);

type Fixture = {
  id: string;
  revision: number;
  application_id: string | null;
  title: string;
  pinned: boolean;
  created_at: string;
  updated_at: string;
  posting_id: string | null;
  display_name: string | null;
  preview: string;
  status: string;
};

const FIXTURES: Fixture[] = [
  {
    id: RUNNING_ID,
    revision: 2,
    application_id: APP_ID,
    title: "작업 중",
    pinned: false,
    created_at: "2026-10-18T00:00:00Z",
    updated_at: "2026-10-16T00:00:00Z",
    posting_id: null,
    display_name: "Ada",
    preview: "still going",
    status: "RUNNING",
  },
  {
    id: NEEDS_ID,
    revision: 4,
    application_id: null,
    title: "승인 대기",
    pinned: true,
    created_at: "2026-10-15T00:00:00Z",
    updated_at: "2026-10-17T00:00:00Z",
    posting_id: POSTING_ID,
    display_name: "Bea",
    preview: LONG_PREVIEW,
    status: "NEEDS_APPROVAL",
  },
  {
    id: DONE_ID,
    revision: 1,
    application_id: null,
    title: "끝",
    pinned: false,
    created_at: "2026-10-14T00:00:00Z",
    updated_at: "2026-10-14T00:00:00Z",
    posting_id: null,
    display_name: null,
    preview: "",
    status: "DONE",
  },
];

const env = (): FrontEnv => ({
  DATABASE_URL: "postgres://example",
  API: { async fetch() { throw new Error("python should not be called"); } },
  CORE: { async fetch() { throw new Error("core should not be called"); } },
  APP_ENV: "production",
  MANAGED_AI: "1",
  MANAGED_GO: "0",
  SSE_MAX_POLLS: "3",
});

const deps = (query: Query): Deps => ({
  query,
  cache: memoryCache(() => NOW.getTime()),
  sleep: async () => {},
  now: () => NOW,
});

const ordersByUpdated = (sql: string): boolean =>
  /ORDER BY\s+(?:c\.|page\.)?updated_at DESC/.test(sql);

const rowsFor = (sql: string): Record<string, unknown>[] => {
  const key = ordersByUpdated(sql) ? "updated_at" : "created_at";
  const cut = sql.includes("left(last_msg.text, 140)");
  return [...FIXTURES].sort((a, b) => {
    if (a[key] === b[key]) return a.id < b.id ? 1 : -1;
    return a[key] < b[key] ? 1 : -1;
  }).map((row) => ({
    id: row.id,
    revision: row.revision,
    application_id: row.application_id,
    title: row.title,
    pinned: row.pinned,
    created_at: row.created_at,
    updated_at: row.updated_at,
    posting_id: row.posting_id,
    display_name: row.display_name,
    last_message_preview: cut ? row.preview.slice(0, 140) : row.preview,
    status: row.status,
  }));
};

const authRow = (): Record<string, unknown> => ({
  id: USER,
  display_name: "Ada",
  locale: "ko",
  created_at: "2026-01-02T03:04:05Z",
  expires_at: "2099-01-01T00:00:00Z",
  is_employer: true,
  company_id: COMPANY,
  company_role: "MEMBER",
  hits: 1,
});

const listQuery = (seen: Array<[string, unknown[]]>): Query => {
  return async (sql, params) => {
    seen.push([sql, params]);
    if (sql.includes("access_tokens")) {
      return [{ ...authRow(), rows: rowsFor(sql) }];
    }
    if (sql.includes("FROM users")) return [authRow()];
    if (sql.includes("rate_limits")) return [{ hits: 1 }];
    if (sql.includes("FROM conversations")) return rowsFor(sql);
    return [];
  };
};

const assertStatusSql = (sql: string): void => {
  const needs = sql.indexOf("THEN 'NEEDS_APPROVAL'");
  const running = sql.indexOf("THEN 'RUNNING'");
  assert.ok(needs >= 0 && running > needs);
  assert.match(sql, /WHEN EXISTS \(SELECT 1 FROM approvals a WHERE a\.conversation_id = c\.id AND a\.status = 'PENDING' AND \(a\.expires_at IS NULL OR a\.expires_at > now\(\)\)\) THEN 'NEEDS_APPROVAL'/);
  assert.match(sql, /WHEN EXISTS \(SELECT 1 FROM chat_jobs j WHERE j\.conversation_id = c\.id AND j\.status IN \('PENDING', 'RUNNING'\)\) THEN 'RUNNING'/);
  assert.match(sql, /ELSE 'DONE' END AS status/);
  assert.match(sql, /LEFT JOIN LATERAL \(SELECT m\.text FROM messages m WHERE m\.conversation_id = c\.id ORDER BY m\.created_at DESC, m\.id DESC LIMIT 1\) last_msg ON true/);
  assert.doesNotMatch(sql, /m\.text ILIKE/);
  assert.match(sql, /COALESCE\(last_msg\.text, ''\) ILIKE/);
  assert.match(sql, /c\.title ILIKE/);
  assert.match(sql, /ESCAPE '\\'/);
  assert.match(sql, /::text IS NULL OR c\.title ILIKE/);
  assert.match(sql, /COALESCE\(left\(last_msg\.text, 140\), ''\) AS last_message_preview/);
  assert.match(sql, /LEFT JOIN users cu ON cu\.id = c\.user_id/);
  assert.match(sql, /COALESCE\(cu\.display_name, ''\) AS display_name/);
  assert.match(sql, /c\.posting_id/);
  assert.match(sql, /ORDER BY c\.updated_at DESC, c\.id DESC/);
  assert.doesNotMatch(sql, /\(c\.created_at, c\.id\) </);
};

test("newer updated_at leads and the cursor uses that pair", async () => {
  resetLimits();
  const seen: Array<[string, unknown[]]> = [];
  const res = await handle(new Request(
    "https://push-be.example/api/v1/conversations?limit=2",
    { headers: { authorization: "Bearer secret-token" } },
  ), env(), deps(listQuery(seen)));
  assert.equal(res.status, 200);
  const body = await res.json() as {
    data: { id: string; createdAt: string; updatedAt: string }[];
    page: { hasMore: boolean; nextCursor: string };
  };
  assert.deepEqual(body.data.map((item) => item.id), [NEEDS_ID, RUNNING_ID]);
  assert.equal(body.data[0].createdAt, "2026-10-15T00:00:00Z");
  assert.equal(body.data[0].updatedAt, "2026-10-17T00:00:00Z");
  assert.equal(body.data[1].createdAt, "2026-10-18T00:00:00Z");
  assert.equal(body.page.hasMore, true);
  assert.equal(body.page.nextCursor, encodeCursor("2026-10-16T00:00:00Z", RUNNING_ID));
  const listSql = String(seen[0][0]);
  assert.match(listSql, /ORDER BY c\.updated_at DESC, c\.id DESC/);
  assert.match(listSql, /ORDER BY page\.updated_at DESC, page\.id DESC/);
  assert.match(listSql, /\(\$9::timestamptz IS NULL OR \(c\.updated_at, c\.id\) < \(\$9::timestamptz, \$10::uuid\)\)/);
});

test("pending approval is NEEDS_APPROVAL with no running job, a running job is RUNNING, otherwise DONE", async () => {
  resetLimits();
  const seen: Array<[string, unknown[]]> = [];
  const res = await handle(new Request(
    "https://push-be.example/api/v1/conversations",
    { headers: { authorization: "Bearer secret-token" } },
  ), env(), deps(listQuery(seen)));
  assert.equal(res.status, 200);
  const body = await res.json() as { data: Record<string, unknown>[] };
  assert.deepEqual(body.data, [
    {
      id: NEEDS_ID,
      revision: 4,
      applicationId: null,
      title: "승인 대기",
      pinned: true,
      createdAt: "2026-10-15T00:00:00Z",
      updatedAt: "2026-10-17T00:00:00Z",
      status: "NEEDS_APPROVAL",
      lastMessagePreview: "가".repeat(140),
      createdBy: { displayName: "Bea" },
      postingId: POSTING_ID,
    },
    {
      id: RUNNING_ID,
      revision: 2,
      applicationId: APP_ID,
      title: "작업 중",
      pinned: false,
      createdAt: "2026-10-18T00:00:00Z",
      updatedAt: "2026-10-16T00:00:00Z",
      status: "RUNNING",
      lastMessagePreview: "still going",
      createdBy: { displayName: "Ada" },
      postingId: null,
    },
    {
      id: DONE_ID,
      revision: 1,
      applicationId: null,
      title: "끝",
      pinned: false,
      createdAt: "2026-10-14T00:00:00Z",
      updatedAt: "2026-10-14T00:00:00Z",
      status: "DONE",
      lastMessagePreview: "",
      createdBy: { displayName: "" },
      postingId: null,
    },
  ]);
  assertStatusSql(String(seen[0][0]));
});

test("both list queries bind the escaped q and keep audience scope", async () => {
  resetLimits();
  const personalSeen: Array<[string, unknown[]]> = [];
  const personal = await handle(new Request(
    `https://push-be.example/api/v1/conversations?q=${encodeURIComponent(RAW_Q)}`,
    { headers: { authorization: "Bearer secret-token" } },
  ), env(), deps(listQuery(personalSeen)));
  assert.equal(personal.status, 200);
  const personalSql = String(personalSeen[0][0]);
  const personalParams = personalSeen[0][1];
  assert.equal(personalParams.length, 12);
  assert.equal(personalParams[7], null);
  assert.equal(personalParams[8], null);
  assert.equal(personalParams[9], null);
  assert.equal(personalParams[10], 51);
  assert.equal(personalParams[11], ESCAPED_Q);
  assert.match(personalSql, /\$12::text IS NULL/);
  assert.match(personalSql, /company_id IS NULL/);
  assert.match(personalSql, /LIMIT \$11/);
  assert.match(personalSql, /\$8::uuid IS NULL OR c\.application_id = \$8::uuid/);
  assertStatusSql(personalSql);

  resetLimits();
  const blankSeen: Array<[string, unknown[]]> = [];
  const blank = await handle(new Request(
    "https://push-be.example/api/v1/conversations?q=%20%20",
    { headers: { authorization: "Bearer secret-token" } },
  ), env(), deps(listQuery(blankSeen)));
  assert.equal(blank.status, 200);
  assert.equal(blankSeen[0][1][11], null);

  resetLimits();
  const employerSeen: Array<[string, unknown[]]> = [];
  const cursor = encodeCursor("2026-10-16T00:00:00Z", RUNNING_ID);
  const employer = await handle(new Request(
    `https://push-be.example/api/v1/conversations?audience=EMPLOYER&q=${encodeURIComponent(RAW_Q)}&cursor=${cursor}`,
    { headers: { authorization: "Bearer secret-token" } },
  ), env(), deps(listQuery(employerSeen)));
  assert.equal(employer.status, 200);
  const employerList = employerSeen.find(([sql]) => sql.includes("FROM conversations") && !sql.includes("access_tokens"));
  assert.ok(employerList);
  assertStatusSql(employerList[0]);
  assert.match(employerList[0], /company_id = \$1::uuid/);
  assert.doesNotMatch(employerList[0], /user_id = \$1/);
  assert.match(employerList[0], /\(c\.updated_at, c\.id\) < \(\$\d+::timestamptz, \$\d+::uuid\)/);
  assert.equal(employerList[1][0], COMPANY);
  assert.ok(employerList[1].includes(ESCAPED_Q));
  const employerBody = await employer.json() as { data: { id: string; status: string }[] };
  assert.equal(employerBody.data[0].id, NEEDS_ID);
  assert.equal(employerBody.data[0].status, "NEEDS_APPROVAL");

  resetLimits();
  const devEnv = env();
  devEnv.APP_ENV = "development";
  devEnv.DEV_AUTH_TOKEN = "secret-token";
  devEnv.DEV_USER_ID = USER;
  const personalForSeen: Array<[string, unknown[]]> = [];
  const personalFor = await handle(new Request(
    `https://push-be.example/api/v1/conversations?q=${encodeURIComponent(RAW_Q)}`,
    { headers: { authorization: "Bearer secret-token" } },
  ), devEnv, deps(listQuery(personalForSeen)));
  assert.equal(personalFor.status, 200);
  const forList = personalForSeen.find(([sql]) => sql.includes("FROM conversations") && !sql.includes("access_tokens"));
  assert.ok(forList);
  assertStatusSql(forList[0]);
  assert.match(forList[0], /user_id = \$1::uuid AND company_id IS NULL/);
  assert.equal(forList[1][0], USER);
  assert.ok(forList[1].includes(ESCAPED_Q));
  const forBody = await personalFor.json() as { data: { id: string; createdBy: { displayName: string }; postingId: string | null }[] };
  assert.equal(forBody.data[0].id, NEEDS_ID);
  assert.equal(forBody.data[0].createdBy.displayName, "Bea");
  assert.equal(forBody.data[0].postingId, POSTING_ID);
});

test("an expired approval card does not flag the conversation as NEEDS_APPROVAL", async () => {
  const { LIST_SQL } = await import("../src/middleware/ratelimit.ts");
  const { readFile } = await import("node:fs/promises");
  const inline = await readFile(new URL("../src/routes/conversations.ts", import.meta.url), "utf8");
  for (const sql of [LIST_SQL, inline]) {
    assert.match(sql, /a\.status = 'PENDING' AND \(a\.expires_at IS NULL OR a\.expires_at > now\(\)\)/);
  }
});
