import assert from "node:assert/strict";
import { test } from "node:test";

import { handle, resetLimits, type Deps, type FrontEnv } from "../src/handler.ts";
import { ownerOf } from "../src/routes/owner.ts";

const USER = "12345678-1234-5678-1234-567812345678";

const headers = {
  authorization: "Bearer secret-token",
  "x-push-internal": "1",
  "x-push-internal-secret": "secret",
  "x-push-act-as": USER,
  "x-push-company": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
};

test("the gateway strips act-as headers and denies /internal", async () => {
  assert.equal(ownerOf("POST", "/internal/ai/jobs"), "deny");
  assert.equal(ownerOf("GET", "/internal"), "deny");
  resetLimits();
  const seen: Request[] = [];
  const binding = {
    fetch: async (request: Request) => {
      seen.push(request);
      return new Response('{"data":[]}', { status: 200, headers: { "content-type": "application/json" } });
    },
  };
  const env = {
    DATABASE_URL: "postgres://example",
    CORE: binding,
    APP_ENV: "production",
    AI_ORIGIN: "https://ai.example.test",
    AI_SHARED_SECRET: "real",
  } as FrontEnv;
  const deps = {
    query: async () => [],
    now: () => new Date("2026-10-21T00:00:00.000Z"),
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Request(String(input), init));
      return new Response('{"data":[]}', { status: 200, headers: { "content-type": "application/json" } });
    },
  } as Deps;
  const core = await handle(new Request("https://push-be.example/api/v1/me/bookmarks", { headers }), env, deps);
  assert.equal(core.status, 200);
  assert.equal(seen[0].headers.get("x-push-internal"), null);
  assert.equal(seen[0].headers.get("x-push-internal-secret"), null);
  assert.equal(seen[0].headers.get("x-push-act-as"), null);
  assert.equal(seen[0].headers.get("x-push-company"), null);

  const python = await handle(new Request("https://push-be.example/api/v1/ai/generate", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: "{}",
  }), env, deps);
  assert.equal(python.status, 200);
  assert.equal(seen[1].headers.get("x-push-internal-secret"), null);
  assert.equal(seen[1].headers.get("x-push-act-as"), null);
  assert.equal(seen[1].headers.get("x-push-company"), null);

  const hidden = await handle(new Request("https://push-be.example/internal/ai/jobs", {
    method: "POST",
    headers,
    body: "{}",
  }), env, deps);
  assert.equal(hidden.status, 404);
  assert.equal(seen.length, 2);
});

test("the gateway forwards act-as headers to core only with the internal secret", async () => {
  resetLimits();
  const seen: Request[] = [];
  const binding = {
    fetch: async (request: Request) => {
      seen.push(request);
      return new Response('{"data":[]}', { status: 200, headers: { "content-type": "application/json" } });
    },
  };
  const env = {
    DATABASE_URL: "postgres://example",
    CORE: binding,
    APP_ENV: "production",
    INTERNAL_API_SECRET: "secret",
    AI_ORIGIN: "https://ai.example.test",
    AI_SHARED_SECRET: "real",
  } as FrontEnv;
  const deps = {
    query: async () => [],
    now: () => new Date("2026-10-21T00:00:00.000Z"),
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Request(String(input), init));
      return new Response('{"data":[]}', { status: 200, headers: { "content-type": "application/json" } });
    },
  } as Deps;
  const internal = { "x-push-internal-secret": "secret", "x-push-act-as": USER, "x-push-company": headers["x-push-company"] };

  const ok = await handle(new Request("https://push-be.example/api/v1/me/bookmarks", { headers: internal }), env, deps);
  assert.equal(ok.status, 200);
  assert.equal(seen[0].headers.get("x-push-internal-secret"), "secret");
  assert.equal(seen[0].headers.get("x-push-act-as"), USER);
  assert.equal(seen[0].headers.get("x-push-company"), headers["x-push-company"]);

  await handle(new Request("https://push-be.example/api/v1/me/bookmarks", {
    headers: { ...internal, "x-push-internal-secret": "wrong" },
  }), env, deps);
  assert.equal(seen[1].headers.get("x-push-internal-secret"), null);
  assert.equal(seen[1].headers.get("x-push-act-as"), null);

  await handle(new Request("https://push-be.example/api/v1/ai/generate", {
    method: "POST",
    headers: { ...internal, "content-type": "application/json" },
    body: "{}",
  }), env, deps);
  assert.equal(seen[2].headers.get("x-push-internal-secret"), null);
  assert.equal(seen[2].headers.get("x-push-act-as"), null);
});

test("act-as-only core routes go to core", () => {
  assert.equal(ownerOf("POST", "/api/v1/documents/d1/edits"), "core");
  assert.equal(ownerOf("POST", "/api/v1/conversations/c1/resume-jobs"), "core");
  assert.equal(ownerOf("GET", "/api/v1/conversations/c1/artifacts/05_final_resume.pdf"), "core");
  assert.equal(ownerOf("GET", "/api/v1/conversations/c1/artifacts"), "python");
});

const capture = () => {
  const seen: Request[] = [];
  const binding = {
    fetch: async (request: Request) => {
      seen.push(request);
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    },
  };
  return { seen, binding };
};

const spoofed = {
  "x-push-ai-secret": "client-guess",
  "x-push-dispatch-secret": "client-guess",
  "x-push-user": USER,
};

test("client copies of any x-push header are dropped on every route", async () => {
  resetLimits();
  const { seen, binding } = capture();
  const env = {
    CORE: binding,
    APP_ENV: "production",
    INTERNAL_API_SECRET: "secret",
    AI_ORIGIN: "https://ai.example.test",
    AI_SHARED_SECRET: "real",
  } as FrontEnv;
  const deps = {
    query: async () => [],
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Request(String(input), init));
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    },
  } as Deps;
  await handle(new Request("https://push-be.example/api/v1/me/bookmarks", { headers: spoofed }), env, deps);
  await handle(new Request("https://push-be.example/api/v1/me/bookmarks", {
    headers: { ...spoofed, "x-push-internal-secret": "secret", "x-push-act-as": USER },
  }), env, deps);
  await handle(new Request("https://push-be.example/api/v1/ai/generate", {
    method: "POST", headers: { ...spoofed, "content-type": "application/json" }, body: "{}",
  }), env, deps);
  assert.equal(seen.length, 3);
  for (const request of seen.slice(0, 2)) {
    for (const name of Object.keys(spoofed)) assert.equal(request.headers.get(name), null, name);
  }
  assert.equal(seen[1].headers.get("x-push-act-as"), USER);
  assert.equal(seen[2].headers.get("x-push-ai-secret"), "real");
  assert.equal(seen[2].headers.get("x-push-dispatch-secret"), null);
  assert.equal(seen[2].headers.get("x-push-user"), null);
});

test("AI_ORIGIN unset returns 500 and does not call a binding", async () => {
  resetLimits();
  let calls = 0;
  const binding = {
    fetch: async () => {
      calls += 1;
      return new Response("{}");
    },
  };
  const env = { CORE: binding, APP_ENV: "production" } as FrontEnv;
  const deps = {
    query: async () => [],
    fetch: async () => {
      calls += 1;
      return new Response("{}");
    },
  } as Deps;
  const res = await handle(new Request("https://push-be.example/api/v1/ai/generate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  }), env, deps);
  assert.equal(res.status, 500);
  assert.equal((await res.json() as { error: { code: string } }).error.code, "NOT_CONFIGURED");
  assert.equal(calls, 0);
});

test("AI_ORIGIN replaces a client secret and refuses plain HTTP or a missing secret", async () => {
  resetLimits();
  const sent: Array<{ url: string; secret: string | null }> = [];
  const deps = {
    query: async () => [],
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      sent.push({ url: String(input), secret: new Headers(init?.headers).get("x-push-ai-secret") });
      return new Response("{}", { status: 202 });
    },
  } as Deps;
  const post = () => new Request("https://push-be.example/api/v1/ai/generate", {
    method: "POST", headers: { "content-type": "application/json", "x-push-ai-secret": "client-guess" }, body: "{}",
  });
  const base = { APP_ENV: "production" };

  const ok = await handle(post(), { ...base, AI_ORIGIN: "https://ai.example.test", AI_SHARED_SECRET: "real" } as FrontEnv, deps);
  assert.equal(ok.status, 202);
  assert.deepEqual(sent, [{ url: "https://ai.example.test/api/v1/ai/generate", secret: "real" }]);

  const noSecret = await handle(post(), { ...base, AI_ORIGIN: "https://ai.example.test" } as FrontEnv, deps);
  assert.equal(noSecret.status, 500);
  const plain = await handle(post(), { ...base, AI_ORIGIN: "http://ai.example.test", AI_SHARED_SECRET: "real" } as FrontEnv, deps);
  assert.equal(plain.status, 500);
  assert.equal(sent.length, 1);
});

test("a declared body over 20 MiB is refused before it is read or forwarded", async () => {
  resetLimits();
  const { seen, binding } = capture();
  const env = { CORE: binding, APP_ENV: "production" } as FrontEnv;
  const deps = { query: async () => [] } as Deps;
  const big = await handle(new Request("https://push-be.example/api/v1/sources", {
    method: "POST", headers: { "content-length": String((20 << 20) + 1) }, body: "x",
  }), env, deps);
  assert.equal(big.status, 413);
  assert.equal((await big.json() as { error: { code: string } }).error.code, "PAYLOAD_TOO_LARGE");
  const small = await handle(new Request("https://push-be.example/api/v1/sources", {
    method: "POST", headers: { "content-type": "application/json" }, body: '{"a":1}',
  }), env, deps);
  assert.equal(small.status, 200);
  assert.equal(seen.length, 1);
  assert.equal(await seen[0].text(), '{"a":1}');
});
