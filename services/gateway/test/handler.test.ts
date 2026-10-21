import assert from "node:assert/strict";
import { test } from "node:test";

import { memoryCache } from "../src/middleware/cache.ts";
import { handle, releaseExpired, resetLimits, type Deps, type FrontEnv, type Query } from "../src/handler.ts";
import { ownerOf } from "../src/routes/owner.ts";
import { decodeCursor, encodeCursor, formatCursorTimestamp, formatJsonTimestamp } from "../src/time.ts";

const USER = "12345678-1234-5678-1234-567812345678";
const NOW = new Date("2026-10-18T00:00:00Z");

function env(api?: FrontEnv["API"], core?: FrontEnv["API"]): FrontEnv {
  const python = api ?? { async fetch() { throw new Error("python should not be called"); } };
  return {
    DATABASE_URL: "postgres://example",
    API: python,
    CORE: core ?? python,
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
  assert.equal(formatCursorTimestamp(stamp), "2026-10-17T21:57:28.172000Z");
  const encoded = encodeCursor(stamp, USER);
  assert.deepEqual(decodeCursor(encoded), {
    createdAt: "2026-10-17T21:57:28.172000Z", id: USER,
  });
  const precise = "2026-10-19T05:47:05.644999Z";
  assert.equal(formatJsonTimestamp(precise), precise);
  assert.equal(formatCursorTimestamp(precise), precise);
  const preciseCursor = encodeCursor(precise, USER);
  assert.deepEqual(decodeCursor(preciseCursor), { createdAt: precise, id: USER });
  const truncated = formatJsonTimestamp(new Date(precise));
  assert.equal(truncated, "2026-10-19T05:47:05.644000Z");
  assert.notEqual(truncated, precise);
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
    '{"data": {"id": "12345678-1234-5678-1234-567812345678", "displayName": "Ada", "locale": "ko", "createdAt": "2026-01-02T03:04:05.000001Z", "accountType": "PERSONAL", "companyId": null, "companyRole": null}}');
});

test("auth/me still works when company_members is missing", async () => {
  resetLimits();
  const seen: string[] = [];
  const query: Query = async (sql) => {
    seen.push(sql);
    if (sql.includes("company_members")) {
      throw Object.assign(new Error('relation "company_members" does not exist'), { code: "42P01" });
    }
    if (sql.includes("access_tokens")) {
      return [{
        id: USER, display_name: "Ada", locale: "ko",
        created_at: "2026-01-02T03:04:05.000001Z",
        expires_at: "2099-01-01T00:00:00Z",
      }];
    }
    return [];
  };
  const res = await handle(new Request("https://push-be.example/api/v1/auth/me", {
    headers: { authorization: "Bearer secret-token" },
  }), env(), deps(query));
  assert.equal(res.status, 200);
  assert.equal(seen.some((sql) => sql.includes("company_members")), true);
  assert.equal(seen.some((sql) => sql.includes("access_tokens") && !sql.includes("company_members")), true);
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
      return [{
        id: USER, display_name: "Ada", locale: "ko",
        created_at: "2026-01-02T03:04:05Z", expires_at: "2099-01-01T00:00:00Z",
        hits: 1, rows,
      }];
    }
    return rows;
  }));
  assert.equal(res.status, 200);
  const body = JSON.parse(await res.text()) as { data: { title: string }[]; page: { hasMore: boolean; nextCursor: string } };
  assert.equal(body.data.length, 1);
  assert.equal(body.data[0].title, "채팅");
  assert.equal(body.page.hasMore, true);
  assert.equal(body.page.nextCursor, encodeCursor("2026-10-17T21:57:28.172000Z", USER));
  assert.equal(seen.length, 1);
  const listSql = String(seen[0][0]);
  assert.match(listSql, /access_tokens/);
  assert.match(listSql, /FROM conversations/);
  assert.match(listSql, /archived = false/);
  assert.match(listSql, /ORDER BY c\.created_at DESC, c\.id DESC/);
  assert.match(listSql, /ORDER BY page\.created_at DESC, page\.id DESC/);
  assert.match(listSql, /to_char\(page\.created_at AT TIME ZONE 'UTC'/);
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

  const message = {
    id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    conversation_id: USER,
    role: "USER",
    text: "안녕",
    attachments: [{ type: "EVIDENCE", id: USER, documentId: null, title: "이력" }],
    operation_id: null,
    created_at: "2026-10-17T21:57:28Z",
  };
  const found: Query = async (sql) => {
    if (sql.includes("json_agg")) {
      return [{
        id: USER, display_name: "Ada", locale: "ko",
        created_at: "2026-01-02T03:04:05Z", expires_at: "2099-01-01T00:00:00Z",
        hits: 1, conversation_id: USER, rows: [message],
      }];
    }
    if (sql.includes("access_tokens")) {
      return [{ id: USER, display_name: "Ada", locale: "ko", created_at: "2026-01-02T03:04:05Z", expires_at: "2099-01-01T00:00:00Z" }];
    }
    if (sql.includes("FROM conversations")) return [{ id: USER }];
    return [message];
  };
  const ok = await handle(new Request(`https://push-be.example/api/v1/conversations/${USER}/messages`, {
    headers: { authorization: "Bearer secret-token" },
  }), env(), deps(found));
  const body = JSON.parse(await ok.text()) as { data: { attachments: Record<string, unknown>[] }[] };
  assert.deepEqual(body.data[0].attachments[0], { type: "EVIDENCE", id: USER, title: "이력" });
});

test("SSE replay returns 204 or the stored chat_events", async () => {
  resetLimits();
  const authRow = { id: USER, display_name: "Ada", locale: "ko", created_at: "2026-01-02T03:04:05Z", expires_at: "2099-01-01T00:00:00Z", hits: 1 };
  const empty: Query = async (sql) => {
    if (sql.includes("chat_events")) return [];
    if (sql.includes("access_tokens")) return [{ ...authRow, conversation_id: USER, job_id: null }];
    if (sql.includes("FROM conversations")) return [{ id: USER }];
    return [];
  };
  const none = await handle(new Request(`https://push-be.example/api/v1/conversations/${USER}/messages/stream/active`, {
    headers: { authorization: "Bearer secret-token" },
  }), env(), deps(empty));
  assert.equal(none.status, 204);
  assert.equal(await none.text(), "");

  const live: Query = async (sql) => {
    if (sql.includes("chat_events")) {
      return [{ id: 7, type: "token", payload: { text: "안녕" } }, { id: 8, type: "done", payload: { operation: { status: "SUCCEEDED" } } }];
    }
    if (sql.includes("access_tokens")) {
      return [{ ...authRow, conversation_id: USER, job_id: "cccccccc-cccc-cccc-cccc-cccccccccccc" }];
    }
    if (sql.includes("FROM conversations")) return [{ id: USER }];
    if (sql.includes("FROM chat_jobs")) return [{ id: "cccccccc-cccc-cccc-cccc-cccccccccccc" }];
    return [];
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
    if (sql.includes("rate_limits")) return [{ hits: 1 }];
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
  const python = {
    async fetch(request: Request) {
      forwarded.push("python " + request.method + " " + new URL(request.url).pathname + " " + (request.headers.get("x-push-internal") || ""));
      return new Response('{"data":{}}', { status: 202, headers: { "content-type": "application/json" } });
    },
  };
  const core = {
    async fetch(request: Request) {
      forwarded.push("core " + request.method + " " + new URL(request.url).pathname);
      return new Response('{"data":{}}', {
        status: request.method === "PUT" ? 200 : 202,
        headers: { "content-type": "application/json", "x-request-id": "req_from_core" },
      });
    },
  };
  const post = await handle(new Request("https://push-be.example/api/v1/conversations/" + USER + "/messages", {
    method: "POST",
    headers: { authorization: "Bearer secret-token", "idempotency-key": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", "content-type": "application/json", "x-push-internal": "1" },
    body: '{"text":"hi","accessMode":"SUGGEST"}',
  }), env(python, core), d);
  assert.equal(post.status, 202);
  assert.equal(post.headers.get("x-request-id"), "req_from_core");
  assert.equal(calls.length, before);
  assert.equal(forwarded[0], `core POST /api/v1/conversations/${USER}/messages`);
  const generated = await handle(new Request("https://push-be.example/api/v1/ai/generate", {
    method: "POST",
    headers: { authorization: "Bearer secret-token", "x-push-internal": "1", "content-type": "application/json" },
    body: "{}",
  }), env(python, core), d);
  assert.equal(generated.status, 202);
  assert.equal(forwarded[1], "python POST /api/v1/ai/generate ");
  const hidden = await handle(new Request("https://push-be.example/internal/chat/schedule", {
    method: "POST",
    headers: { "x-push-internal": "1" },
  }), env(python, core), d);
  assert.equal(hidden.status, 404);

  const put = await handle(new Request("https://push-be.example/api/v1/ai/keys/OPENAI", {
    method: "PUT",
    headers: { authorization: "Bearer secret-token" },
    body: '{"key":"sk-12345678"}',
  }), env(python, core), d);
  assert.equal(put.status, 200);
  const after = calls.length;
  const again = await handle(new Request("https://push-be.example/api/v1/ai/models", {
    headers: { authorization: "Bearer secret-token" },
  }), env(), d);
  assert.equal(again.status, 200);
  assert.ok(calls.length > after);
});

test("shared rate limit is one query with auth and a full bucket is not written again", async () => {
  resetLimits();
  const seen: string[] = [];
  const query: Query = async (sql) => {
    seen.push(sql);
    if (sql.includes("access_tokens")) {
      return [{
        id: USER, display_name: "Ada", locale: "ko",
        created_at: "2026-01-02T03:04:05Z", expires_at: "2099-01-01T00:00:00Z",
        hits: 1,
      }];
    }
    return [];
  };
  const d = deps(query, { limits: { user: 1, public: 1, windowMs: 60_000 } });
  const ok = await handle(new Request("https://push-be.example/api/v1/auth/me", {
    headers: { authorization: "Bearer secret-token" },
  }), env(), d);
  assert.equal(ok.status, 200);
  assert.equal(seen.length, 1);
  assert.match(seen[0], /access_tokens/);
  assert.match(seen[0], /rate_limits\.hits < \$4/);
  const denied = await handle(new Request("https://push-be.example/api/v1/auth/me", {
    headers: { authorization: "Bearer secret-token" },
  }), env(), d);
  assert.equal(denied.status, 429);
  assert.equal((await denied.json() as { error: { code: string } }).error.code, "RATE_LIMITED");
  assert.equal(seen.length, 1);
});

test("a counter another isolate already filled does not increment", async () => {
  resetLimits();
  let calls = 0;
  const query: Query = async (sql) => {
    calls += 1;
    if (sql.includes("access_tokens")) {
      return [{
        id: USER, display_name: "Ada", locale: "ko",
        created_at: "2026-01-02T03:04:05Z", expires_at: "2099-01-01T00:00:00Z",
        hits: null,
      }];
    }
    return [];
  };
  const d = deps(query);
  const denied = await handle(new Request("https://push-be.example/api/v1/auth/me", {
    headers: { authorization: "Bearer secret-token" },
  }), env(), d);
  assert.equal(denied.status, 429);
  const again = await handle(new Request("https://push-be.example/api/v1/auth/me", {
    headers: { authorization: "Bearer secret-token" },
  }), env(), d);
  assert.equal(again.status, 429);
  assert.equal(calls, 1);
});

test("auth still succeeds when the shared counter query fails", async () => {
  resetLimits();
  const query: Query = async (sql) => {
    if (sql.includes("rate_limits")) throw new Error("undefined_table");
    if (sql.includes("access_tokens")) {
      return [{ id: USER, display_name: "Ada", locale: "ko", created_at: "2026-01-02T03:04:05Z", expires_at: "2099-01-01T00:00:00Z" }];
    }
    return [];
  };
  const res = await handle(new Request("https://push-be.example/api/v1/auth/me", {
    headers: { authorization: "Bearer secret-token" },
  }), env(), deps(query));
  assert.equal(res.status, 200);
  assert.match(await res.text(), /"displayName": "Ada"/);
});

test("api healthz uses the shared public counter", async () => {
  resetLimits();
  const seen: { sql: string; params: unknown[] }[] = [];
  const res = await handle(new Request("https://push-be.example/api/v1/healthz", {
    headers: { "cf-connecting-ip": "203.0.113.5" },
  }), env(), deps(async (sql, params) => {
    seen.push({ sql, params });
    return [{ hits: 1 }];
  }));
  assert.equal(res.status, 200);
  assert.equal(seen.length, 1);
  assert.match(seen[0].sql, /rate_limits/);
  assert.match(seen[0].sql, /rate_limits\.hits < \$3/);
  assert.equal(seen[0].params[0], `ip:203.0.113.5:${Math.floor(NOW.getTime() / 1000 / 60)}`);
  assert.equal(seen[0].params[2], 60);
});

test("a full public counter does not write again", async () => {
  resetLimits();
  let calls = 0;
  const d = deps(async () => {
    calls += 1;
    return [];
  }, { limits: { user: 600, public: 1, windowMs: 60_000 } });
  const first = await handle(new Request("https://push-be.example/api/v1/healthz", {
    headers: { "cf-connecting-ip": "203.0.113.9" },
  }), env(), d);
  assert.equal(first.status, 429);
  const second = await handle(new Request("https://push-be.example/api/v1/healthz", {
    headers: { "cf-connecting-ip": "203.0.113.9" },
  }), env(), d);
  assert.equal(second.status, 429);
  assert.equal(calls, 1);
});

test("a rejected python proxy and a broken cache still return a response", async () => {
  resetLimits();
  const auth: Query = async (sql) => {
    if (sql.includes("access_tokens")) {
      return [{ id: USER, display_name: "Ada", locale: "ko", created_at: "2026-01-02T03:04:05Z", expires_at: "2099-01-01T00:00:00Z" }];
    }
    if (sql.includes("rate_limits")) return [{ hits: 1 }];
    if (sql.includes("ai_keys")) return [{ has: false }];
    return [];
  };
  const failed = await handle(new Request("https://push-be.example/api/v1/conversations", {
    method: "POST",
    headers: { authorization: "Bearer secret-token", "content-type": "application/json" },
    body: "{}",
  }), env({ async fetch() { throw new Error("socket stolen"); } }), deps(auth));
  assert.equal(failed.status, 500);
  assert.equal((await failed.json() as { error: { code: string } }).error.code, "INTERNAL");

  const empty = await handle(new Request(`https://push-be.example/api/v1/conversations/${USER}/messages/stream/active`, {
    headers: { authorization: "Bearer secret-token", origin: "http://localhost:5173" },
  }), env(), deps(async (sql) => {
    if (sql.includes("chat_events")) return [];
    if (sql.includes("access_tokens")) {
      return [{
        id: USER, display_name: "Ada", locale: "ko",
        created_at: "2026-01-02T03:04:05Z", expires_at: "2099-01-01T00:00:00Z",
        hits: 1, conversation_id: USER, job_id: null,
      }];
    }
    if (sql.includes("rate_limits")) return [{ hits: 1 }];
    if (sql.includes("FROM conversations")) return [{ id: USER }];
    return [];
  }));
  assert.equal(empty.status, 204);
  assert.equal(empty.headers.get("access-control-allow-origin"), "http://localhost:5173");
  assert.equal(await empty.text(), "");

  const cache = {
    async match() { return undefined; },
    async put() { throw new Error("cache put failed"); },
    async delete() { return false; },
  };
  const models = await handle(new Request("https://push-be.example/api/v1/ai/models", {
    headers: { authorization: "Bearer secret-token" },
  }), env(), deps(auth, { cache }));
  assert.equal(models.status, 200);
  assert.match(await models.text(), /"data":/);
});

test("auth cache skips Neon until logout or the TTL", async () => {
  resetLimits();
  const seen: string[] = [];
  let revoked = false;
  const query: Query = async (sql) => {
    seen.push(sql);
    if (revoked) return [];
    if (sql.includes("access_tokens")) {
      return [{
        id: USER, display_name: "Ada", locale: "ko",
        created_at: "2026-01-02T03:04:05Z", expires_at: "2099-01-01T00:00:00Z",
        hits: 4, granted: 4,
      }];
    }
    return [];
  };
  const d = deps(query);
  const first = await handle(new Request("https://push-be.example/api/v1/auth/me", {
    headers: { authorization: "Bearer secret-token" },
  }), env(), d);
  assert.equal(first.status, 200);
  const second = await handle(new Request("https://push-be.example/api/v1/auth/me", {
    headers: { authorization: "Bearer secret-token" },
  }), env(), d);
  assert.equal(second.status, 200);
  assert.equal(seen.length, 1);

  const api = { async fetch() { return new Response(null, { status: 204 }); } };
  const logout = await handle(new Request("https://push-be.example/api/v1/auth/logout", {
    method: "POST",
    headers: { authorization: "Bearer secret-token" },
  }), env(api), d);
  assert.equal(logout.status, 204);
  revoked = true;
  const after = await handle(new Request("https://push-be.example/api/v1/auth/me", {
    headers: { authorization: "Bearer secret-token" },
  }), env(), d);
  assert.equal(after.status, 401);
  assert.equal(seen.length, 3);
  assert.ok(seen.some((sql) => sql.includes("GREATEST(0, hits")));
});

test("auth cache expires and the next request syncs Neon", async () => {
  resetLimits();
  let now = NOW;
  let calls = 0;
  const query: Query = async (sql) => {
    calls += 1;
    if (sql.includes("access_tokens")) {
      return [{
        id: USER, display_name: "Ada", locale: "ko",
        created_at: "2026-01-02T03:04:05Z", expires_at: "2099-01-01T00:00:00Z",
        hits: 4, granted: 4,
      }];
    }
    return [];
  };
  const d = deps(query, { now: () => now });
  const ok = await handle(new Request("https://push-be.example/api/v1/auth/me", {
    headers: { authorization: "Bearer secret-token" },
  }), env(), d);
  assert.equal(ok.status, 200);
  now = new Date(NOW.getTime() + 6_000);
  const again = await handle(new Request("https://push-be.example/api/v1/auth/me", {
    headers: { authorization: "Bearer secret-token" },
  }), env(), d);
  assert.equal(again.status, 200);
  assert.equal(calls, 2);
});

test("many isolates each serving a few requests stay near the cap", async () => {
  resetLimits();
  const limit = 600;
  const cap = limit - Math.floor(limit / 10);
  let counter = 0;
  const query: Query = async (sql, params) => {
    if (sql.includes("GREATEST(0, hits")) {
      counter = Math.max(0, counter - Number(params[1]));
      return [{ hits: counter }];
    }
    if (!sql.includes("access_tokens")) return [];
    assert.match(sql, /\$7::int > 0 OR rate_limits\.hits < \$4/);
    assert.match(sql, /LEAST\(\$6::int/);
    assert.match(sql, /EXTRACT\(EPOCH FROM expires_at\)/);
    assert.equal(Number(params[3]), cap);
    const batch = Number(params[5]);
    const release = Number(params[6]);
    assert.ok(batch >= 1 && batch <= 8);
    assert.match(sql, /\/ 16/);
    const after = Math.max(0, counter - release);
    if (release <= 0 && after >= cap) {
      return [{
        id: USER, display_name: "Ada", locale: "ko",
        created_at: "2026-01-02T03:04:05Z", expires_at: "2099-01-01T00:00:00Z",
        hits: null, granted: null,
      }];
    }
    const granted = Math.min(batch, Math.max(0, cap - after));
    counter = after + granted;
    return [{
      id: USER, display_name: "Ada", locale: "ko",
      created_at: "2026-01-02T03:04:05Z", expires_at: "2099-01-01T00:00:00Z",
      hits: counter, granted,
    }];
  };
  const headers = { authorization: "Bearer secret-token" };
  const limits = { user: limit, public: 60, windowMs: 60_000 };
  let ok = 0;
  for (let isolate = 0; isolate < 200; isolate += 1) {
    resetLimits();
    const d = deps(query, { limits });
    for (let n = 0; n < 3; n += 1) {
      const res = await handle(new Request("https://push-be.example/api/v1/auth/me", { headers }), env(), d);
      if (res.status === 200) ok += 1;
      else assert.equal(res.status, 429);
    }
  }
  assert.ok(ok >= Math.floor(limit * 0.9));
  assert.ok(counter <= cap);
  assert.ok(limit - counter >= Math.floor(limit / 10));
});

function shrunkGrant(batch: number, room: number): number {
  if (room <= 0) return 0;
  return Math.min(batch, room, Math.max(1, Math.floor(room / 16)));
}

function leasedQuery(counter: { hits: number }, cap: number): Query {
  return async (sql, params) => {
    if (sql.includes("GREATEST(0, hits")) {
      counter.hits = Math.max(0, counter.hits - Number(params[1]));
      return [{ hits: counter.hits }];
    }
    if (!sql.includes("access_tokens")) return [];
    const batch = Number(params[5]);
    const release = Number(params[6]);
    const after = Math.max(0, counter.hits - release);
    if (release <= 0 && after >= cap) {
      return [{
        id: USER, display_name: "Ada", locale: "ko",
        created_at: "2026-01-02T03:04:05Z", expires_at: "2099-01-01T00:00:00Z",
        hits: null, granted: null,
      }];
    }
    const granted = shrunkGrant(batch, Math.max(0, cap - after));
    counter.hits = after + granted;
    return [{
      id: USER, display_name: "Ada", locale: "ko",
      created_at: "2026-01-02T03:04:05Z", expires_at: "2099-01-01T00:00:00Z",
      hits: counter.hits, granted,
    }];
  };
}

test("a spread burst returns unused leases and serves at least 90% of 540", async () => {
  resetLimits();
  const limit = 600;
  const cap = limit - Math.floor(limit / 10);
  const counter = { hits: 0 };
  const headers = { authorization: "Bearer secret-token" };
  const limits = { user: limit, public: 60, windowMs: 60_000 };
  let ok = 0;
  for (let isolate = 0; isolate < 400 && ok < cap; isolate += 1) {
    resetLimits();
    const tasks: Promise<unknown>[] = [];
    const gates: Array<() => void> = [];
    const d = deps(leasedQuery(counter, cap), {
      limits,
      sleep: (ms) => new Promise((resolve) => {
        if (ms <= 0) resolve();
        else gates.push(resolve);
      }),
      waitUntil: (promise) => { tasks.push(promise); },
    });
    for (let n = 0; n < 2; n += 1) {
      const res = await handle(new Request("https://push-be.example/api/v1/auth/me", { headers }), env(), d);
      if (res.status === 200) ok += 1;
      else assert.equal(res.status, 429);
    }
    for (const open of gates.splice(0)) open();
    await Promise.all(tasks);
  }
  assert.ok(ok >= Math.floor(cap * 0.9), `served ${ok} of ${cap}`);
  assert.ok(counter.hits <= cap);
  assert.ok(counter.hits >= ok);
  // A single leftover under a quarter of the cap is left in place.
  assert.ok(counter.hits - ok <= Math.floor(cap / 4));
  assert.ok(limit - cap >= Math.floor(limit / 10));
});

test("fifty fresh leases and 300 requests do not false-429", async () => {
  resetLimits();
  const limit = 600;
  const cap = limit - Math.floor(limit / 10);
  const counter = { hits: 0 };
  const limits = { user: limit, public: 60, windowMs: 60_000 };
  const tasks: Promise<unknown>[] = [];
  const gates: Array<() => void> = [];
  const slept: number[] = [];
  const d = deps(leasedQuery(counter, cap), {
    limits,
    sleep: (ms) => new Promise((resolve) => {
      slept.push(ms);
      if (ms <= 0) resolve();
      else gates.push(resolve);
    }),
    waitUntil: (promise) => { tasks.push(promise); },
  });
  let ok = 0;
  let denied = 0;
  for (let isolate = 0; isolate < 50; isolate += 1) {
    const headers = { authorization: `Bearer fresh-token-${isolate}` };
    for (let n = 0; n < 6; n += 1) {
      const res = await handle(new Request("https://push-be.example/api/v1/auth/me", { headers }), env(), d);
      if (res.status === 200) ok += 1;
      else {
        assert.equal(res.status, 429);
        denied += 1;
      }
    }
  }
  assert.equal(ok, 300);
  assert.equal(denied, 0);
  assert.ok(counter.hits <= cap);
  assert.ok(counter.hits > ok);
  for (const open of gates.splice(0)) open();
  await Promise.all(tasks);
  assert.ok(counter.hits >= ok);
  assert.ok(counter.hits - ok <= Math.floor(cap / 4));
  assert.ok(slept.some((ms) => ms > 0 && ms <= 1000));
});

test("a mostly unused lease near the cap returns immediately", async () => {
  resetLimits();
  const limit = 600;
  const cap = limit - Math.floor(limit / 10);
  const counter = { hits: 500 };
  const limits = { user: limit, public: 60, windowMs: 60_000 };
  const slept: number[] = [];
  const tasks: Promise<unknown>[] = [];
  const d = deps(leasedQuery(counter, cap), {
    limits,
    sleep: async (ms) => { slept.push(ms); },
    waitUntil: (promise) => { tasks.push(promise); },
  });
  const headers = { authorization: "Bearer near-cap-token" };
  const first = await handle(new Request("https://push-be.example/api/v1/auth/me", { headers }), env(), d);
  const second = await handle(new Request("https://push-be.example/api/v1/auth/me", { headers }), env(), d);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  await Promise.all(tasks);
  assert.ok(slept.includes(0));
  assert.equal(counter.hits, 502);
});

async function settle(gates: Array<() => void>, tasks: Promise<unknown>[]): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) {
    const pending = tasks.splice(0);
    const open = gates.splice(0);
    if (pending.length === 0 && open.length === 0) return;
    for (const release of open) release();
    await Promise.all(pending);
  }
}

test("concurrent requests in one isolate return the whole unused pool", async () => {
  resetLimits();
  const limit = 600;
  const cap = limit - Math.floor(limit / 10);
  const counter = { hits: 0 };
  let releases = 0;
  let hold = false;
  const waiting: Array<() => void> = [];
  const query: Query = async (sql, params) => {
    if (hold && sql.includes("access_tokens")) {
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    if (sql.includes("GREATEST(0, hits")) {
      releases += 1;
      counter.hits = Math.max(0, counter.hits - Number(params[1]));
      return [{ hits: counter.hits }];
    }
    return leasedQuery(counter, cap)(sql, params);
  };
  const limits = { user: limit, public: 60, windowMs: 60_000 };
  const tasks: Promise<unknown>[] = [];
  const gates: Array<() => void> = [];
  const d = deps(query, {
    limits,
    sleep: (ms) => new Promise((resolve) => {
      if (ms <= 0) resolve();
      else gates.push(resolve);
    }),
    waitUntil: (promise) => { tasks.push(promise); },
  });
  const headers = { authorization: "Bearer same-isolate" };
  const one = () => handle(new Request("https://push-be.example/api/v1/auth/me", { headers }), env(), d);
  for (let n = 0; n < 7; n += 1) {
    const primed = await one();
    assert.equal(primed.status, 200);
  }
  hold = true;
  const burstPromise = Promise.all(Array.from({ length: 40 }, () => one()));
  for (let spin = 0; waiting.length < 40 && spin < 1000; spin += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.equal(waiting.length, 40);
  for (const go of waiting.splice(0)) go();
  const burst = await burstPromise;
  const ok = burst.filter((res) => res.status === 200).length + 7;
  assert.equal(ok, 47);
  await settle(gates, tasks);
  assert.equal(counter.hits, ok);
  assert.ok(releases >= 1);
  assert.ok(releases < ok / 2, `release queries ${releases} for ${ok} served`);
});

test("one unused hit far from the cap skips the return query", async () => {
  resetLimits();
  const cap = 540;
  const counter = { hits: 0 };
  let releases = 0;
  const query: Query = async (sql, params) => {
    if (sql.includes("GREATEST(0, hits")) {
      releases += 1;
      counter.hits = Math.max(0, counter.hits - Number(params[1]));
      return [{ hits: counter.hits }];
    }
    return leasedQuery(counter, cap)(sql, params);
  };
  const tasks: Promise<unknown>[] = [];
  const gates: Array<() => void> = [];
  const d = deps(query, {
    limits: { user: 600, public: 60, windowMs: 60_000 },
    sleep: (ms) => new Promise((resolve) => {
      if (ms <= 0) resolve();
      else gates.push(resolve);
    }),
    waitUntil: (promise) => { tasks.push(promise); },
  });
  const headers = { authorization: "Bearer quiet-token" };
  const first = await handle(new Request("https://push-be.example/api/v1/auth/me", { headers }), env(), d);
  const second = await handle(new Request("https://push-be.example/api/v1/auth/me", { headers }), env(), d);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  await settle(gates, tasks);
  assert.equal(releases, 0);
  assert.equal(counter.hits, 3);
});

test("an idle isolate returns the unused lease", async () => {
  resetLimits();
  let counter = 0;
  const cap = 90;
  let now = NOW;
  const query: Query = async (sql, params) => {
    if (sql.includes("GREATEST(0, hits")) {
      counter = Math.max(0, counter - Number(params[1]));
      return [{ hits: counter }];
    }
    if (!sql.includes("access_tokens")) return [];
    const batch = Number(params[5]);
    const release = Number(params[6]);
    const after = Math.max(0, counter - release);
    const granted = Math.min(batch, Math.max(0, cap - after));
    counter = after + granted;
    return [{
      id: USER, display_name: "Ada", locale: "ko",
      created_at: "2026-01-02T03:04:05Z", expires_at: "2099-01-01T00:00:00Z",
      hits: counter, granted,
    }];
  };
  const d = deps(query, {
    limits: { user: 100, public: 60, windowMs: 60_000 },
    now: () => now,
  });
  const headers = { authorization: "Bearer secret-token" };
  const first = await handle(new Request("https://push-be.example/api/v1/auth/me", { headers }), env(), d);
  const second = await handle(new Request("https://push-be.example/api/v1/auth/me", { headers }), env(), d);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(counter, 3);
  now = new Date(NOW.getTime() + 6_000);
  await releaseExpired(d, now.getTime());
  assert.equal(counter, 2);

  now = new Date(NOW.getTime() + 58_000);
  const late = await handle(new Request("https://push-be.example/api/v1/auth/me", { headers }), env(), d);
  const again = await handle(new Request("https://push-be.example/api/v1/auth/me", { headers }), env(), d);
  assert.equal(late.status, 200);
  assert.equal(again.status, 200);
  const held = counter;
  now = new Date(NOW.getTime() + 60_000);
  const rolled = await handle(new Request("https://push-be.example/api/v1/auth/me", { headers }), env(), d);
  assert.equal(rolled.status, 200);
  assert.equal(counter, held);
});

test("per-user reads are fresh and isolated", async () => {
  resetLimits();
  const userB = "22345678-1234-5678-1234-567812345678";
  const hashA = await sha256Hex("token-a");
  const hashB = await sha256Hex("token-b");
  let wrote = false;
  const seen: string[] = [];
  const query: Query = async (sql, params) => {
    seen.push(sql);
    const key = String(params[0]);
    const mine = key === hashA || key === USER;
    const id = mine ? USER : userB;
    const title = wrote && mine ? "A의 새 채팅" : (mine ? "A의 채팅" : "B의 채팅");
    const row = {
      id, revision: 1, application_id: null, title, pinned: false,
      created_at: "2026-10-17T21:57:28Z", updated_at: "2026-10-17T21:57:28Z",
    };
    if (sql.includes("access_tokens")) {
      return [{
        id, display_name: mine ? "Ada" : "Bea", locale: "ko",
        created_at: "2026-01-02T03:04:05Z", expires_at: "2099-01-01T00:00:00Z",
        hits: 1, rows: [row],
      }];
    }
    if (sql.includes("FROM conversations")) return [row];
    return [];
  };
  const d = deps(query);
  const list = (token: string) => handle(new Request("https://push-be.example/api/v1/conversations", {
    headers: { authorization: `Bearer ${token}` },
  }), env(), d);
  const first = await list("token-a");
  assert.equal(first.status, 200);
  assert.equal((await first.json() as { data: { title: string }[] }).data[0].title, "A의 채팅");
  wrote = true;
  const fresh = await list("token-a");
  assert.equal((await fresh.json() as { data: { title: string }[] }).data[0].title, "A의 새 채팅");
  assert.equal(seen.length, 2);

  const other = await list("token-b");
  const otherBody = await other.json() as { data: { title: string }[] };
  assert.equal(otherBody.data[0].title, "B의 채팅");
  assert.equal(seen.length, 3);
  assert.equal(hashB.length, 64);
});

test("message reads stay on that user and refresh after a write", async () => {
  resetLimits();
  let wrote = false;
  let calls = 0;
  const query: Query = async (sql) => {
    calls += 1;
    const message = {
      id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      conversation_id: USER,
      role: "USER",
      text: wrote ? "다음" : "안녕",
      attachments: [],
      operation_id: null,
      created_at: "2026-10-17T21:57:28Z",
    };
    if (sql.includes("access_tokens")) {
      return [{
        id: USER, display_name: "Ada", locale: "ko",
        created_at: "2026-01-02T03:04:05Z", expires_at: "2099-01-01T00:00:00Z",
        hits: 1, conversation_id: USER, rows: [message],
      }];
    }
    if (sql.includes("FROM conversations")) return [{ id: USER }];
    if (sql.includes("FROM messages")) return [message];
    return [];
  };
  const d = deps(query);
  const read = () => handle(new Request(`https://push-be.example/api/v1/conversations/${USER}/messages`, {
    headers: { authorization: "Bearer secret-token" },
  }), env(), d);
  const first = await read();
  assert.equal((await first.json() as { data: { text: string }[] }).data[0].text, "안녕");
  wrote = true;
  const fresh = await read();
  assert.equal((await fresh.json() as { data: { text: string }[] }).data[0].text, "다음");
  assert.equal(calls, 2);
});

test("a matching list ETag is 304 after a fresh read", async () => {
  resetLimits();
  let calls = 0;
  const query: Query = async (sql) => {
    calls += 1;
    if (sql.includes("access_tokens")) {
      return [{
        id: USER, display_name: "Ada", locale: "ko",
        created_at: "2026-01-02T03:04:05Z", expires_at: "2099-01-01T00:00:00Z",
        hits: 1, rows: [],
      }];
    }
    return [];
  };
  const d = deps(query);
  const first = await handle(new Request("https://push-be.example/api/v1/conversations", {
    headers: { authorization: "Bearer secret-token" },
  }), env(), d);
  assert.equal(first.status, 200);
  assert.match(first.headers.get("cache-control") || "", /private, no-cache/);
  assert.match(first.headers.get("vary") || "", /Authorization/);
  const etag = first.headers.get("etag") || "";
  assert.match(etag, /^W\/"[0-9a-f]{8}"$/);
  const second = await handle(new Request("https://push-be.example/api/v1/conversations", {
    headers: { authorization: "Bearer secret-token", "if-none-match": etag },
  }), env(), d);
  assert.equal(second.status, 304);
  assert.equal(await second.text(), "");
  assert.equal(calls, 2);
});

async function sha256Hex(value: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

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

test("recruiting stays on core and AI_ORIGIN is an opt-in HTTPS target", async () => {
  resetLimits();
  const forwarded: string[] = [];
  const python = {
    async fetch(request: Request) {
      forwarded.push("python " + new URL(request.url).pathname);
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    },
  };
  const core = {
    async fetch(request: Request) {
      forwarded.push("core " + new URL(request.url).pathname);
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    },
  };
  const postings = await handle(new Request("https://push-be.example/api/v1/postings"), env(python, core), deps(async () => []));
  assert.equal(postings.status, 200);
  const upload = await handle(new Request("https://push-be.example/api/v1/uploads/images", { method: "POST" }), env(python, core), deps(async () => []));
  assert.equal(upload.status, 200);
  assert.deepEqual(forwarded, ["core /api/v1/postings", "python /api/v1/uploads/images"]);

  let target = "";
  let secret = "";
  const hosted = env(python, core);
  hosted.AI_ORIGIN = "https://ai.example.test";
  hosted.AI_SHARED_SECRET = "test-secret";
  const generated = await handle(new Request("https://push-be.example/api/v1/ai/generate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  }), hosted, deps(async () => [], {
    fetch: async (input, init) => {
      target = String(input);
      secret = new Headers(init?.headers).get("x-push-ai-secret") || "";
      return new Response("{}", { status: 202 });
    },
  }));
  assert.equal(generated.status, 202);
  assert.equal(target, "https://ai.example.test/api/v1/ai/generate");
  assert.equal(secret, "test-secret");
  assert.equal(forwarded.length, 2);
});

test("auth/me returns employer membership from the joined row", async () => {
  resetLimits();
  let sql = "";
  const query: Query = async (text) => {
    sql = text;
    if (text.includes("access_tokens")) {
      return [{
        id: USER, display_name: "Ada", locale: "ko",
        created_at: "2026-01-02T03:04:05.000001Z",
        expires_at: "2099-01-01T00:00:00Z",
        is_employer: true,
        company_id: "cccccccc-cccc-cccc-cccc-cccccccccccc",
        company_role: "ADMIN",
      }];
    }
    return [];
  };
  const res = await handle(new Request("https://push-be.example/api/v1/auth/me", {
    headers: { authorization: "Bearer secret-token" },
  }), env(), deps(query));
  assert.equal(res.status, 200);
  assert.match(sql, /company_members/);
  assert.match(sql, /is_employer/);
  assert.equal(await res.text(),
    '{"data": {"id": "12345678-1234-5678-1234-567812345678", "displayName": "Ada", "locale": "ko", "createdAt": "2026-01-02T03:04:05.000001Z", "accountType": "EMPLOYER", "companyId": "cccccccc-cccc-cccc-cccc-cccccccccccc", "companyRole": "ADMIN"}}');
});

test("email auth posts are owned by core", () => {
  for (const path of [
    "/api/v1/auth/email/signup",
    "/api/v1/auth/email/verify",
    "/api/v1/auth/email/login",
    "/api/v1/auth/email/password-reset",
    "/api/v1/auth/email/password-reset/confirm",
  ]) {
    assert.equal(ownerOf("POST", path), "core");
  }
});

test("company routes are owned by core", () => {
  for (const path of [
    "/api/v1/companies",
    "/api/v1/companies/verify",
    "/api/v1/companies/me",
    "/api/v1/companies/me/members",
    "/api/v1/companies/me/invites",
    "/api/v1/companies/invites/tok/accept",
    "/api/v1/companies/me/members/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  ]) {
    assert.equal(ownerOf("GET", path), "core");
    assert.equal(ownerOf("POST", path), "core");
    assert.equal(ownerOf("PATCH", path), "core");
    assert.equal(ownerOf("DELETE", path), "core");
  }
  assert.equal(ownerOf("GET", "/api/v1/companies-extra"), "python");
});

test("billing top-up, iap, and store webhooks are owned by core", () => {
  assert.equal(ownerOf("POST", "/api/v1/billing/topup"), "core");
  assert.equal(ownerOf("POST", "/api/v1/billing/iap/verify"), "core");
  assert.equal(ownerOf("POST", "/api/v1/billing/webhook/app-store"), "core");
  assert.equal(ownerOf("POST", "/api/v1/billing/webhook/google-play"), "core");
  assert.equal(ownerOf("POST", "/api/v1/internal/notifications/ai-done"), "core");
  assert.equal(ownerOf("POST", "/api/v1/internal/notifications/run"), "core");
  assert.equal(ownerOf("GET", "/api/v1/internal/notifications/run"), "python");
  assert.equal(ownerOf("GET", "/api/v1/billing/topup"), "python");
});

const COMPANY = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

test("personal conversation list sql excludes company rows", async () => {
  resetLimits();
  const seen: string[] = [];
  const res = await handle(new Request("https://push-be.example/api/v1/conversations", {
    headers: { authorization: "Bearer secret-token" },
  }), env(), deps(async (sql) => {
    seen.push(sql);
    if (sql.includes("access_tokens")) {
      return [{
        id: USER, display_name: "Ada", locale: "ko",
        created_at: "2026-01-02T03:04:05Z", expires_at: "2099-01-01T00:00:00Z",
        hits: 1, rows: [],
      }];
    }
    return [];
  }));
  assert.equal(res.status, 200);
  const listSql = seen.find((sql) => sql.includes("FROM conversations")) ?? "";
  assert.match(listSql, /company_id IS NULL/);
});

test("employer conversation list sql filters by the caller company", async () => {
  resetLimits();
  const seen: Array<[string, unknown[]]> = [];
  const res = await handle(new Request("https://push-be.example/api/v1/conversations?audience=EMPLOYER", {
    headers: { authorization: "Bearer secret-token" },
  }), env(), deps(async (sql, params) => {
    seen.push([sql, params]);
    if (sql.includes("access_tokens")) {
      return [{
        id: USER, display_name: "Ada", locale: "ko",
        created_at: "2026-01-02T03:04:05Z", expires_at: "2099-01-01T00:00:00Z",
        is_employer: true, company_id: COMPANY, company_role: "MEMBER",
        hits: 1, rows: [],
      }];
    }
    return [];
  }));
  assert.equal(res.status, 200);
  const list = seen.find(([sql]) => sql.includes("FROM conversations") && !sql.includes("access_tokens"));
  assert.ok(list);
  assert.match(list[0], /company_id = \$1::uuid/);
  assert.equal(list[1][0], COMPANY);
  assert.doesNotMatch(list[0], /user_id = \$1/);
});

test("conversation pdf upload is owned by core", () => {
  assert.equal(ownerOf("POST", "/api/v1/conversations/" + USER + "/attachments"), "core");
  assert.equal(ownerOf("GET", "/api/v1/conversations/" + USER + "/attachments"), "python");
});

const SHARED_CONV = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

test("company message reads include a teammate and ignore the author filter", async () => {
  resetLimits();
  const seen: string[] = [];
  const message = {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    conversation_id: SHARED_CONV,
    role: "USER",
    text: "팀 메시지",
    attachments: [],
    operation_id: null,
    created_at: "2026-10-17T21:57:28Z",
  };
  const res = await handle(new Request("https://push-be.example/api/v1/conversations/" + SHARED_CONV + "/messages", {
    headers: { authorization: "Bearer secret-token" },
  }), env(), deps(async (sql) => {
    seen.push(sql);
    if (sql.includes("json_agg")) {
      return [{
        id: USER, display_name: "Ada", locale: "ko",
        created_at: "2026-01-02T03:04:05Z", expires_at: "2099-01-01T00:00:00Z",
        is_employer: true, company_id: COMPANY, company_role: "MEMBER",
        hits: 1, conversation_id: SHARED_CONV, rows: [message],
      }];
    }
    return [];
  }));
  assert.equal(res.status, 200);
  const sql = seen.find((item) => item.includes("FROM messages")) ?? "";
  assert.match(sql, /company_id = \(SELECT company_id FROM auth\)/);
  assert.match(sql, /found\.company_id IS NOT NULL/);
  const body = await res.json() as { data: { text: string }[] };
  assert.equal(body.data[0].text, "팀 메시지");
});

test("an active company job is visible to a teammate", async () => {
  resetLimits();
  const seen: string[] = [];
  const res = await handle(new Request("https://push-be.example/api/v1/conversations/" + SHARED_CONV + "/messages/stream/active", {
    headers: { authorization: "Bearer secret-token" },
  }), env(), deps(async (sql) => {
    seen.push(sql);
    if (sql.includes("access_tokens")) {
      return [{
        id: USER, display_name: "Ada", locale: "ko",
        created_at: "2026-01-02T03:04:05Z", expires_at: "2099-01-01T00:00:00Z",
        is_employer: true, company_id: COMPANY, company_role: "MEMBER",
        hits: 1, conversation_id: SHARED_CONV, job_id: null,
      }];
    }
    return [];
  }));
  assert.equal(res.status, 204);
  const sql = seen.find((item) => item.includes("chat_jobs")) ?? "";
  assert.match(sql, /company_id = \(SELECT company_id FROM auth\)/);
  assert.match(sql, /company_id FROM found\) IS NOT NULL/);
});
