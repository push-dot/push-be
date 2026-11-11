import assert from "node:assert/strict";
import { test } from "node:test";

import { handle, type CoreEnv, type Deps } from "../src/handler.ts";
import { resetLimits } from "../src/ratelimit.ts";

const USER = "12345678-1234-5678-1234-567812345678";
const POSTING = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const BOT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PUSH = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CONV = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const NOW = new Date("2026-10-18T00:00:00Z");

function env(): CoreEnv {
  return { APP_ENV: "production", MANAGED_AI: "1" };
}

function deps(query: Deps["query"]): Deps {
  return { query, now: () => NOW };
}

type Call = { sql: string; params: unknown[] };

function authed(seen: Call[], plan: string, extra?: Deps["query"]): Deps["query"] {
  return async (sql, params = []) => {
    seen.push({ sql, params: params ?? [] });
    if (sql.includes("rate_limits")) return { rows: [{ hits: 1 }], rowCount: 1 };
    if (sql.includes("access_tokens")) {
      return {
        rows: [{
          id: USER, display_name: "Ada", locale: "ko", plan,
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
      return { rows: [{ is_employer: false, display_name: "Ada" }], rowCount: 1 };
    }
    if (extra) return extra(sql, params);
    if (sql.includes("count(*)")) return { rows: [{ total: 0, n: 0 }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
}

const get = (path: string): Request => new Request("https://core.example" + path, {
  headers: { authorization: "Bearer secret-token" },
});

const post = (path: string, body: unknown, key?: string): Request => new Request("https://core.example" + path, {
  method: "POST",
  headers: {
    authorization: "Bearer secret-token",
    "content-type": "application/json",
    ...(key ? { "idempotency-key": key } : {}),
  },
  body: JSON.stringify(body),
});

const patch = (path: string, body: unknown): Request => new Request("https://core.example" + path, {
  method: "PATCH",
  headers: { authorization: "Bearer secret-token", "content-type": "application/json" },
  body: JSON.stringify(body),
});

const del = (path: string): Request => new Request("https://core.example" + path, {
  method: "DELETE",
  headers: { authorization: "Bearer secret-token" },
});

test("GET /api/v1/bots creates push bot lazily and lists company bots", async () => {
  resetLimits();
  const seen: Call[] = [];
  const res = await handle(get("/api/v1/bots"), env(), deps(authed(seen, "PRO", async (sql) => {
    if (sql.includes("INSERT INTO bots") && sql.includes("'push'")) return { rows: [], rowCount: 1 };
    if (sql.includes("FROM bots b") && sql.includes("ORDER BY")) {
      return {
        rows: [
          { id: PUSH, kind: "push", company_id: null, company_name: "", posting_id: null, posting_url: null,
            display_name: "Push Bot", avatar_key: null, mascot_key: null, notifications_muted: false,
            revision: 1, created_at: NOW.toISOString(), updated_at: NOW.toISOString(),
            last_message_preview: "hello", unread: true, status: "DONE" },
        ],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 0 };
  })));
  assert.equal(res.status, 200);
  const body = await res.json() as { data: { kind: string; displayName: string }[] };
  assert.equal(body.data[0].kind, "push");
  assert.equal(body.data[0].displayName, "Push Bot");
  assert.equal(seen.some((c) => c.sql.includes("INSERT INTO bots")), true);
});

test("POST /api/v1/bots returns BOT_LIMIT on FREE plan", async () => {
  resetLimits();
  const res = await handle(
    post("/api/v1/bots", { companyName: "Acme" }, "11111111-1111-4111-8111-111111111111"),
    env(),
    deps(authed([], "FREE", async (sql) => {
      if (sql.includes("INSERT INTO bots") && sql.includes("'push'")) return { rows: [], rowCount: 1 };
      if (sql.includes("count(*)") && sql.includes("kind = 'company'")) return { rows: [{ n: 3 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    })),
  );
  assert.equal(res.status, 403);
  const body = await res.json() as { error: { code: string } };
  assert.equal(body.error.code, "BOT_LIMIT");
});

test("POST /api/v1/bots creates a company bot when under limit", async () => {
  resetLimits();
  const res = await handle(
    post("/api/v1/bots", { companyName: "Acme", displayName: "Acme coach" }, "22222222-2222-4222-8222-222222222222"),
    env(),
    deps(authed([], "PRO", async (sql) => {
      if (sql.includes("INSERT INTO bots") && sql.includes("'push'")) return { rows: [], rowCount: 1 };
      if (sql.includes("count(*)") && sql.includes("kind = 'company'")) return { rows: [{ n: 1 }], rowCount: 1 };
      if (sql.includes("INSERT INTO bots") && sql.includes("'company'")) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    })),
  );
  assert.equal(res.status, 201);
  const body = await res.json() as { data: { kind: string; displayName: string } };
  assert.equal(body.data.kind, "company");
  assert.equal(body.data.displayName, "Acme coach");
});

test("DELETE /api/v1/bots/:id blocks the push bot", async () => {
  resetLimits();
  const res = await handle(del(`/api/v1/bots/${PUSH}`), env(), deps(authed([], "PRO", async (sql) => {
    if (sql.includes("SELECT kind FROM bots")) return { rows: [{ kind: "push" }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  })));
  assert.equal(res.status, 403);
  const body = await res.json() as { error: { code: string } };
  assert.equal(body.error.code, "DEFAULT_BOT_PROTECTED");
});

test("DELETE /api/v1/bots/:id soft-deletes a company bot", async () => {
  resetLimits();
  const seen: Call[] = [];
  const res = await handle(del(`/api/v1/bots/${BOT}`), env(), deps(authed(seen, "PRO", async (sql) => {
    if (sql.includes("SELECT kind FROM bots")) return { rows: [{ kind: "company" }], rowCount: 1 };
    if (sql.includes("UPDATE bots SET deleted_at")) return { rows: [{ id: BOT }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  })));
  assert.equal(res.status, 204);
  assert.match(seen.find((c) => c.sql.includes("UPDATE bots SET deleted_at"))!.sql, /deleted_at/);
});

test("POST /api/v1/bots/link-preview returns found for a posting URL", async () => {
  resetLimits();
  const res = await handle(
    post("/api/v1/bots/link-preview", { url: `https://app.push.local/postings/${POSTING}` }, "33333333-3333-4333-8333-333333333333"),
    env(),
    deps(authed([], "PRO", async (sql, params) => {
      if (sql.includes("FROM job_postings") && (params ?? []).includes(POSTING)) {
        return { rows: [{ id: POSTING, company: "Acme", title: "Backend" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    })),
  );
  assert.equal(res.status, 200);
  const body = await res.json() as { data: { status: string; postingId: string } };
  assert.equal(body.data.status, "found");
  assert.equal(body.data.postingId, POSTING);
});

test("POST /api/v1/bots/link-preview returns not_a_posting", async () => {
  resetLimits();
  const res = await handle(
    post("/api/v1/bots/link-preview", { url: "https://example.com/jobs/1" }, "44444444-4444-4444-8444-444444444444"),
    env(),
    deps(authed([], "PRO", async () => ({ rows: [], rowCount: 0 }))),
  );
  assert.equal(res.status, 200);
  const body = await res.json() as { data: { status: string } };
  assert.equal(body.data.status, "not_a_posting");
});

test("GET /api/v1/bots/companies/search returns open posting counts", async () => {
  resetLimits();
  const res = await handle(get("/api/v1/bots/companies/search?q=ac"), env(), deps(authed([], "PRO", async (sql) => {
    if (sql.includes("GROUP BY p.company")) {
      return { rows: [{ name: "Acme", open_posting_count: 4 }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  })));
  assert.equal(res.status, 200);
  const body = await res.json() as { data: { name: string; openPostingCount: number }[] };
  assert.deepEqual(body.data[0], { name: "Acme", openPostingCount: 4 });
});

test("POST /api/v1/bots/:id/conversations creates a conversation with bot_id", async () => {
  resetLimits();
  const seen: Call[] = [];
  const res = await handle(
    post(`/api/v1/bots/${BOT}/conversations`, { title: "첫 채팅" }, "55555555-5555-4555-8555-555555555555"),
    env(),
    deps(authed(seen, "PRO", async (sql) => {
      if (sql.includes("FROM bots b") && sql.includes("deleted_at IS NULL")) {
        return { rows: [{ id: BOT, kind: "company", company_id: null, company_name: "Acme", posting_id: POSTING, revision: 1 }], rowCount: 1 };
      }
      if (sql.includes("user_consents")) return { rows: [{ reference_data: true }], rowCount: 1 };
      if (sql.includes("INSERT INTO conversations") && sql.includes("bot_id")) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    })),
  );
  assert.equal(res.status, 201);
  const insert = seen.find((c) => c.sql.includes("INSERT INTO conversations"))!;
  assert.ok(insert.sql.includes("bot_id"));
});

test("GET /api/v1/bots/:id/conversations lists conversations", async () => {
  resetLimits();
  const res = await handle(get(`/api/v1/bots/${BOT}/conversations`), env(), deps(authed([], "PRO", async (sql) => {
    if (sql.includes("FROM bots b")) {
      return { rows: [{ id: BOT, kind: "company", display_name: "Acme", revision: 1 }], rowCount: 1 };
    }
    if (sql.includes("FROM conversations") && sql.includes("bot_id")) {
      return {
        rows: [{ id: CONV, revision: 1, application_id: null, title: "t", pinned: false, created_at: NOW.toISOString(), updated_at: NOW.toISOString() }],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 0 };
  })));
  assert.equal(res.status, 200);
  const body = await res.json() as { data: { id: string }[] };
  assert.equal(body.data[0].id, CONV);
});

test("POST /api/v1/bots/:id/read upserts a read marker", async () => {
  resetLimits();
  const seen: Call[] = [];
  const res = await handle(
    post(`/api/v1/bots/${BOT}/read`, {}, "66666666-6666-4666-8666-666666666666"),
    env(),
    deps(authed(seen, "PRO", async (sql) => {
      if (sql.includes("FROM bots b")) return { rows: [{ id: BOT, kind: "company", revision: 1 }], rowCount: 1 };
      if (sql.includes("bot_read_markers")) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    })),
  );
  assert.equal(res.status, 200);
  assert.match(seen.find((c) => c.sql.includes("bot_read_markers"))!.sql, /INSERT INTO bot_read_markers/);
});

test("GET /api/v1/bots/:id returns one bot", async () => {
  resetLimits();
  const res = await handle(get(`/api/v1/bots/${BOT}`), env(), deps(authed([], "PRO", async (sql) => {
    if (sql.includes("FROM bots b") && sql.includes("AND b.id")) {
      return {
        rows: [{
          id: BOT, kind: "company", company_id: null, company_name: "Acme", posting_id: null, posting_url: null,
          display_name: "Acme", avatar_key: null, mascot_key: null, notifications_muted: false, revision: 1,
          created_at: NOW.toISOString(), updated_at: NOW.toISOString(),
          last_message_preview: "", unread: false, status: "DONE",
        }],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 0 };
  })));
  assert.equal(res.status, 200);
  const body = await res.json() as { data: { id: string } };
  assert.equal(body.data.id, BOT);
});

test("PATCH /api/v1/bots/:id updates name and mute flag", async () => {
  resetLimits();
  const res = await handle(patch(`/api/v1/bots/${BOT}`, { expectedRevision: 1, displayName: "New", notificationsMuted: true }), env(),
    deps(authed([], "PRO", async (sql) => {
      if (sql.includes("FROM bots b") && !sql.includes("UPDATE")) {
        return {
          rows: [{
            id: BOT, kind: "company", company_id: null, company_name: "Acme", posting_id: null, posting_url: null,
            display_name: "Old", notifications_muted: false, avatar_key: null, mascot_key: null, revision: 1,
            created_at: NOW.toISOString(), updated_at: NOW.toISOString(),
          }],
          rowCount: 1,
        };
      }
      if (sql.includes("UPDATE bots SET revision")) {
        return {
          rows: [{
            id: BOT, kind: "company", company_id: null, company_name: "Acme", posting_id: null, posting_url: null,
            display_name: "New", notifications_muted: true, avatar_key: null, mascot_key: null, revision: 2,
            created_at: NOW.toISOString(), updated_at: NOW.toISOString(),
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    })));
  assert.equal(res.status, 200);
  const body = await res.json() as { data: { displayName: string; notificationsMuted: boolean } };
  assert.equal(body.data.displayName, "New");
  assert.equal(body.data.notificationsMuted, true);
});
