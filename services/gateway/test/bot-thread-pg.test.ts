// A bot's thread through the gateway and core on a migrated Postgres (BILLING_PG_URL). Sign-in is the dev
// token and core is the real handler, so the guard's probe, the thread lookup by bot, the cancel and the
// job-end trigger all run as they do deployed. No AI worker runs: a test writes the events a run would.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { METHODS, specRoutes } from "../../../packages/contracts/drift.ts";
import { handle, resetLimits, type Deps, type FrontEnv } from "../src/handler.ts";
import { sha256Hex } from "../src/http.ts";

const URL_ = process.env.BILLING_PG_URL;
const SKIP = "set BILLING_PG_URL to a migrated Postgres";
const BASE = "https://push-be.example/api/v1";
const SAMPLE_ID = "12345678-1234-4678-9234-567812345678";

type Person = { id: string; plan: string };
type World = Awaited<ReturnType<typeof world>>;

const world = async (url: string) => {
  const { botsPg } = await import("../../core-api/test-support/bots-pg.ts");
  const core = await import("../../core-api/src/handler.ts");
  const db = await botsPg(url);
  const forwarded: string[] = [];
  const query: Deps["query"] = async (sql, params) => (await db.pg.query(sql, params)).rows;
  const probe = (owner: string) => async (request: Request | string | URL): Promise<Response> => {
    forwarded.push(`${owner} ${request instanceof Request ? request.url : String(request)}`);
    return new Response(JSON.stringify({ probe: owner }), { status: 202, headers: { "content-type": "application/json" } });
  };

  /** The gateway for `user`. Core is the real handler unless `coreProbe` asks only whether a request was forwarded. */
  const as = (user: Person, options: { polls?: number; sleep?: Deps["sleep"]; coreProbe?: boolean } = {}) => {
    const dev = { APP_ENV: "development", DEV_AUTH_TOKEN: "dev", DEV_USER_ID: user.id };
    const env: FrontEnv = {
      ...dev,
      SSE_MAX_POLLS: String(options.polls ?? 2),
      AI_ORIGIN: "https://ai.example.test",
      AI_SHARED_SECRET: "secret",
      CORE: {
        fetch: options.coreProbe ? probe("core") : (request) => core.handle(request, { ...dev, QUEUE_BACKEND: "redis" },
          { query: db.pg.query, transaction: db.pg.transaction, now: () => new Date() }),
      },
    };
    const deps: Deps = { query, sleep: options.sleep ?? (async () => {}), fetch: probe("ai") as typeof fetch };
    return (method: string, path: string, body?: unknown, token: string | null = "dev"): Promise<Response> => {
      resetLimits();
      return handle(new Request(BASE + path, {
        method,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          "content-type": "application/json",
          ...(method === "POST" ? { "idempotency-key": crypto.randomUUID() } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }), env, deps);
    };
  };

  const rows = async (sql: string, params: unknown[]): Promise<Record<string, unknown>[]> => (await db.pg.query(sql, params)).rows;

  /** A user with a company bot whose thread holds one queued send, and a conversation that is no bot's. */
  const seeded = async (company: string) => {
    const user = await db.person("PRO");
    const call = as(user);
    const bot = await (await call("POST", "/bots", { postingId: await db.posting(company) })).json() as { data: { id: string } };
    const sent = await call("POST", `/bots/${bot.data.id}/messages/stream`, { text: `${company}에 맞춰 줘` });
    const [thread] = await rows("SELECT c.id, j.id AS job FROM conversations c JOIN ai_jobs j ON j.conversation_id = c.id WHERE c.bot_id = $1::uuid", [bot.data.id]);
    const plain = crypto.randomUUID();
    await db.pg.query("INSERT INTO conversations (id, user_id, title) VALUES ($1::uuid, $2::uuid, '웹 대화')", [plain, user.id]);
    return { user, call, botId: bot.data.id, thread: String(thread.id), job: String(thread.job), plain, sent };
  };

  return { db, as, rows, seeded, forwarded };
};

let w: World | undefined;
before(async () => { if (URL_) w = await world(URL_); });
after(async () => { await w?.db.close(); });

const framesOf = (text: string): Record<string, unknown>[] => text.split("\n\n")
  .map((block) => block.split("\n").find((line) => line.startsWith("data: ")))
  .filter((line): line is string => line !== undefined)
  .map((line) => JSON.parse(line.slice("data: ".length)) as Record<string, unknown>);

const TS = (column: string): string => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const emit = (world: World, job: string, events: [type: string, payload: unknown][]): Promise<unknown> => world.db.pg.query(
  "INSERT INTO chat_events (job_id, type, payload) SELECT $1::uuid, e->>0, e->1 FROM jsonb_array_elements($2::jsonb) e",
  [job, JSON.stringify(events)]);

test("a bot's thread is not in the conversation list, by either way the list is read", async (t) => {
  if (!w) return t.skip(SKIP);
  const { user, call, plain } = await w.seeded("List");
  const idsOf = async (res: Response): Promise<string[]> => {
    assert.equal(res.status, 200);
    return ((await res.json()) as { data: { id: string }[] }).data.map((item) => item.id);
  };
  assert.deepEqual(await idsOf(await call("GET", "/conversations")), [plain]);
  assert.deepEqual(await idsOf(await call("GET", `/conversations?q=${encodeURIComponent("맞춰")}`)), [], "nor found by its text");

  // A signed-in session reads the list in one statement with its token, not in the statement the dev token uses.
  const [refresh, token] = [crypto.randomUUID(), `token-${crypto.randomUUID()}`];
  await w.db.pg.query("INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at) VALUES ($1::uuid, $2::uuid, $1::uuid::text, now() + interval '1 hour')", [refresh, user.id]);
  await w.db.pg.query(
    "INSERT INTO access_tokens (id, user_id, token_hash, refresh_token_id, expires_at) VALUES ($1::uuid, $2::uuid, $3, $4::uuid, now() + interval '1 hour')",
    [crypto.randomUUID(), user.id, await sha256Hex(token), refresh]);
  const statements: string[] = [];
  resetLimits();
  const listed = await handle(new Request(BASE + "/conversations", { headers: { authorization: `Bearer ${token}` } }),
    { APP_ENV: "production" },
    { query: async (sql, params) => { statements.push(sql); return (await w!.db.pg.query(sql, params)).rows; } });
  assert.deepEqual(await idsOf(listed), [plain]);
  assert.deepEqual(statements.map((sql) => sql.slice(0, 12)), ["WITH auth AS"]);
  await w.db.pg.query("DELETE FROM access_tokens WHERE user_id = $1::uuid", [user.id]);
  await w.db.pg.query("DELETE FROM refresh_tokens WHERE user_id = $1::uuid", [user.id]);
});

const CONVERSATION_ROUTES = specRoutes.filter((route) => route.template.startsWith("/api/v1/conversations/{id}"));
const pathFor = (template: string, id: string): string =>
  template.replace("/api/v1", "").replace("{id}", id).replace(/\{\w+\}/g, SAMPLE_ID);

test("no route under /conversations/{id} answers for a bot's thread, and each still answers for a conversation", async (t) => {
  if (!w) return t.skip(SKIP);
  const { user, thread, plain } = await w.seeded("Guard");
  const call = w.as(user, { coreProbe: true });
  assert.ok(CONVERSATION_ROUTES.length >= 14, "the routes come from openapi.json");

  const answered: string[] = [];
  w.forwarded.length = 0;
  for (const template of new Set(CONVERSATION_ROUTES.map((route) => route.template))) {
    for (const method of METHODS) {
      const body = method === "GET" || method === "DELETE" ? undefined : {};
      for (const token of ["dev", null]) {
        const res = await call(method, pathFor(template, thread), body, token);
        const code = res.status === 404 ? ((await res.json()) as { error: { code: string } }).error.code : String(res.status);
        if (code !== "NOT_FOUND") answered.push(`${method} ${template} ${token ?? "no token"}: ${code}`);
      }
    }
  }
  assert.deepEqual(answered, []);
  assert.deepEqual(w.forwarded, [], "nothing reached core or the AI service");

  const hidden: string[] = [];
  for (const route of CONVERSATION_ROUTES) {
    const res = await call(route.method, pathFor(route.template, plain), route.method === "GET" || route.method === "DELETE" ? undefined : {});
    if (res.status === 404) hidden.push(`${route.method} ${route.template}`);
  }
  assert.deepEqual(hidden, []);
});

test("only the spellings of an id the gateway can read reach a route", async (t) => {
  if (!w) return t.skip(SKIP);
  const { user, thread, plain } = await w.seeded("Spell");
  const call = w.as(user, { coreProbe: true });
  const compact = thread.replaceAll("-", "");
  w.forwarded.length = 0;

  for (const spelling of [thread.toUpperCase(), compact]) {
    assert.equal((await call("GET", `/conversations/${spelling}/turns`)).status, 404, spelling);
  }
  // The AI service reads each of these as the same id, so none may be forwarded to it.
  for (const spelling of [`%7B${thread}%7D`, `urn:uuid:${thread}`, `%${thread.charCodeAt(0).toString(16)}${thread.slice(1)}`, `${compact.slice(0, 16)}-${compact.slice(16)}`]) {
    for (const id of [spelling, spelling.replace(thread, plain)]) {
      assert.equal((await call("GET", `/conversations/${id}/turns`)).status, 400, id);
    }
  }
  assert.deepEqual(w.forwarded, []);
  assert.equal((await call("GET", `/conversations/${plain.toUpperCase()}/turns`)).status, 202, "a conversation in another spelling is forwarded");
});

test("a send streams the queued run by bot, and a follow resumes after a seq without the rows that have no phase", async (t) => {
  if (!w) return t.skip(SKIP);
  const { call, botId, thread, job, sent } = await w.seeded("Stream");
  assert.deepEqual([sent.status, sent.headers.get("content-type")], [200, "text/event-stream"]);
  const [queued] = await w.rows(
    `SELECT e.id, ${TS("e.created_at")} AS at, ${TS("j.created_at")} AS since FROM chat_events e JOIN ai_jobs j ON j.id = e.job_id WHERE j.id = $1::uuid`, [job]);

  assert.deepEqual(framesOf(await sent.text()), [{
    type: "status", text: "대기 중", phase: "queued", ahead: 0, since: queued.since, seq: Number(queued.id), at: queued.at, turn: job,
  }]);

  const operation = {
    id: crypto.randomUUID(), type: "CHAT_MESSAGE", status: "SUCCEEDED",
    result: { kind: "CHAT_MESSAGE", value: { assistantMessageId: crypto.randomUUID(), userMessageId: crypto.randomUUID(), approvalIds: [] } },
  };
  await w.db.pg.query("UPDATE ai_jobs SET status = 'RUNNING' WHERE id = $1::uuid", [job]);
  await emit(w, job, [
    ["status", { text: "공고를 읽는 중" }],
    ["status", { text: "생각 중", phase: "thinking", since: queued.since }],
    ["token", { text: "안녕하세요" }],
    ["status", { text: "확인을 기다리고 있어요", phase: "waiting", since: queued.since, for: "confirm", cardId: SAMPLE_ID }],
    ["done", { operation }],
  ]);

  const followed = framesOf(await (await call("GET", `/bots/${botId}/stream?after=${queued.id}`)).text());

  assert.deepEqual(followed.map(({ seq: _seq, at: _at, ...frame }) => frame), [
    { type: "status", text: "생각 중", phase: "thinking", since: queued.since, turn: job },
    { type: "token", text: "안녕하세요", turn: job },
    { type: "status", text: "확인을 기다리고 있어요", phase: "waiting", since: queued.since, for: "confirm", cardId: SAMPLE_ID, turn: job },
    { type: "done", operation, turn: job },
  ]);
  assert.ok(followed.every((frame) => Number(frame.seq) > Number(queued.id) && !Number.isNaN(Date.parse(String(frame.at)))));
  assert.equal(JSON.stringify(followed).includes(thread), false);

  await w.db.pg.query("UPDATE ai_jobs SET status = 'DONE' WHERE id = $1::uuid", [job]);
  assert.equal((await call("GET", `/bots/${botId}/stream`)).status, 204, "nothing runs");
  assert.equal((await w.rows("SELECT 1 FROM chat_events WHERE job_id = $1::uuid AND type = 'done'", [job])).length, 1);
});

test("a stop while a document flow is active ends the stream with one cancelled that is resumable", async (t) => {
  if (!w) return t.skip(SKIP);
  const { user, botId, thread, job } = await w.seeded("Cancel");
  const call = w.as(user, { polls: 200, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 20))) });
  await w.db.pg.query("UPDATE conversations SET resume_state = '{\"status\":\"active\"}' WHERE id = $1::uuid", [thread]);
  await w.db.pg.query("UPDATE ai_jobs SET status = 'RUNNING' WHERE id = $1::uuid", [job]);
  const open = await call("GET", `/bots/${botId}/stream`);

  const stopped = await call("POST", `/bots/${botId}/stream/cancel`);

  assert.deepEqual([stopped.status, await stopped.json()], [200, { data: { status: "CANCELLED", resumable: true } }]);
  const frames = framesOf(await open.text());
  assert.deepEqual(frames.filter((frame) => frame.type === "cancelled").map(({ type, resumable, turn }) => ({ type, resumable, turn })),
    [{ type: "cancelled", resumable: true, turn: job }]);
  assert.equal(frames.at(-1)?.type, "cancelled", "the stream closed on it");
  assert.deepEqual(await w.rows("SELECT payload FROM chat_events WHERE job_id = $1::uuid AND type = 'cancelled'", [job]), [{ payload: { resumable: true } }]);
  const again = await call("POST", `/bots/${botId}/stream/cancel`);
  assert.deepEqual([again.status, ((await again.json()) as { error: { code: string } }).error.code], [409, "CONFLICT"]);
});

test("a bot with nothing running, the Push Bot before its first use, and a bot of another user", async (t) => {
  if (!w) return t.skip(SKIP);
  const user = await w.db.person("PRO");
  const call = w.as(user);
  const bot = await (await call("POST", "/bots", { postingId: await w.db.posting("Idle") })).json() as { data: { id: string } };
  const statuses = async (id: string, as_ = call): Promise<number[]> =>
    [(await as_("GET", `/bots/${id}/stream`)).status, (await as_("POST", `/bots/${id}/stream/cancel`)).status];

  assert.deepEqual(await statuses(bot.data.id), [204, 409], "a bot with no thread");
  const fresh = await w.db.person("FREE");
  assert.deepEqual(await statuses("push", w.as(fresh)), [204, 409], "push before core made its row");
  assert.deepEqual(await w.rows("SELECT 1 FROM bots WHERE user_id = $1::uuid", [fresh.id]), [], "the gateway made no row");
  assert.deepEqual(await statuses(bot.data.id, w.as(fresh)), [404, 404], "another user's bot");
  assert.deepEqual(await statuses(SAMPLE_ID), [404, 404], "no such bot");
  assert.deepEqual(await statuses("not-an-id"), [400, 400]);
  const unknown = await call("POST", `/bots/${SAMPLE_ID}/messages/stream`, { text: "안녕" });
  assert.deepEqual([unknown.status, unknown.headers.get("content-type")?.split(";")[0]], [404, "application/json"]);
});

const BOT_ROUTES = specRoutes.filter((route) => route.template.startsWith("/api/v1/bots"));

test("no body of a bot route and no frame of its streams holds the thread's id", async (t) => {
  if (!w) return t.skip(SKIP);
  const { call, botId, thread, sent } = await w.seeded("Leak");
  const card = crypto.randomUUID();
  await w.db.pg.query(
    `INSERT INTO approvals (id, user_id, kind, target_id, payload_hash, status, conversation_id, title, options, tool_name, tool_args)
     SELECT $1::uuid, user_id, 'TOOL_ACTION', $1::uuid, 'h', 'PENDING', id, '지원할까요?', '[{"id":"approve","label":"지원"}]', 'apply_to_posting', '{}'
     FROM conversations WHERE id = $2::uuid`, [card, thread]);
  const bodies: Record<string, unknown> = {
    "POST /api/v1/bots": { postingId: await w.db.posting("Leak two") },
    "POST /api/v1/bots/link-preview": { url: "https://jobs.example/1" },
    "PATCH /api/v1/bots/{id}": { expectedRevision: 1, notificationsMuted: true },
    "POST /api/v1/bots/{id}/messages/stream": { text: "한 번 더" },
    "POST /api/v1/bots/{id}/approvals/{approvalId}": { optionId: "approve" },
  };
  // Deletes go last: they end the thread the other routes answer for.
  const ordered = [...BOT_ROUTES].sort((a, b) => Number(a.method === "DELETE") - Number(b.method === "DELETE"));
  const seen = [`${sent.status} send\n${await sent.text()}`];

  for (const route of ordered) {
    const key = `${route.method} ${route.template}`;
    const path = route.template.replace("/api/v1", "").replace("{id}", botId).replace("{approvalId}", card).replace(/\{\w+\}/g, SAMPLE_ID);
    const query = route.template.endsWith("/matches") ? `?q=${encodeURIComponent("맞춰")}` : "";
    const res = await call(route.method, path + query, bodies[key] ?? (route.method === "GET" || route.method === "DELETE" ? undefined : {}));
    seen.push(`${res.status} ${key}\n${await res.text()}`);
  }

  assert.ok(seen.length > 10 && seen.some((entry) => entry.startsWith("200 GET /api/v1/bots/{id}/transcript/matches")));
  assert.deepEqual(seen.filter((entry) => entry.includes(thread)).map((entry) => entry.split("\n")[0]), []);
  assert.ok(seen.join("\n").includes(botId), "the bodies were read");
});
