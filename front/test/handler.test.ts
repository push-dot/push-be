import assert from "node:assert/strict";
import { test } from "node:test";

import { memoryCache } from "../src/cache.ts";
import { handle, resetLimits, type Deps, type FrontEnv, type Query } from "../src/handler.ts";
import { decodeCursor, encodeCursor, formatCursorTimestamp, formatJsonTimestamp } from "../src/time.ts";

const USER = "12345678-1234-5678-1234-567812345678";
const NOW = new Date("2026-10-18T00:00:00Z");

function env(api?: FrontEnv["API"]): FrontEnv {
  return {
    DATABASE_URL: "postgres://example",
    API: api ?? { async fetch() { throw new Error("python should not be called"); } },
    APP_ENV: "production",
    MANAGED_AI: "1",
    MANAGED_GO: "0",
    SSE_MAX_POLLS: "3",
    MODEL_CACHE_TTL: "600",
    JOB_SITES_CACHE_TTL: "3600",
  };
}

function deps(query: Query, extra: Partial<Deps> = {}): Deps {
  return {
    query,
    cache: memoryCache(() => NOW.getTime()),
    sleep: async () => {},
    now: () => NOW,
    ...extra,
  };
}

test("timestamps and cursors match the Python API", () => {
  const stamp = "2026-10-17T21:57:28.172000+00";
  assert.equal(formatJsonTimestamp(stamp), "2026-10-17T21:57:28.172000Z");
  assert.equal(formatCursorTimestamp(stamp), "2026-10-17T21:57:28.172Z");
  const encoded = encodeCursor(stamp, USER);
  assert.equal(encoded, "MjAyNi0xMC0xN1QyMTo1NzoyOC4xNzJafDEyMzQ1Njc4LTEyMzQtNTY3OC0xMjM0LTU2NzgxMjM0NTY3OA");
  assert.deepEqual(decodeCursor(encoded), { createdAt: "2026-10-17T21:57:28.172Z", id: USER });
  assert.equal(formatJsonTimestamp("2026-10-17T21:57:28Z"), "2026-10-17T21:57:28Z");
  assert.equal(
    encodeCursor("2026-10-17T21:57:28Z", USER),
    "MjAyNi0xMC0xN1QyMTo1NzoyOFp8MTIzNDU2NzgtMTIzNC01Njc4LTEyMzQtNTY3ODEyMzQ1Njc4",
  );
});

test("healthz echoes x-request-id and does not touch the database", async () => {
  let queries = 0;
  const res = await handle(new Request("https://push-be.example/healthz", {
    headers: { "x-request-id": "req_fixed" },
  }), env(), deps(async () => { queries += 1; return []; }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-request-id"), "req_fixed");
  assert.equal(await res.text(), '{"data": {"status": "ok"}}');
  assert.equal(queries, 0);
});

test("auth/me preserves unauthenticated, expired, and success bodies", async () => {
  resetLimits();
  const missing = await handle(new Request("https://push-be.example/api/v1/auth/me"), env(), deps(async () => []));
  assert.equal(missing.status, 401);
  const missingBody = await missing.json() as { error: { code: string; details: null; requestId: string } };
  assert.equal(missingBody.error.code, "UNAUTHENTICATED");
  assert.equal(missingBody.error.details, null);
  assert.match(missing.headers.get("x-request-id") || "", /^req_/);

  const query: Query = async (sql) => {
    if (sql.includes("access_tokens")) {
      return [{
        id: USER, display_name: "Ada", locale: "ko",
        created_at: "2026-01-02T03:04:05.000001Z",
        expires_at: "2020-01-01T00:00:00Z",
      }];
    }
    return [];
  };
  const expired = await handle(new Request("https://push-be.example/api/v1/auth/me", {
    headers: { authorization: "Bearer secret-token" },
  }), env(), deps(query));
  assert.equal(expired.status, 401);
  assert.equal((await expired.json() as { error: { code: string } }).error.code, "TOKEN_EXPIRED");

  const okQuery: Query = async (sql) => {
    if (sql.includes("access_tokens")) {
      return [{
        id: USER, display_name: "Ada", locale: "ko",
        created_at: "2026-01-02T03:04:05.000001Z",
        expires_at: "2099-01-01T00:00:00Z",
      }];
    }
    return [];
  };
  const ok = await handle(new Request("https://push-be.example/api/v1/auth/me", {
    headers: { authorization: "Bearer secret-token", "x-request-id": "req_me" },
  }), env(), deps(okQuery));
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(),
    '{"data": {"id": "12345678-1234-5678-1234-567812345678", "displayName": "Ada", "locale": "ko", "createdAt": "2026-01-02T03:04:05.000001Z"}}');
});

test("conversation list pages with a Python-compatible cursor", async () => {
  resetLimits();
  const rows = [0, 1].map((i) => ({
    id: i === 0 ? USER : "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    revision: 2,
    application_id: null,
    title: "채팅",
    pinned: false,
    created_at: i === 0 ? "2026-10-17T21:57:28.172000Z" : "2026-10-17T21:57:27Z",
    updated_at: "2026-10-17T21:57:28Z",
  }));
  const seen: unknown[][] = [];
  const res = await handle(new Request("https://push-be.example/api/v1/conversations?limit=1", {
    headers: { authorization: "Bearer secret-token" },
  }), env(), deps(async (sql, params) => {
    seen.push([sql, params]);
    if (sql.includes("access_tokens")) {
      return [{ id: USER, display_name: "Ada", locale: "ko", created_at: "2026-01-02T03:04:05Z", expires_at: "2099-01-01T00:00:00Z" }];
    }
    return rows;
  }));
  assert.equal(res.status, 200);
  const body = JSON.parse(await res.text()) as { data: { title: string }[]; page: { hasMore: boolean; nextCursor: string } };
  assert.equal(body.data.length, 1);
  assert.equal(body.data[0].title, "채팅");
  assert.equal(body.page.hasMore, true);
  assert.equal(body.page.nextCursor, encodeCursor("2026-10-17T21:57:28.172000Z", USER));
  const listSql = String(seen.find((c) => String(c[0]).includes("FROM conversations"))?.[0]);
  assert.match(listSql, /archived = false/);
  assert.match(listSql, /ORDER BY created_at DESC, id DESC/);
});

test("message reads 404 when the conversation is missing and omit null attachments", async () => {
  resetLimits();
  const auth = async (sql: string) => {
    if (sql.includes("access_tokens")) {
      return [{ id: USER, display_name: "Ada", locale: "ko", created_at: "2026-01-02T03:04:05Z", expires_at: "2099-01-01T00:00:00Z" }];
    }
    return [];
  };
  const missing = await handle(new Request(`https://push-be.example/api/v1/conversations/${USER}/messages`, {
    headers: { authorization: "Bearer secret-token" },
  }), env(), deps(auth));
  assert.equal(missing.status, 404);
  assert.equal((await missing.json() as { error: { code: string } }).error.code, "NOT_FOUND");

  const found: Query = async (sql) => {
    if (sql.includes("access_tokens")) {
      return [{ id: USER, display_name: "Ada", locale: "ko", created_at: "2026-01-02T03:04:05Z", expires_at: "2099-01-01T00:00:00Z" }];
    }
    if (sql.includes("FROM conversations")) return [{ id: USER }];
    return [{
      id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      conversation_id: USER,
      role: "USER",
      text: "안녕",
      attachments: [{ type: "EVIDENCE", id: USER, documentId: null, title: "이력" }],
      operation_id: null,
      created_at: "2026-10-17T21:57:28Z",
    }];
  };
  const ok = await handle(new Request(`https://push-be.example/api/v1/conversations/${USER}/messages`, {
    headers: { authorization: "Bearer secret-token" },
  }), env(), deps(found));
  const body = JSON.parse(await ok.text()) as { data: { attachments: Record<string, unknown>[] }[] };
  assert.deepEqual(body.data[0].attachments[0], { type: "EVIDENCE", id: USER, title: "이력" });
});

test("SSE replay returns 204 or the stored chat_events", async () => {
  resetLimits();
  const authRow = { id: USER, display_name: "Ada", locale: "ko", created_at: "2026-01-02T03:04:05Z", expires_at: "2099-01-01T00:00:00Z" };
  const empty: Query = async (sql) => {
    if (sql.includes("access_tokens")) return [authRow];
    if (sql.includes("FROM conversations")) return [{ id: USER }];
    return [];
  };
  const none = await handle(new Request(`https://push-be.example/api/v1/conversations/${USER}/messages/stream/active`, {
    headers: { authorization: "Bearer secret-token" },
  }), env(), deps(empty));
  assert.equal(none.status, 204);
  assert.equal(await none.text(), "");

  const live: Query = async (sql) => {
    if (sql.includes("access_tokens")) return [authRow];
    if (sql.includes("FROM conversations")) return [{ id: USER }];
    if (sql.includes("FROM chat_jobs")) return [{ id: "cccccccc-cccc-cccc-cccc-cccccccccccc" }];
    return [{ id: 7, type: "token", payload: { text: "안녕" } }, { id: 8, type: "done", payload: { operation: { status: "SUCCEEDED" } } }];
  };
  const res = await handle(new Request(`https://push-be.example/api/v1/conversations/${USER}/messages/stream/active?after=3`, {
    headers: { authorization: "Bearer secret-token" },
  }), env(), deps(live));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/event-stream");
  assert.match(res.headers.get("cache-control") || "", /no-cache/);
  const text = await res.text();
  assert.ok(text.startsWith("retry: 400\n\n"));
  assert.match(text, /id: 7\ndata: \{"type": "token", "text": "\\uc548\\ub155", "seq": 7\}/);
  assert.match(text, /id: 8\ndata: \{"type": "done", "operation": \{"status": "SUCCEEDED"\}, "seq": 8\}/);
});

test("model catalog is cached and a live BYOK list is proxied", async () => {
  resetLimits();
  const calls: string[] = [];
  const query: Query = async (sql) => {
    calls.push(sql);
    if (sql.includes("access_tokens")) {
      return [{ id: USER, display_name: "Ada", locale: "ko", created_at: "2026-01-02T03:04:05Z", expires_at: "2099-01-01T00:00:00Z" }];
    }
    if (sql.includes("ai_keys")) return [{ has: false }];
    return [];
  };
  const cache = memoryCache(() => NOW.getTime());
  const d = deps(query, { cache });
  const first = await handle(new Request("https://push-be.example/api/v1/ai/models", {
    headers: { authorization: "Bearer secret-token" },
  }), env(), d);
  const body = JSON.parse(await first.text()) as { data: { model: string; available: boolean }[] };
  assert.equal(body.data.length, 5);
  assert.equal(body.data.find((m) => m.model.startsWith("opencode-go/"))?.available, false);
  assert.equal(body.data.find((m) => m.model === "openai/gpt-5.6-sol")?.available, true);
  const before = calls.filter((sql) => sql.includes("ai_keys")).length;
  const second = await handle(new Request("https://push-be.example/api/v1/ai/models", {
    headers: { authorization: "Bearer secret-token" },
  }), env(), d);
  assert.equal(second.status, 200);
  assert.equal(calls.filter((sql) => sql.includes("ai_keys")).length, before);
  const bad = await handle(new Request("https://push-be.example/api/v1/ai/models?provider=NOPE", {
    headers: { authorization: "Bearer secret-token" },
  }), env(), d);
  assert.equal(bad.status, 400);
  assert.equal((await bad.json() as { error: { details: { field: string } } }).error.details.field, "provider");

  let proxied = 0;
  const api = { async fetch() { proxied += 1; return new Response("{}", { status: 200 }); } };
  const empty = await handle(new Request("https://push-be.example/api/v1/ai/models?provider=OPENAI&credentialMode=BYOK", {
    headers: { authorization: "Bearer secret-token" },
  }), env(api), d);
  assert.equal(empty.status, 200);
  assert.equal(await empty.text(), '{"data": []}');
  assert.equal(proxied, 0);
  const live = await handle(new Request("https://push-be.example/api/v1/ai/models?provider=OPENAI&credentialMode=BYOK", {
    headers: { authorization: "Bearer secret-token", "x-byok-key": "sk-live" },
  }), env(api), d);
  assert.equal(live.status, 200);
  assert.equal(proxied, 1);
});

test("job sites are served from cache after the first auth", async () => {
  resetLimits();
  let keyQueries = 0;
  const query: Query = async (sql) => {
    if (sql.includes("access_tokens")) {
      return [{ id: USER, display_name: "Ada", locale: "ko", created_at: "2026-01-02T03:04:05Z", expires_at: "2099-01-01T00:00:00Z" }];
    }
    keyQueries += 1;
    return [];
  };
  const d = deps(query);
  const first = await handle(new Request("https://push-be.example/api/v1/integrations/job-sites", {
    headers: { authorization: "Bearer secret-token" },
  }), env(), d);
  const body = JSON.parse(await first.text()) as { data: { provider: string; enabled: boolean; checklist: string[] }[] };
  assert.deepEqual(body.data.map((s) => s.provider), ["WANTED", "JUMPIT", "JOBKOREA"]);
  assert.equal(body.data[0].enabled, false);
  assert.equal(body.data[0].checklist.length, 5);
  await handle(new Request("https://push-be.example/api/v1/integrations/job-sites", {
    headers: { authorization: "Bearer secret-token" },
  }), env(), d);
  assert.equal(keyQueries, 0);
});

test("chat enqueue and other writes are proxied, and key writes drop the model cache", async () => {
  resetLimits();
  const calls: string[] = [];
  const query: Query = async (sql) => {
    calls.push(sql);
    if (sql.includes("access_tokens")) {
      return [{ id: USER, display_name: "Ada", locale: "ko", created_at: "2026-01-02T03:04:05Z", expires_at: "2099-01-01T00:00:00Z" }];
    }
    if (sql.includes("ai_keys")) return [{ has: true }];
    return [];
  };
  const cache = memoryCache(() => NOW.getTime());
  const d = deps(query, { cache });
  await handle(new Request("https://push-be.example/api/v1/ai/models", {
    headers: { authorization: "Bearer secret-token" },
  }), env(), d);
  const before = calls.length;
  const forwarded: string[] = [];
  const api = {
    async fetch(request: Request) {
      forwarded.push(request.method + " " + new URL(request.url).pathname);
      return new Response('{"data":{}}', {
        status: request.method === "PUT" ? 200 : 202,
        headers: { "content-type": "application/json", "x-request-id": "req_from_python" },
      });
    },
  };
  const post = await handle(new Request("https://push-be.example/api/v1/conversations/" + USER + "/messages", {
    method: "POST",
    headers: { authorization: "Bearer secret-token", "idempotency-key": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", "content-type": "application/json" },
    body: '{"text":"hi","accessMode":"SUGGEST"}',
  }), env(api), d);
  assert.equal(post.status, 202);
  assert.equal(post.headers.get("x-request-id"), "req_from_python");
  assert.equal(calls.length, before);
  assert.equal(forwarded[0], `POST /api/v1/conversations/${USER}/messages`);

  const put = await handle(new Request("https://push-be.example/api/v1/ai/keys/OPENAI", {
    method: "PUT",
    headers: { authorization: "Bearer secret-token" },
    body: '{"key":"sk-12345678"}',
  }), env(api), d);
  assert.equal(put.status, 200);
  const after = calls.length;
  const again = await handle(new Request("https://push-be.example/api/v1/ai/models", {
    headers: { authorization: "Bearer secret-token" },
  }), env(), d);
  assert.equal(again.status, 200);
  assert.ok(calls.length > after);
});

test("CORS preflight is answered without calling Python", async () => {
  let proxied = 0;
  const res = await handle(new Request("https://push-be.example/api/v1/auth/me", {
    method: "OPTIONS",
    headers: { origin: "http://localhost:5173", "access-control-request-method": "GET", "access-control-request-headers": "authorization, x-request-id" },
  }), env({ async fetch() { proxied += 1; return new Response(""); } }), deps(async () => []));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("access-control-allow-origin"), "http://localhost:5173");
  assert.match(res.headers.get("access-control-allow-headers") || "", /authorization/);
  assert.equal(proxied, 0);
});
