import assert from "node:assert/strict";
import { test } from "node:test";

import type { Transaction } from "../src/db.ts";
import { handle, type CoreEnv, type Deps } from "../src/handler.ts";
import { uuid5Url } from "../src/http.ts";
import { resetLimits } from "../src/ratelimit.ts";
import { snippetOf } from "../src/routes/bots.ts";

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
  created_at: NOW.toISOString(), updated_at: NOW.toISOString(),
  ...over,
});

/** A row of bot_state_v for `bot`: no thread, nothing running, nothing unread, unless `state` says so. */
const stateRow = (bot: Record<string, unknown>, state: Record<string, unknown> = {}): Record<string, unknown> => {
  const { id, company_id: _companyId, ...own } = bot;
  return {
    bot_id: id, user_id: USER, ...own, thread_id: null,
    last_message_at: null, last_message_preview: null, last_message_from_bot: null,
    card_id: null, card_title: null, card_for: null, card_at: null, card_expires_at: null,
    job_id: null, job_at: null, job_phase: null, job_text: null, job_recent_text: null, job_ahead: null,
    last_activity_at: bot.created_at, unread: false,
    ...state,
  };
};

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

type World = {
  consent?: boolean; posting?: Record<string, unknown> | false; existing?: string; count?: number;
  bot?: Record<string, unknown> | null; state?: Record<string, unknown>; insertWins?: boolean; hits?: Rows;
};

const POSTING_ROW = { id: POSTING, company: "Acme", title: "Backend", deadline: "2026-11-20", career_min: 3, career_max: null, location: "Seoul" };

const world = (w: World = {}) => (sql: string): Rows | null => {
  if (sql.includes("user_consents")) return [{ reference_data: w.consent ?? true }];
  if (sql.includes("FROM job_postings")) return w.posting === false ? [] : [{ ...POSTING_ROW, ...w.posting }];
  if (sql.includes("WITH hits")) return w.hits ?? [{ total: 0, id: null }];
  if (sql.includes("bot_state_v")) return w.bot === null ? [] : [stateRow(w.bot ?? botRow(), w.state)];
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
    limit?: Record<string, unknown>;
    page?: Record<string, unknown>;
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

test("GET /bots says how many company bots the plan allows and how many exist", async () => {
  const table = { FREE: 3, PRO: 20, ULTRA: null };
  for (const [plan, limit] of [
    ["FREE", { plan: "FREE", max: 3, used: 1, table }],
    ["ULTRA", { plan: "ULTRA", max: null, used: 1, table }],
    ["", { plan: "FREE", max: 3, used: 1, table }],
  ] as const) {
    assert.deepEqual((await call("GET", "/api/v1/bots", undefined, {}, plan)).json!.limit, limit, plan);
  }
  const push = await call("GET", "/api/v1/bots", undefined, { bot: botRow({ kind: "push" }) }, "FREE");
  assert.equal(push.json!.limit!.used, 0, "the Push Bot is not counted");
});

test("GET /bots?postingId= answers the caller's bot for that posting's company, or nothing, and no limit", async () => {
  const found = await call("GET", `/api/v1/bots?postingId=${POSTING}`, undefined, { existing: BOT });
  assert.deepEqual([found.res.status, found.json!.data!.map((bot) => bot.id), found.json!.limit], [200, [BOT], undefined]);
  assert.ok(!wrote(found.seen, "INSERT INTO bots"));
  for (const w of [{}, { posting: false }, { existing: BOT, posting: { company: "   " } }] as World[]) {
    assert.deepEqual((await call("GET", `/api/v1/bots?postingId=${POSTING}`, undefined, w)).json, { data: [] });
  }
  const bad = await call("GET", "/api/v1/bots?postingId=nope", undefined);
  assert.deepEqual([bad.res.status, bad.json!.error!.details.field], [400, "postingId"]);
});

test("a bot's activity is its open card, else what its run is doing, else nothing", async () => {
  const at = "2026-10-18T00:01:00Z";
  const card = { card_id: POSTING, card_title: "이 변경을 이력서에 반영할까요?", card_for: "confirm", card_at: at, card_expires_at: null };
  const run = (phase: string, more: Record<string, unknown> = {}) => ({ job_id: POSTING, job_at: at, job_phase: phase, ...more });
  const waiting = { phase: "waiting", since: at, for: "confirm", cardId: POSTING, cardTitle: card.card_title, expiresAt: null };
  for (const [name, state, activity, status] of [
    ["idle", {}, null, "DONE"],
    ["queued", run("queued", { job_ahead: 2 }), { phase: "queued", since: at, ahead: 2 }, "RUNNING"],
    ["thinking", run("thinking"), { phase: "thinking", since: at, label: null }, "RUNNING"],
    ["thinking after a working step", run("thinking", { job_text: "생각 중", job_recent_text: "공고 요건을 살펴보는 중" }), { phase: "thinking", since: at, label: "공고 요건을 살펴보는 중" }, "RUNNING"],
    ["working", run("working", { job_text: "경력 섹션 고치는 중", job_recent_text: "경력 섹션 고치는 중" }), { phase: "working", since: at, label: "경력 섹션 고치는 중" }, "RUNNING"],
    ["card", card, waiting, "NEEDS_APPROVAL"],
    ["card and a run", { ...card, ...run("working", { job_text: "x" }) }, waiting, "NEEDS_APPROVAL"],
    ["answer card", { ...card, card_for: "answer", card_expires_at: "2026-10-18T00:11:00Z" }, { ...waiting, for: "answer", expiresAt: "2026-10-18T00:11:00Z" }, "NEEDS_APPROVAL"],
  ] as const) {
    const { json } = await call("GET", `/api/v1/bots/${BOT}`, undefined, { state });
    assert.deepEqual(json!.data!.activity, activity, name);
    assert.equal(json!.data!.status, status, name);
  }
});

test("a bot carries its last message, unread flag and last activity", async () => {
  const quiet = (await call("GET", `/api/v1/bots/${BOT}`, undefined)).json!.data!;
  assert.deepEqual(
    [quiet.lastMessage, quiet.lastMessagePreview, quiet.unread, quiet.lastActivityAt],
    [null, "", false, "2026-10-18T00:00:00Z"]);
  const spoke = (await call("GET", `/api/v1/bots/${BOT}`, undefined, { state: {
    last_message_at: "2026-10-18T00:02:00Z", last_message_preview: "초안을 만들었어요", last_message_from_bot: true,
    last_activity_at: "2026-10-18T00:02:00Z", unread: true,
  } })).json!.data!;
  assert.deepEqual(
    [spoke.lastMessage, spoke.lastMessagePreview, spoke.unread, spoke.lastActivityAt],
    [{ preview: "초안을 만들었어요", at: "2026-10-18T00:02:00Z", fromBot: true }, "초안을 만들었어요", true, "2026-10-18T00:02:00Z"]);
});

test("GET /bots/{id} adds the posting and the newest fit score, or null for each", async () => {
  const bare = (await call("GET", `/api/v1/bots/${BOT}`, undefined)).json!.data!;
  assert.deepEqual([bare.posting, bare.fit], [null, null]);
  const full = (await call("GET", `/api/v1/bots/${BOT}`, undefined, { state: {
    posting_title: "Backend", posting_deadline: "2026-11-20", posting_closed: false, fit_score: "8.1",
  } })).json!.data!;
  assert.deepEqual(
    [full.posting, full.fit],
    [{ id: POSTING, title: "Backend", deadline: "2026-11-20", closed: false }, { score: 8.1 }]);
});

test("POST /bots creates a company bot from a posting", async () => {
  const { res, json, seen } = await call("POST", "/api/v1/bots", { postingId: POSTING, displayName: "Acme coach", color: "violet" });
  assert.equal(res.status, 201);
  assert.equal(json!.data!.id, BOT);
  const insert = seen.find((c) => c.sql.includes("INSERT INTO bots") && c.sql.includes("'company'"))!;
  assert.deepEqual(insert.params.slice(2, 6), ["Acme", POSTING, "Acme coach", "violet"]);
  assert.ok(!insert.sql.includes("company_id"));
});

test("a bot never gets a blank name", async () => {
  const spaced = await call("POST", "/api/v1/bots", { postingId: POSTING, displayName: "  Acme coach " }, { posting: { company: "  Acme \u3000" } });
  assert.equal(spaced.res.status, 201);
  const insert = spaced.seen.find((c) => c.sql.includes("INSERT INTO bots") && c.sql.includes("'company'"))!;
  assert.deepEqual(insert.params.slice(2, 5), ["Acme", POSTING, "Acme coach"]);

  const unnamed = await call("POST", "/api/v1/bots", { postingId: POSTING }, { posting: { company: " \u3000 " } });
  assert.equal(unnamed.res.status, 404, "a posting whose company is blank makes no bot");
  assert.ok(!wrote(unnamed.seen, "INSERT INTO bots"));

  for (const [method, path, body] of [
    ["POST", "/api/v1/bots", { postingId: POSTING, displayName: "   " }],
    ["PATCH", `/api/v1/bots/${BOT}`, { expectedRevision: 1, displayName: " \u3000 " }],
  ] as const) {
    const { res, json, seen } = await call(method, path, body);
    assert.deepEqual([res.status, json!.error!.details.field], [400, "displayName"], method);
    assert.ok(!wrote(seen, "INSERT INTO bots") && !wrote(seen, "UPDATE bots"), method);
  }
  const renamed = await call("PATCH", `/api/v1/bots/${BOT}`, { expectedRevision: 1, displayName: " New " });
  assert.equal(renamed.seen.find((c) => c.sql.includes("UPDATE bots SET revision"))!.params[2], "New");
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
    if (sql.includes("FROM job_postings")) return { rows: [POSTING_ROW], rowCount: 1 };
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

test("POST /bots/link-preview resolves a posting URL to the posting's facts and the link's host, and nothing else", async () => {
  const found = await call("POST", "/api/v1/bots/link-preview", { url: `https://App.Push.local/postings/${POSTING}?ref=1` });
  assert.deepEqual(found.json!.data, {
    status: "found", postingId: POSTING, company: "Acme", title: "Backend",
    deadline: "2026-11-20", careerMin: 3, careerMax: null, location: "Seoul", host: "app.push.local",
  });
  const sparse = await call("POST", "/api/v1/bots/link-preview", { url: "https://careers.acme.example/jobs/1042" },
    { posting: { company: " Acme ", deadline: null, career_min: 0, career_max: 5, location: "" } });
  assert.deepEqual(sparse.json!.data, {
    status: "found", postingId: POSTING, company: "Acme", title: "Backend",
    deadline: null, careerMin: 0, careerMax: 5, location: null, host: "careers.acme.example",
  });
  for (const w of [{ posting: false }, { posting: { company: "  " } }] as World[]) {
    assert.deepEqual((await call("POST", "/api/v1/bots/link-preview", { url: "https://example.com/jobs/1" }, w)).json!.data, { status: "not_a_posting" });
  }
  assert.equal((await call("POST", "/api/v1/bots/link-preview", { url: "ftp://example.com/jobs/1" })).res.status, 400);
});

test("GET /bots/search answers bots with a line and message hits with a snippet", async () => {
  const hit = (id: string, text: string) => ({
    total: 3, id, created_at: "2026-10-17T00:00:00Z", role: "ASSISTANT", text, bot_id: BOT, kind: "company", display_name: "Acme", color: "teal",
  });
  const { res, json } = await call("GET", "/api/v1/bots/search?q=acme&limit=2", undefined, {
    state: { posting_title: "Backend" },
    hits: [hit(POSTING, "Acme 공고 마감이 이번 주 금요일이에요"), hit(BOT, "two"), hit(USER, "three")],
  });
  assert.equal(res.status, 200);
  const found = json!.data as unknown as { bots: Record<string, unknown>[]; botTotal: number; messages: unknown[]; messageTotal: number };
  assert.deepEqual([found.bots.map((bot) => [bot.id, bot.line]), found.botTotal], [[[BOT, "Acme · Backend"]], 1]);
  assert.deepEqual(found.messages[0], {
    bot: { id: BOT, kind: "company", displayName: "Acme", color: "teal" },
    messageId: POSTING, at: "2026-10-17T00:00:00Z", role: "ASSISTANT", snippet: "Acme 공고 마감이 이번 주 금요일이에요",
  });
  assert.deepEqual([found.messages.length, found.messageTotal, json!.page!.hasMore, typeof json!.page!.nextCursor], [2, 3, true, "string"]);

  const none = await call("GET", "/api/v1/bots/search?q=zzz", undefined, { bot: null });
  assert.deepEqual([none.json!.data, none.json!.page], [{ bots: [], botTotal: 0, messages: [], messageTotal: 0 }, { nextCursor: null, hasMore: false }]);
  const lone = await call("GET", "/api/v1/bots/search?q=push", undefined, { bot: botRow({ kind: "push", display_name: "Push Bot", company_name: "", posting_id: null }) });
  assert.equal((lone.json!.data as unknown as { bots: Record<string, unknown>[] }).bots[0].line, "Push Bot");
});

test("GET /bots/search refuses a missing, blank or too long q and a bad page", async () => {
  for (const query of ["", "?q=", "?q=%20%20", `?q=${"가".repeat(201)}`]) {
    const { res, json, seen } = await call("GET", `/api/v1/bots/search${query}`, undefined);
    assert.deepEqual([res.status, json!.error!.details.field], [400, "q"], query);
    assert.ok(!wrote(seen, "bot_state_v"));
  }
  assert.equal((await call("GET", `/api/v1/bots/search?q=${"가".repeat(200)}`, undefined)).res.status, 200);
  for (const [query, field] of [["?q=a&limit=0", "limit"], ["?q=a&cursor=nope", "cursor"]]) {
    const { res, json } = await call("GET", `/api/v1/bots/search${query}`, undefined);
    assert.deepEqual([res.status, json!.error!.details.field], [400, field], query);
  }
});

test("search folds case by the database's locale only when q holds a cased letter outside ASCII", async () => {
  const collations = async (q: string): Promise<boolean[]> => {
    const { seen } = await call("GET", `/api/v1/bots/search?q=${encodeURIComponent(q)}`, undefined);
    return seen.filter((c) => c.sql.includes("ILIKE")).map((c) => c.sql.includes('COLLATE "C"'));
  };
  for (const q of ["acme", "모아페이", "100%", "AWS 경력"]) assert.deepEqual(await collations(q), [true, true], q);
  for (const q of ["résumé", "Ünal", "я"]) assert.deepEqual(await collations(q), [false, false], q);
});

test("a search snippet is the match with up to 30 characters before it and 60 after", () => {
  const before = "가".repeat(40);
  const after = "나".repeat(80);
  assert.equal(snippetOf(`${before}모아페이${after}`, "모아페이"), `…${"가".repeat(30)}모아페이${"나".repeat(60)}`);
  assert.equal(snippetOf("모아페이 공고 마감이 이번 주 금요일이에요", "모아"), "모아페이 공고 마감이 이번 주 금요일이에요");
  assert.equal(snippetOf(`${"a".repeat(31)}MoaPay`, "moapay"), `…${"a".repeat(30)}MoaPay`, "letter case does not matter");
  assert.equal(snippetOf(`${"a".repeat(31)}(c++)?`, "(c++)?"), `…${"a".repeat(30)}(c++)?`, "q is plain text");
  assert.equal(snippetOf(`${"😀".repeat(31)}모아`, "모아"), `…${"😀".repeat(30)}모아`, "a character outside the basic plane is one character");
  assert.equal(snippetOf("a".repeat(100), "zzz"), "a".repeat(60), "no match starts at the beginning");
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
