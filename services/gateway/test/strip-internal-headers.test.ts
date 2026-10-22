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
    API: binding,
    CORE: binding,
    APP_ENV: "production",
  } as FrontEnv;
  const deps = { query: async () => [], now: () => new Date("2026-10-21T00:00:00.000Z") } as Deps;
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
