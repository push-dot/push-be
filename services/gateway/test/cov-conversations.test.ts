import assert from "node:assert/strict";
import { test } from "node:test";

import { handle, resetLimits, type Deps, type FrontEnv, type Query } from "../src/handler.ts";
import { encodeCursor } from "../src/time.ts";

const USER_A = "aaaaaaaa-0000-4000-8000-00000000000a";
const USER_B = "bbbbbbbb-0000-4000-8000-00000000000b";
const COMPANY = "cccccccc-0000-4000-8000-00000000000c";
const CONV_A = "aaaaaaaa-1111-4111-8111-111111111111";
const CONV_SHARED = "cccccccc-2222-4222-8222-222222222222";
const APP = "ffffffff-3333-4333-8333-333333333333";
const JOB = "dddddddd-4444-4444-8444-444444444444";
const MSG_1 = "eeeeeeee-0000-4000-8000-000000000001";
const MSG_2 = "eeeeeeee-0000-4000-8000-000000000002";
const NOW = new Date("2026-10-18T00:00:00Z");
const BASE = "https://push-be.example/api/v1";
const TOKENS: Record<string, string> = { [USER_A]: "tok-a", [USER_B]: "tok-b" };

type Seen = Array<[string, unknown[]]>;
type Rows = Record<string, unknown>[];

const env = (extra: Partial<FrontEnv> = {}): FrontEnv => ({
  DATABASE_URL: "postgres://example",
  CORE: { async fetch() { throw new Error("core should not be called"); } },
  APP_ENV: "production",
  SSE_MAX_POLLS: "3",
  ...extra,
});

const deps = (query: Query, sleep: Deps["sleep"] = async () => {}): Deps => ({
  query, sleep, now: () => NOW,
});

const userRow = (id: string, companyId: string | null = null): Record<string, unknown> => ({
  id, display_name: id === USER_A ? "Ada" : "Bea", locale: "ko",
  created_at: "2026-01-02T03:04:05Z", expires_at: "2099-01-01T00:00:00Z",
  is_employer: companyId != null, company_id: companyId, company_role: companyId ? "MEMBER" : null,
});

const get = (path: string, user: string, headers: Record<string, string> = {}): Request =>
  new Request(BASE + path, { headers: { authorization: `Bearer ${TOKENS[user]}`, ...headers } });

const isShared = (sql: string) => sql.startsWith("WITH auth");
const isAuthOnly = (sql: string) => sql.includes("FROM access_tokens") && !isShared(sql);
const isDevUser = (sql: string) => sql.includes("FROM users u LEFT JOIN company_members") && !sql.includes("access_tokens");

// Owner table the scoping queries are evaluated against, so isolation is real behavior, not a stub.
const CONVS: Record<string, { owner: string; company: string | null }> = {
  [CONV_A]: { owner: USER_A, company: null },
  [CONV_SHARED]: { owner: USER_A, company: COMPANY },
};

type Fake = {
  user: Record<string, unknown>;
  shared?: (sql: string, params: unknown[]) => Rows;
  data?: (sql: string, params: unknown[]) => Rows;
};

const fake = (seen: Seen, f: Fake): Query => async (sql, params = []) => {
  seen.push([sql, params]);
  if (isShared(sql)) return f.shared ? f.shared(sql, params) : [{ ...f.user, hits: 1 }];
  if (isAuthOnly(sql) || isDevUser(sql)) return [f.user];
  if (sql.includes("rate_limits")) return [{ hits: 1 }];
  // The scoped statements: visibility first, then messages, the active job, or a cancel.
  if (sql.startsWith("WITH found AS (SELECT id, company_id FROM conversations")) {
    const [id, userId, companyId] = params as [string, string, string | null];
    const c = CONVS[id];
    if (!c || !(c.owner === userId || (companyId != null && c.company === companyId))) {
      return [{ conversation_id: null, job_id: null, rows: [] }];
    }
    const rows = f.data ? f.data(sql, params) : [];
    return sql.includes("FROM messages")
      ? [{ conversation_id: id, rows }]
      : [{ conversation_id: id, job_id: rows[0]?.id ?? null }];
  }
  return f.data ? f.data(sql, params) : [];
};

const boom = (): never => { throw new Error("db down"); };
const dataSeen = (seen: Seen): Seen => seen.filter(([sql]) => !isShared(sql) && !isAuthOnly(sql) && !isDevUser(sql) && !sql.includes("rate_limits"));

// One shared read grants a lease of 4 and caches auth, so later requests take the ctx.user branch.
// AUTH_CACHE_TTL=0 skips the auth cache, so later requests take the revalidate branch.
const warm = async (user: string, e: FrontEnv, companyId: string | null = null): Promise<void> => {
  const res = await handle(get("/auth/me", user), e, deps(async () => [{ ...userRow(user, companyId), hits: 1, granted: 4 }]));
  assert.equal(res.status, 200);
};

const devEnv = (user: string): FrontEnv => env({ APP_ENV: "development", DEV_AUTH_TOKEN: TOKENS[user], DEV_USER_ID: user });

const errorCode = async (res: Response): Promise<string> => ((await res.json()) as { error: { code: string } }).error.code;

const convRow = (id: string, updated: string) => ({
  id, revision: "3", application_id: null, title: null, pinned: "t",
  created_at: "2026-10-01T00:00:00Z", updated_at: updated, posting_id: "", display_name: null,
  last_message_preview: null, status: "",
});

// ---- list conversations ----

test("list conversations rejects bad input before touching the database", async () => {
  resetLimits();
  const seen: Seen = [];
  const q = fake(seen, { user: userRow(USER_A) });
  for (const [path, field] of [
    ["/conversations?applicationId=nope", "applicationId"],
    ["/conversations?cursor=%%%", "cursor"],
    [`/conversations?cursor=${encodeCursor("2026-10-01T00:00:00Z", "not-a-uuid")}`, "cursor"],
    ["/conversations?limit=0", "limit"],
  ]) {
    const res = await handle(get(path, USER_A), env(), deps(q));
    assert.equal(res.status, 400, path);
    const body = await res.json() as { error: { code: string; details: { field: string } } };
    assert.equal(body.error.code, "VALIDATION_ERROR");
    assert.equal(body.error.details.field, field);
  }
  assert.equal(seen.length, 0);
});

test("list conversations without a bearer token is 401", async () => {
  resetLimits();
  const seen: Seen = [];
  const res = await handle(new Request(BASE + "/conversations"), env(), deps(fake(seen, { user: userRow(USER_A) })));
  assert.equal(res.status, 401);
  assert.equal(await errorCode(res), "UNAUTHENTICATED");
  assert.equal(seen.length, 0);
});

test("employer audience needs a verified company and scopes by company id", async () => {
  resetLimits();
  const noCompany = await handle(get("/conversations?audience=EMPLOYER", USER_B), env(), deps(fake([], { user: userRow(USER_B) })));
  assert.equal(noCompany.status, 403);
  assert.equal(await errorCode(noCompany), "BUSINESS_NOT_VERIFIED");

  resetLimits();
  const failing = await handle(get("/conversations?audience=EMPLOYER", USER_B), env(),
    deps(fake([], { user: userRow(USER_B, COMPANY), data: boom })));
  assert.equal(failing.status, 500);
  assert.equal(await errorCode(failing), "INTERNAL");

  resetLimits();
  const missing = await handle(new Request(BASE + "/conversations?audience=EMPLOYER"), env(), deps(fake([], { user: userRow(USER_B) })));
  assert.equal(missing.status, 401);
});

test("a cached session lists only the caller's personal conversations with filters and paging", async () => {
  resetLimits();
  const e = env();
  await warm(USER_B, e);
  const seen: Seen = [];
  const cursor = encodeCursor("2026-10-10T00:00:00Z", CONV_A);
  const res = await handle(get(`/conversations?limit=1&applicationId=${APP}&cursor=${cursor}`, USER_B), e, deps(fake(seen, {
    user: userRow(USER_B),
    data: () => [convRow(CONV_A, "2026-10-09T00:00:00Z"), convRow(CONV_SHARED, "2026-10-08T00:00:00Z")],
  })));
  assert.equal(res.status, 200);
  // ctx.user skips the shared auth read entirely
  assert.equal(seen.some(([sql]) => isShared(sql) || isAuthOnly(sql)), false);
  const [[sql, params]] = dataSeen(seen);
  assert.match(sql, /WHERE user_id = \$1::uuid AND company_id IS NULL AND c\.archived = false/);
  assert.match(sql, / AND c\.application_id = \$2::uuid/);
  assert.match(sql, /\(c\.updated_at, c\.id\) < \(\$3::timestamptz, \$4::uuid\)/);
  assert.match(sql, /LIMIT \$6$/);
  assert.deepEqual(params, [USER_B, APP, "2026-10-10T00:00:00Z", CONV_A, null, 2]);
  const body = await res.json() as { data: Record<string, unknown>[]; page: { hasMore: boolean; nextCursor: string } };
  assert.deepEqual(body.data, [{
    id: CONV_A, revision: 3, applicationId: null, title: "", pinned: true,
    createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-09T00:00:00Z", status: "DONE",
    lastMessagePreview: "", createdBy: { displayName: "" }, postingId: null,
  }]);
  assert.deepEqual(body.page, { hasMore: true, nextCursor: encodeCursor("2026-10-09T00:00:00Z", CONV_A) });
});

test("a cached session list maps a database failure to 500", async () => {
  resetLimits();
  const e = env();
  await warm(USER_A, e);
  const res = await handle(get("/conversations", USER_A), e, deps(fake([], { user: userRow(USER_A), data: boom })));
  assert.equal(res.status, 500);
  assert.equal(await errorCode(res), "INTERNAL");
});

test("a lease without cached auth revalidates the token and still scopes to that user", async () => {
  resetLimits();
  const e = env({ AUTH_CACHE_TTL: "0" });
  await warm(USER_A, e);
  const seen: Seen = [];
  const res = await handle(get("/conversations", USER_A), e, deps(fake(seen, { user: userRow(USER_A), data: () => [] })));
  assert.equal(res.status, 200);
  assert.ok(seen.some(([sql, params]) => isAuthOnly(sql) && params[0] !== TOKENS[USER_A]), "token is hashed, never sent raw");
  assert.equal(dataSeen(seen)[0][1][0], USER_A);
  assert.deepEqual(await res.json(), { data: [], page: { nextCursor: null, hasMore: false } });

  resetLimits();
  await warm(USER_A, e);
  const revoked = await handle(get("/conversations", USER_A), e, deps(async (sql) => {
    if (isAuthOnly(sql)) return [];
    throw new Error("must not list after a revoked token");
  }));
  assert.equal(revoked.status, 401);
  assert.equal(await errorCode(revoked), "UNAUTHENTICATED");
});

test("dev token lists for the seeded dev user and maps failures to 500", async () => {
  resetLimits();
  const seen: Seen = [];
  const ok = await handle(get("/conversations", USER_A), devEnv(USER_A), deps(fake(seen, { user: userRow(USER_A), data: () => [] })));
  assert.equal(ok.status, 200);
  assert.equal(dataSeen(seen)[0][1][0], USER_A);

  resetLimits();
  const bad = await handle(get("/conversations", USER_A), devEnv(USER_A), deps(fake([], { user: userRow(USER_A), data: boom })));
  assert.equal(bad.status, 500);
});

test("when the shared read fails the list falls back to a plain auth and scoped query", async () => {
  resetLimits();
  const seen: Seen = [];
  const res = await handle(get("/conversations", USER_B), env(), deps(fake(seen, {
    user: userRow(USER_B), shared: boom, data: () => [convRow(CONV_A, "2026-10-09T00:00:00Z")],
  })));
  assert.equal(res.status, 200);
  const [[sql, params]] = dataSeen(seen);
  assert.match(sql, /user_id = \$1::uuid AND company_id IS NULL/);
  assert.equal(params[0], USER_B);

  resetLimits();
  const failed = await handle(get("/conversations", USER_B), env(), deps(fake([], { user: userRow(USER_B), shared: boom, data: boom })));
  assert.equal(failed.status, 500);

  resetLimits();
  const unknown = await handle(get("/conversations", USER_B), env(), deps(async (sql) => {
    if (isShared(sql)) throw new Error("db down");
    return [];
  }));
  assert.equal(unknown.status, 401);
});

// ---- list messages ----

const msgRows = (): Rows => [
  {
    id: MSG_2, conversation_id: CONV_A, role: "assistant", text: null, operation_id: null,
    created_at: "2026-10-02T00:00:00Z",
    attachments: JSON.stringify([{ type: "document", id: "a1", documentId: 42, title: "CV" }, null, "x"]),
  },
  {
    id: MSG_1, conversation_id: CONV_A, role: "user", text: "hi", operation_id: "op-1",
    created_at: "2026-10-01T00:00:00Z", attachments: "not json",
  },
];

test("list messages validates the id, limit, and cursor", async () => {
  resetLimits();
  const seen: Seen = [];
  const q = fake(seen, { user: userRow(USER_A) });
  for (const [path, field] of [
    ["/conversations/nope/messages", "id"],
    [`/conversations/${CONV_A}/messages?limit=abc`, "limit"],
    [`/conversations/${CONV_A}/messages?cursor=bad`, "cursor"],
  ]) {
    const res = await handle(get(path, USER_A), env(), deps(q));
    assert.equal(res.status, 400, path);
    assert.equal((await res.json() as { error: { details: { field: string } } }).error.details.field, field);
  }
  assert.equal(seen.length, 0);
  const anon = await handle(new Request(`${BASE}/conversations/${CONV_A}/messages`), env(), deps(q));
  assert.equal(anon.status, 401);
});

test("the owner reads a personal conversation with user-scoped SQL, paging, and parsed attachments", async () => {
  resetLimits();
  const e = env();
  await warm(USER_A, e);
  const seen: Seen = [];
  const cursor = encodeCursor("2026-10-03T00:00:00Z", MSG_2);
  const res = await handle(get(`/conversations/${CONV_A}/messages?limit=1&cursor=${cursor}`, USER_A), e,
    deps(fake(seen, { user: userRow(USER_A), data: msgRows })));
  assert.equal(res.status, 200);
  const reads = dataSeen(seen);
  assert.equal(reads.length, 1);
  const [[sql, params]] = reads;
  assert.match(sql, /user_id = \$2::uuid OR \(\$3::uuid IS NOT NULL AND company_id = \$3::uuid\)/);
  assert.match(sql, /found\.company_id IS NOT NULL OR m\.user_id = \$2::uuid/);
  assert.match(sql, /\(m\.created_at, m\.id\) < \(\$4::timestamptz, \$5::uuid\)/);
  assert.deepEqual(params, [CONV_A, USER_A, null, "2026-10-03T00:00:00Z", MSG_2, 2]);
  const body = await res.json() as { data: Record<string, unknown>[]; page: { hasMore: boolean; nextCursor: string } };
  assert.deepEqual(body.data, [{
    id: MSG_2, conversationId: CONV_A, role: "assistant", text: "",
    attachments: [{ type: "document", id: "a1", documentId: "42", title: "CV" }, { type: "", id: "" }, { type: "", id: "" }],
    operationId: null, createdAt: "2026-10-02T00:00:00Z",
  }]);
  assert.deepEqual(body.page, { hasMore: true, nextCursor: encodeCursor("2026-10-02T00:00:00Z", MSG_2) });
});

test("invalid or non-array attachments become an empty list", async () => {
  resetLimits();
  const e = env();
  await warm(USER_A, e);
  const res = await handle(get(`/conversations/${CONV_A}/messages`, USER_A), e, deps(fake([], {
    user: userRow(USER_A),
    data: () => [msgRows()[1], { ...msgRows()[1], id: MSG_2, attachments: { type: "not-a-list" } }, { ...msgRows()[1], attachments: null }],
  })));
  const body = await res.json() as { data: { attachments: unknown[]; operationId: string }[] };
  assert.deepEqual(body.data.map((m) => m.attachments), [[], [], []]);
  assert.equal(body.data[0].operationId, "op-1");
});

test("user B cannot read user A's personal conversation", async () => {
  resetLimits();
  const e = env();
  await warm(USER_B, e);
  const seen: Seen = [];
  const res = await handle(get(`/conversations/${CONV_A}/messages`, USER_B), e,
    deps(fake(seen, { user: userRow(USER_B), data: () => { throw new Error("messages must not be read"); } })));
  assert.equal(res.status, 404);
  assert.equal(await errorCode(res), "NOT_FOUND");
  const [found] = dataSeen(seen);
  assert.match(found[0], /user_id = \$2::uuid OR \(\$3::uuid IS NOT NULL AND company_id = \$3::uuid\)/);
  assert.deepEqual(found[1].slice(0, 3), [CONV_A, USER_B, null]);
});

test("a company member reads a shared conversation without the user filter", async () => {
  resetLimits();
  const e = env({ AUTH_CACHE_TTL: "0" });
  await warm(USER_B, e, COMPANY);
  const seen: Seen = [];
  const res = await handle(get(`/conversations/${CONV_SHARED}/messages`, USER_B), e,
    deps(fake(seen, { user: userRow(USER_B, COMPANY), data: () => [] })));
  assert.equal(res.status, 200);
  const [[sql, params]] = dataSeen(seen);
  assert.match(sql, /found\.company_id IS NOT NULL OR m\.user_id/);
  assert.deepEqual(params, [CONV_SHARED, USER_B, COMPANY, null, null, 51]);
});

test("a cached session message read maps a database failure to 500", async () => {
  resetLimits();
  const e = env();
  await warm(USER_A, e);
  const res = await handle(get(`/conversations/${CONV_A}/messages`, USER_A), e, deps(async (sql) => {
    if (sql.includes("FROM conversations")) throw new Error("db down");
    return [];
  }));
  assert.equal(res.status, 500);
  assert.equal(await errorCode(res), "INTERNAL");
});

test("dev token reads messages for the seeded user and maps list failures to 500", async () => {
  resetLimits();
  const seen: Seen = [];
  const ok = await handle(get(`/conversations/${CONV_A}/messages`, USER_A), devEnv(USER_A),
    deps(fake(seen, { user: userRow(USER_A), data: msgRows })));
  assert.equal(ok.status, 200);
  assert.deepEqual(dataSeen(seen)[0][1].slice(0, 3), [CONV_A, USER_A, null]);

  resetLimits();
  const failing = await handle(get(`/conversations/${CONV_A}/messages`, USER_A), devEnv(USER_A), deps(async (sql) => {
    if (isDevUser(sql)) return [userRow(USER_A)];
    if (sql.includes("rate_limits")) return [{ hits: 1 }];
    throw new Error("db down");
  }));
  assert.equal(failing.status, 500);
});

test("when the shared message read fails it falls back to scoped queries", async () => {
  resetLimits();
  const seen: Seen = [];
  const ok = await handle(get(`/conversations/${CONV_A}/messages`, USER_A), env(),
    deps(fake(seen, { user: userRow(USER_A), shared: boom, data: msgRows })));
  assert.equal(ok.status, 200);
  assert.equal((await ok.json() as { data: unknown[] }).data.length, 2);
  assert.deepEqual(dataSeen(seen)[0][1].slice(0, 3), [CONV_A, USER_A, null]);

  resetLimits();
  const isolated = await handle(get(`/conversations/${CONV_A}/messages`, USER_B), env(),
    deps(fake([], { user: userRow(USER_B), shared: boom, data: msgRows })));
  assert.equal(isolated.status, 404);

  resetLimits();
  const failing = await handle(get(`/conversations/${CONV_A}/messages`, USER_A), env(), deps(async (sql) => {
    if (isAuthOnly(sql)) return [userRow(USER_A)];
    throw new Error("db down");
  }));
  assert.equal(failing.status, 500);

  resetLimits();
  const anon = await handle(get(`/conversations/${CONV_A}/messages`, USER_A), env(), deps(async (sql) => {
    if (isShared(sql)) throw new Error("db down");
    return [];
  }));
  assert.equal(anon.status, 401);
});

test("the shared message read returns 404 when the conversation is not visible", async () => {
  resetLimits();
  const res = await handle(get(`/conversations/${CONV_A}/messages`, USER_B), env(), deps(fake([], {
    user: userRow(USER_B), shared: () => [{ ...userRow(USER_B), hits: 1, conversation_id: null, rows: [] }],
  })));
  assert.equal(res.status, 404);
});

// ---- stream cancel ----

const cancel = (id: string, user: string): Request =>
  new Request(`${BASE}/conversations/${id}/stream/cancel`, { method: "POST", headers: { authorization: `Bearer ${TOKENS[user]}` } });

test("cancel validates the id and requires a token", async () => {
  resetLimits();
  const seen: Seen = [];
  const bad = await handle(cancel("nope", USER_A), env(), deps(fake(seen, { user: userRow(USER_A) })));
  assert.equal(bad.status, 400);
  assert.equal(seen.length, 0);
  const anon = await handle(new Request(`${BASE}/conversations/${CONV_A}/stream/cancel`, { method: "POST" }), env(), deps(fake(seen, { user: userRow(USER_A) })));
  assert.equal(anon.status, 401);
});

test("user B cannot cancel a stream in user A's conversation", async () => {
  resetLimits();
  const seen: Seen = [];
  const res = await handle(cancel(CONV_A, USER_B), env(), deps(fake(seen, { user: userRow(USER_B) })));
  assert.equal(res.status, 404);
  assert.equal(await errorCode(res), "NOT_FOUND");
  assert.equal(seen.some(([sql]) => sql.startsWith("UPDATE") || sql.startsWith("INSERT")), false);
});

test("cancel on a shared conversation looks up the job by conversation only; db failure is 500", async () => {
  resetLimits();
  const seen: Seen = [];
  const res = await handle(cancel(CONV_SHARED, USER_B), env(), deps(fake(seen, {
    user: userRow(USER_B, COMPANY),
    data: (sql) => (sql.includes("FROM chat_jobs") ? [{ id: JOB }] : []),
  })));
  assert.equal(res.status, 200);
  const jobs = dataSeen(seen).find(([sql]) => sql.includes("FROM chat_jobs"));
  assert.ok(jobs);
  assert.match(jobs[0], /found\.company_id IS NOT NULL OR j\.user_id = \$2::uuid/);
  assert.deepEqual(jobs[1], [CONV_SHARED, USER_B, COMPANY]);

  resetLimits();
  const failing = await handle(cancel(CONV_A, USER_A), env(), deps(fake([], { user: userRow(USER_A), data: boom })));
  assert.equal(failing.status, 500);
});

// ---- stream active ----

const active = (id: string, user: string, query = "", headers: Record<string, string> = {}): Request =>
  get(`/conversations/${id}/messages/stream/active${query}`, user, headers);

const framesOf = (text: string): Record<string, unknown>[] =>
  text.split("\n\n").flatMap((block) => {
    const line = block.split("\n").find((item) => item.startsWith("data: "));
    return line ? [JSON.parse(line.slice(6)) as Record<string, unknown>] : [];
  });

const withJob = (events: (params: unknown[]) => Rows) => (sql: string, params: unknown[]): Rows => {
  if (sql.includes("chat_events")) return events(params);
  if (sql.includes("FROM chat_jobs")) return [{ id: JOB }];
  return [];
};

test("stream active validates the id and requires a token", async () => {
  resetLimits();
  const bad = await handle(active("nope", USER_A), env(), deps(fake([], { user: userRow(USER_A) })));
  assert.equal(bad.status, 400);
  const anon = await handle(new Request(`${BASE}/conversations/${CONV_A}/messages/stream/active`), env(), deps(fake([], { user: userRow(USER_A) })));
  assert.equal(anon.status, 401);
});

test("a cached session streams the active job from the after cursor", async () => {
  resetLimits();
  const e = env();
  await warm(USER_A, e);
  const reads: unknown[][] = [];
  const res = await handle(active(CONV_A, USER_A, "?after=5", { "last-event-id": "9" }), e, deps(fake([], {
    user: userRow(USER_A),
    data: withJob((params) => { reads.push(params); return [{ id: 6, type: "done", payload: "{\"awaiting\":{\"kind\":\"approval\"}}" }]; }),
  })));
  assert.equal(res.status, 200);
  assert.deepEqual(framesOf(await res.text()), [{ type: "done", operation: null, awaiting: { kind: "approval" }, seq: 6 }]);
  assert.deepEqual(reads, [[JOB, 5]]);
});

test("the last-event-id header resumes when no after query is given; junk restarts at 0", async () => {
  resetLimits();
  const e = env();
  await warm(USER_A, e);
  const reads: unknown[][] = [];
  const q = fake([], { user: userRow(USER_A), data: withJob((params) => { reads.push(params); return [{ id: 1, type: "cancelled", payload: null }]; }) });
  await (await handle(active(CONV_A, USER_A, "", { "last-event-id": "7" }), e, deps(q))).text();
  await (await handle(active(CONV_A, USER_A, "?after=x1"), e, deps(q))).text();
  assert.deepEqual(reads, [[JOB, 7], [JOB, 0]]);
});

test("a cached session gets 404 for another user's conversation and 204 with no job", async () => {
  resetLimits();
  const e = env();
  await warm(USER_B, e);
  const hidden = await handle(active(CONV_A, USER_B), e, deps(fake([], { user: userRow(USER_B) })));
  assert.equal(hidden.status, 404);

  resetLimits();
  await warm(USER_A, e);
  const idle = await handle(active(CONV_A, USER_A), e, deps(fake([], { user: userRow(USER_A), data: () => [] })));
  assert.equal(idle.status, 204);
  assert.equal(await idle.text(), "");
  assert.match(idle.headers.get("x-request-id") || "", /^req_/);
});

test("a cached session db failure is 500 without a second auth attempt", async () => {
  resetLimits();
  const e = env();
  await warm(USER_A, e);
  const seen: Seen = [];
  const res = await handle(active(CONV_A, USER_A), e, deps(fake(seen, { user: userRow(USER_A), data: boom })));
  // conversation lookup passes, job lookup throws
  assert.equal(res.status, 500);
  assert.equal(seen.some(([sql]) => isShared(sql) || isAuthOnly(sql)), false);
});

test("dev token streams for the seeded user and hides other users' conversations", async () => {
  resetLimits();
  const ok = await handle(active(CONV_A, USER_A), devEnv(USER_A), deps(fake([], {
    user: userRow(USER_A), data: withJob(() => [{ id: 3, type: "error", payload: { error: { code: "X" } } }]),
  })));
  assert.equal(ok.status, 200);
  assert.deepEqual(framesOf(await ok.text()), [{ type: "error", error: { code: "X" }, seq: 3 }]);

  resetLimits();
  const hidden = await handle(active(CONV_A, USER_B), devEnv(USER_B), deps(fake([], { user: userRow(USER_B) })));
  assert.equal(hidden.status, 404);

  resetLimits();
  const unseeded = await handle(active(CONV_A, USER_A), devEnv(USER_A), deps(async () => []));
  assert.equal(unseeded.status, 401);
});

test("the shared stream read returns 404 when the conversation is not visible", async () => {
  resetLimits();
  const res = await handle(active(CONV_A, USER_B), env(), deps(fake([], {
    user: userRow(USER_B), shared: () => [{ ...userRow(USER_B), hits: 1, conversation_id: null, job_id: null }],
  })));
  assert.equal(res.status, 404);

  resetLimits();
  const idle = await handle(active(CONV_A, USER_A), env(), deps(fake([], {
    user: userRow(USER_A), shared: () => [{ ...userRow(USER_A), hits: 1, conversation_id: CONV_A, job_id: "" }],
  })));
  assert.equal(idle.status, 204);
});

test("when the shared stream read fails it falls back to scoped lookups", async () => {
  resetLimits();
  const ok = await handle(active(CONV_A, USER_A), env(), deps(fake([], {
    user: userRow(USER_A), shared: boom, data: withJob(() => [{ id: 2, type: "cancelled", payload: {} }]),
  })));
  assert.equal(ok.status, 200);
  assert.deepEqual(framesOf(await ok.text()), [{ type: "cancelled", seq: 2 }]);

  resetLimits();
  const hidden = await handle(active(CONV_A, USER_B), env(), deps(fake([], { user: userRow(USER_B), shared: boom })));
  assert.equal(hidden.status, 404);

  resetLimits();
  const anon = await handle(active(CONV_A, USER_A), env(), deps(async (sql) => {
    if (isShared(sql)) throw new Error("db down");
    return [];
  }));
  assert.equal(anon.status, 401);

  resetLimits();
  const failing = await handle(active(CONV_A, USER_A), env(), deps(async (sql) => {
    if (isAuthOnly(sql)) return [userRow(USER_A)];
    throw new Error("db down");
  }));
  assert.equal(failing.status, 500);
});

// ---- event polling ----

test("polling sleeps between empty polls and stops after SSE_MAX_POLLS", async () => {
  resetLimits();
  const e = env({ SSE_MAX_POLLS: "3" });
  await warm(USER_A, e);
  const sleeps: number[] = [];
  const reads: unknown[][] = [];
  const res = await handle(active(CONV_A, USER_A), e, deps(fake([], {
    user: userRow(USER_A),
    data: withJob((params) => {
      reads.push(params);
      return reads.length === 1 ? [{ id: 4, type: "token", payload: "{bad json" }, { id: 5, type: "custom", payload: { a: 1 } }] : [];
    }),
  }), async (ms) => { sleeps.push(ms); }));
  const text = await res.text();
  assert.ok(text.startsWith("retry: 400\n\n"));
  assert.deepEqual(framesOf(text), [{ type: "token", text: "", seq: 4 }, { type: "custom", a: 1, seq: 5 }]);
  assert.deepEqual(reads, [[JOB, 0], [JOB, 5], [JOB, 5]]);
  assert.deepEqual(sleeps, [250, 250]);
});

test("idle polls back off to one second so a waiting stream costs fewer Neon reads", async () => {
  resetLimits();
  const e = env({ SSE_MAX_POLLS: "8" });
  await warm(USER_A, e);
  const sleeps: number[] = [];
  let reads = 0;
  const res = await handle(active(CONV_A, USER_A), e, deps(fake([], {
    user: userRow(USER_A),
    data: withJob(() => { reads += 1; return reads === 3 ? [{ id: 9, type: "token", payload: { text: "a" } }] : []; }),
  }), async (ms) => { sleeps.push(ms); }));
  await res.text();
  assert.deepEqual(sleeps, [250, 500, 250, 250, 500, 1000, 1000]);
});

test("a full page of events is read again at once, from the last id", async () => {
  resetLimits();
  const e = env({ SSE_MAX_POLLS: "3" });
  await warm(USER_A, e);
  const sleeps: number[] = [];
  const reads: Array<[string, unknown[]]> = [];
  const page = Array.from({ length: 200 }, (_, i) => ({ id: i + 1, type: "token", payload: { text: "x" } }));
  const res = await handle(active(CONV_A, USER_A), e, deps(fake([], {
    user: userRow(USER_A),
    data: (sql, params) => {
      if (sql.includes("chat_events")) {
        reads.push([sql, params]);
        return reads.length === 1 ? page : [{ id: 201, type: "done", payload: {} }];
      }
      return sql.includes("FROM chat_jobs") ? [{ id: JOB }] : [];
    },
  }), async (ms) => { sleeps.push(ms); }));
  assert.equal(framesOf(await res.text()).length, 201);
  assert.match(reads[0][0], /ORDER BY id LIMIT 200$/);
  assert.deepEqual(reads.map(([, params]) => params), [[JOB, 0], [JOB, 200]]);
  assert.deepEqual(sleeps, []);
});

test("a failing event read ends the stream with an INTERNAL error frame", async () => {
  resetLimits();
  const e = env();
  await warm(USER_A, e);
  const res = await handle(active(CONV_A, USER_A), e, deps(fake([], {
    user: userRow(USER_A),
    data: (sql) => {
      if (sql.includes("chat_events")) throw new Error("db down");
      return sql.includes("FROM chat_jobs") ? [{ id: JOB }] : [];
    },
  })));
  assert.equal(res.status, 200);
  assert.deepEqual(framesOf(await res.text()), [{ type: "error", error: { code: "INTERNAL", message: "internal error", details: null } }]);
});

test("a client that hangs up stops polling", async () => {
  resetLimits();
  const e = env({ SSE_MAX_POLLS: "50" });
  await warm(USER_A, e);
  let reads = 0;
  const res = await handle(active(CONV_A, USER_A), e, deps(fake([], {
    user: userRow(USER_A),
    data: withJob(() => { reads += 1; return []; }),
  }), () => new Promise((r) => setImmediate(r))));
  const reader = res.body!.getReader();
  await reader.read();
  await reader.cancel();
  await new Promise((r) => setTimeout(r, 10));
  const atCancel = reads;
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(reads <= atCancel + 1, `kept polling after cancel: ${atCancel} -> ${reads}`);
  assert.ok(reads < 50);
});

// ---- stream message (core-owned) ----

test("a 202 from core without a usable job id is a 500, and the stream is not opened", async () => {
  for (const body of ["not json", JSON.stringify({ data: { result: { value: { jobId: "nope" } } } })]) {
    resetLimits();
    let events = 0;
    const res = await handle(new Request(`${BASE}/conversations/${CONV_A}/messages/stream`, {
      method: "POST", headers: { authorization: "Bearer tok-a", "content-type": "application/json" }, body: "{}",
    }), env({ CORE: { async fetch() { return new Response(body, { status: 202 }); } } }),
    deps(async () => { events += 1; return []; }));
    assert.equal(res.status, 500);
    assert.equal(await errorCode(res), "INTERNAL");
    assert.equal(events, 0);
  }
});
