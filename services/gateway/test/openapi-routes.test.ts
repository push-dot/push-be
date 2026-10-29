import assert from "node:assert/strict";
import { test } from "node:test";

import { candidatePaths, isInternal, METHODS, specRouteFor, specRoutes } from "../../../packages/contracts/drift.ts";
import { handle, resetLimits, type Deps, type FrontEnv } from "../src/handler.ts";

const SRC = new URL("../src/", import.meta.url).pathname;
const FILES = [`${SRC}handler.ts`, `${SRC}routes/owner.ts`];

type Owner = "gateway" | "core" | "ai" | "deny";

const binding = (name: string): NonNullable<FrontEnv["CORE"]> => ({
  fetch: async () => new Response(JSON.stringify({ probe: name }), { status: 202, headers: { "content-type": "application/json" } }),
});

const ENV: FrontEnv = {
  CORE: binding("core"),
  APP_ENV: "production",
  SSE_MAX_POLLS: "1",
  AI_ORIGIN: "https://ai.example.test",
  AI_SHARED_SECRET: "secret",
};
const DEPS: Deps = {
  query: async () => [],
  sleep: async () => {},
  waitUntil: () => {},
  fetch: async () => new Response(JSON.stringify({ probe: "ai" }), { status: 202, headers: { "content-type": "application/json" } }),
};

const ownerOfRoute = async (method: string, path: string): Promise<Owner> => {
  resetLimits();
  const body = method === "GET" || method === "DELETE" ? undefined : "{}";
  const res = await handle(new Request("https://push-be.example" + path, { method, body }), ENV, DEPS);
  const text = await res.text();
  if (text.includes('"probe":"core"')) return "core";
  if (text.includes('"probe":"ai"')) return "ai";
  if (res.status === 404 && text.includes("resource not found")) return "deny";
  return "gateway";
};

test("every route in openapi.json reaches its x-owner through the gateway", async () => {
  const wrong: string[] = [];
  for (const route of specRoutes) {
    const owner = await ownerOfRoute(route.method, route.path);
    if (owner !== route.owner) wrong.push(`${route.method} ${route.template}: spec ${route.owner}, gateway ${owner}`);
  }
  assert.deepEqual(wrong, []);
});

test("every route the gateway or the AI worker answers is in openapi.json", async () => {
  const missing: string[] = [];
  for (const path of candidatePaths(FILES)) {
    for (const method of METHODS) {
      const owner = await ownerOfRoute(method, path);
      if (owner !== "gateway" && owner !== "ai") continue;
      if (specRouteFor(method, path)?.owner !== owner && !isInternal(method, path)) missing.push(`${method} ${path} (${owner})`);
    }
  }
  assert.deepEqual(missing, []);
});
