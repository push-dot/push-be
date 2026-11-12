import assert from "node:assert/strict";
import { test } from "node:test";

import type { Transaction } from "../src/db.ts";
import { handle, type CoreEnv, type Deps } from "../src/handler.ts";
import { uuid5Url } from "../src/http.ts";
import { resetLimits } from "../src/ratelimit.ts";

const USER = "12345678-1234-5678-1234-567812345678";
const POSTING = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const BOT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const NOW = new Date("2026-10-18T00:00:00Z");

const env = (): CoreEnv => ({ APP_ENV: "production", MANAGED_AI: "1" });
const deps = (query: Deps["query"]): Deps => ({ query, now: () => NOW });

type Call = { sql: string; params: unknown[] };
type Rows = Record<string, unknown>[];

const botRow = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: BOT, kind: "company", company_id: null, company_name: "Acme", color: "teal", posting_id: POSTING, posting_url: null,
  display_name: "Acme", avatar_key: null, mascot_key: null, notifications_muted: false, revision: 1,
  created_at: NOW.toISOString(), updated_at: NOW.toISOString(), last_message_preview: "", unread: false, status: "DONE",
  ...over,
});

const authed = (seen: Call[], plan: string, answer: (sql: string, params: unknown[]) => Rows | null = () => null): Deps["query"] =>
  async (sql, params = []) => {
    seen.push({ sql, params });
    if (sql.includes("set_config") && sql.includes("lock_timeout")) return { rows: [{}], rowCount: 1 };
    if (sql.includes("FOR NO KEY UPDATE")) return { rows: [{ id: USER }], rowCount: 1 };
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
    const rows = answer(sql, params) ?? [];
    return { rows, rowCount: rows.length };
  };

type World = { consent?: boolean; posting?: boolean; existing?: string; count?: number; bot?: Record<string, unknown> | null; insertWins?: boolean };

const world = (w: World = {}) => (sql: string): Rows | null => {
  if (sql.includes("user_consents")) return [{ reference_data: w.consent ?? true }];
  if (sql.includes("FROM job_postings")) return w.posting === false ? [] : [{ company: "Acme" }];
  if (sql.includes("bot_company_key")) return w.existing ? [{ id: w.existing }] : [];
  if (sql.includes("count(*)")) return [{ n: w.count ?? 0 }];
  if (sql.includes("INSERT INTO bots") && sql.includes("'company'")) return w.insertWins === false ? [] : [{ id: BOT }];
  if (sql.includes("UPDATE bots SET revision")) return [{ id: BOT }];
  if (sql.includes("DELETE FROM bots")) return w.bot === null ? [] : [{ id: BOT }];
  if (sql.includes("FROM bots b")) return w.bot === null ? [] : [w.bot ?? botRow()];
  return null;
};

const request = (method: string, path: string, body?: unknown): Request => new Request("https://core.example" + path, {
  method,
  headers: {
    authorization: "Bearer secret-token",
    "content-type": "application/json",
    ...(method === "POST" ? { "idempotency-key": crypto.randomUUID() } : {}),
  },
  body: body === undefined ? undefined : JSON.stringify(body),
});

const call = async (method: string, path: string, body: unknown, w: World = {}, plan = "PRO", extra: Partial<Deps> = {}) => {
  resetLimits();
  const seen: Call[] = [];
  const res = await handle(request(method, path, body), env(), { ...deps(authed(seen, plan, world(w))), ...extra });
  const json = res.status === 204 ? null : await res.json() as {
    data?: Record<string, unknown> & Record<string, unknown>[];
    error?: { code: string; details: Record<string, unknown> };
  };
  return { res, json, seen };
};

const wrote = (seen: Call[], marker: string): boolean => seen.some((c) => c.sql.includes(marker));

test("GET /bots makes the Push Bot on first use and lists it", async () => {
  const { res, json, seen } = await call("GET", "/api/v1/bots", undefined, { bot: botRow({ kind: "push", display_name: "Push Bot", company_name: "" }) });
  assert.equal(res.status, 200);
  assert.equal(json!.data![0].kind, "push");
  assert.equal(json!.data![0].color, null);
  assert.ok(wrote(seen, "INSERT INTO bots"));
});

test("POST /bots creates a company bot from a posting", async () => {
  const { res, json, seen } = await call("POST", "/api/v1/bots", { postingId: POSTING, displayName: "Acme coach", color: "violet" });
  assert.equal(res.status, 201);
  assert.equal(json!.data!.id, BOT);
  const insert = seen.find((c) => c.sql.includes("INSERT INTO bots") && c.sql.includes("'company'"))!;
  assert.deepEqual(insert.params.slice(2, 6), ["Acme", POSTING, "Acme coach", "violet"]);
  assert.ok(!insert.sql.includes("company_id"));
});

test("POST /bots answers 200 with the bot the caller already has for that company", async () => {
  const { res, json, seen } = await call("POST", "/api/v1/bots", { postingId: POSTING }, { existing: BOT, count: 3 }, "FREE");
  assert.equal(res.status, 200);
  assert.equal(json!.data!.id, BOT);
  assert.ok(!wrote(seen, "INSERT INTO bots"));
});

test("POST /bots answers 200 when a parallel create for the same company won", async () => {
  let lookups = 0;
  resetLimits();
  const res = await handle(request("POST", "/api/v1/bots", { postingId: POSTING }), env(), deps(authed([], "ULTRA", (sql) => {
    if (sql.includes("bot_company_key")) return lookups++ === 0 ? [] : [{ id: BOT }];
    return world({ insertWins: false })(sql);
  })));
  assert.equal(res.status, 200);
});

test("POST /bots answers BOT_LIMIT at the plan limit", async () => {
  const { res, json } = await call("POST", "/api/v1/bots", { postingId: POSTING }, { count: 3 }, "FREE");
  assert.equal(res.status, 403);
  assert.equal(json!.error!.code, "BOT_LIMIT");
  assert.deepEqual(json!.error!.details, { limit: 3, plan: "FREE" });
  assert.equal((await call("POST", "/api/v1/bots", { postingId: POSTING }, { count: 19 })).res.status, 201);
});

test("POST /bots refuses every body key but postingId, displayName and color", async () => {
  for (const [field, body] of Object.entries({
    companyName: { postingId: POSTING, companyName: "Acme" },
    companyId: { postingId: POSTING, companyId: BOT },
    postingUrl: { postingId: POSTING, postingUrl: "https://example.com/jobs/1" },
    postingId: { displayName: "Acme" },
    color: { postingId: POSTING, color: "magenta" },
    displayName: { postingId: POSTING, displayName: "" },
  })) {
    const { res, json, seen } = await call("POST", "/api/v1/bots", body);
    assert.equal(res.status, 400, field);
    assert.equal(json!.error!.details.field, field);
    assert.ok(!wrote(seen, "INSERT INTO bots"));
  }
});

test("POST /bots needs reference-data consent and an existing posting", async () => {
  const refused = await call("POST", "/api/v1/bots", { postingId: POSTING }, { consent: false });
  assert.equal(refused.res.status, 403);
  assert.equal(refused.json!.error!.code, "CONSENT_REQUIRED");
  assert.ok(!wrote(refused.seen, "INSERT INTO bots"));
  const missing = await call("POST", "/api/v1/bots", { postingId: POSTING }, { posting: false });
  assert.equal(missing.res.status, 404);
});

test("POST /bots answers 429 RATE_LIMITED on a lock timeout", async () => {
  const transaction: Transaction = async (work) => work(async (sql) => {
    if (sql.includes("FROM job_postings")) return { rows: [{ company: "Acme" }], rowCount: 1 };
    if (sql.includes("set_config")) return { rows: [{}], rowCount: 1 };
    throw Object.assign(new Error("lock timeout"), { code: "55P03" });
  });
  const { res, json } = await call("POST", "/api/v1/bots", { postingId: POSTING }, {}, "FREE", { transaction });
  assert.equal(res.status, 429);
  assert.equal(json!.error!.code, "RATE_LIMITED");
  assert.equal(json!.error!.details.retryAfterSec, 1);
});

test("the literal id push addresses the caller's Push Bot on every bot route", async () => {
  const pushId = await uuid5Url(`push:bot:${USER}`);
  const push = botRow({ id: pushId, kind: "push", display_name: "Push Bot", company_name: "" });
  for (const [method, path, body, status] of [
    ["GET", "/api/v1/bots/push", undefined, 200],
    ["PATCH", "/api/v1/bots/push", { expectedRevision: 1, notificationsMuted: true }, 200],
    ["POST", "/api/v1/bots/push/read", {}, 200],
    ["DELETE", "/api/v1/bots/push/transcript", undefined, 204],
    ["DELETE", "/api/v1/bots/push", undefined, 403],
  ] as const) {
    const { res, seen } = await call(method, path, body, { bot: push });
    assert.equal(res.status, status, `${method} ${path}`);
    const ensured = seen.find((c) => c.sql.includes("INSERT INTO bots") && c.sql.includes("'push'"));
    assert.equal(ensured?.params[0], pushId, `${method} ${path} makes the Push Bot when it is missing`);
    assert.ok(seen.some((c) => c.sql.includes("FROM bots b WHERE b.id = $1") && c.params[0] === pushId));
  }
});

test("DELETE /bots/{id} deletes a company bot's row and protects the Push Bot", async () => {
  const company = await call("DELETE", `/api/v1/bots/${BOT}`, undefined);
  assert.equal(company.res.status, 204);
  assert.deepEqual(company.seen.find((c) => c.sql.includes("DELETE FROM bots"))!.params, [BOT, USER]);
  const push = await call("DELETE", `/api/v1/bots/${BOT}`, undefined, { bot: botRow({ kind: "push" }) });
  assert.equal(push.res.status, 403);
  assert.equal(push.json!.error!.code, "DEFAULT_BOT_PROTECTED");
  assert.ok(!wrote(push.seen, "DELETE FROM bots"));
  assert.equal((await call("DELETE", `/api/v1/bots/${BOT}`, undefined, { bot: null })).res.status, 404);
});

test("DELETE /bots/{id}/transcript deletes the bot's thread and keeps the bot", async () => {
  const { res, seen } = await call("DELETE", `/api/v1/bots/${BOT}/transcript`, undefined);
  assert.equal(res.status, 204);
  assert.deepEqual(seen.find((c) => c.sql.includes("DELETE FROM conversations"))!.params, [BOT, USER]);
  assert.ok(!wrote(seen, "DELETE FROM bots"));
  assert.equal((await call("DELETE", `/api/v1/bots/${BOT}/transcript`, undefined, { bot: null })).res.status, 404);
});

test("PATCH /bots/{id} changes name, mute and colour", async () => {
  const { res, json, seen } = await call("PATCH", `/api/v1/bots/${BOT}`, { expectedRevision: 1, displayName: "New", notificationsMuted: true, color: "coral" });
  assert.equal(res.status, 200);
  assert.equal(json!.data!.id, BOT);
  assert.deepEqual(seen.find((c) => c.sql.includes("UPDATE bots SET revision"))!.params.slice(2, 5), ["New", true, "coral"]);
});

test("PATCH /bots/{id} refuses image keys, an unknown colour, a stale revision, and a rename of the Push Bot", async () => {
  for (const [field, body] of Object.entries({
    avatarKey: { expectedRevision: 1, avatarKey: "a.png" },
    mascotKey: { expectedRevision: 1, mascotKey: "violet" },
    color: { expectedRevision: 1, color: "magenta" },
  })) {
    const { res, json } = await call("PATCH", `/api/v1/bots/${BOT}`, body);
    assert.equal(res.status, 400, field);
    assert.equal(json!.error!.details.field, field);
  }
  const stale = await call("PATCH", `/api/v1/bots/${BOT}`, { expectedRevision: 4 });
  assert.equal(stale.res.status, 409);
  assert.deepEqual(stale.json!.error!.details, { currentRevision: 1 });
  for (const body of [{ expectedRevision: 1, displayName: "Mine" }, { expectedRevision: 1, color: "sky" }]) {
    const { res, seen } = await call("PATCH", `/api/v1/bots/${BOT}`, body, { bot: botRow({ kind: "push" }) });
    assert.equal(res.status, 400);
    assert.ok(!wrote(seen, "UPDATE bots"));
  }
});

test("POST /bots/{id}/read upserts a read marker", async () => {
  const { res, json, seen } = await call("POST", `/api/v1/bots/${BOT}/read`, {});
  assert.equal(res.status, 200);
  assert.equal(json!.data!.readAt, NOW.toISOString());
  assert.ok(wrote(seen, "INSERT INTO bot_read_markers"));
  assert.equal((await call("POST", `/api/v1/bots/${BOT}/read`, {}, { bot: null })).res.status, 404);
});

test("POST /bots/link-preview resolves a posting URL and nothing else", async () => {
  resetLimits();
  const found = await handle(request("POST", "/api/v1/bots/link-preview", { url: `https://app.push.local/postings/${POSTING}` }), env(),
    deps(authed([], "PRO", (sql, params) => (sql.includes("FROM job_postings") && params.includes(POSTING)
      ? [{ id: POSTING, company: "Acme", title: "Backend" }] : null))));
  assert.deepEqual((await found.json() as { data: unknown }).data, { status: "found", company: "Acme", title: "Backend", postingId: POSTING });
  resetLimits();
  const other = await handle(request("POST", "/api/v1/bots/link-preview", { url: "https://example.com/jobs/1" }), env(), deps(authed([], "PRO")));
  assert.deepEqual((await other.json() as { data: unknown }).data, { status: "not_a_posting" });
});

test("the removed bot routes answer 404", async () => {
  for (const [method, path] of [
    ["GET", `/api/v1/bots/${BOT}/conversations`],
    ["POST", `/api/v1/bots/${BOT}/conversations`],
    ["GET", `/api/v1/bots/${BOT}/library`],
    ["GET", "/api/v1/bots/companies/search?q=ac"],
  ] as const) {
    const { res, seen } = await call(method, path, method === "POST" ? { title: "t" } : undefined);
    assert.equal(res.status, 404, `${method} ${path}`);
    assert.ok(!wrote(seen, "INSERT INTO conversations"));
  }
});
