import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { test } from "node:test";

import { candidatePaths, isInternal, METHODS, specRouteFor, specRoutes } from "../../../packages/contracts/drift.ts";
import { dispatch } from "../src/handler.ts";
import type { Ctx, UserRow } from "../src/types.ts";

const SRC = new URL("../src/", import.meta.url).pathname;
const FILES = [`${SRC}handler.ts`, ...readdirSync(`${SRC}routes`).map((name) => `${SRC}routes/${name}`)];

const USER: UserRow = {
  id: "12345678-1234-5678-1234-567812345678", displayName: "probe", locale: "ko", email: "probe@example.com",
  provider: "email", plan: "PRO", subscriptionStatus: "ACTIVE", stripeCustomerId: null, periodEndsAt: null,
  createdAt: "", accountType: "PERSONAL", companyId: null, companyRole: null,
};

const serves = async (method: string, path: string): Promise<boolean> => {
  let touched = false;
  const refuse = async (): Promise<never> => {
    touched = true;
    throw new Error("probe");
  };
  const url = new URL("https://core.test" + path);
  const request = new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: method === "GET" || method === "DELETE" ? undefined : "{}",
  });
  const ctx: Ctx = { request, env: {}, deps: { query: refuse, fetch: refuse }, rid: "probe", url, user: USER, now: new Date() };
  try {
    const res = await dispatch(ctx, path);
    if (touched || res.status !== 404) return true;
    return !(await res.text()).includes("resource not found");
  } catch {
    return true;
  }
};

test("every route core serves is in openapi.json or listed as internal", async () => {
  const missing: string[] = [];
  for (const path of candidatePaths(FILES)) {
    for (const method of METHODS) {
      if (!(await serves(method, path))) continue;
      if (!specRouteFor(method, path) && !isInternal(method, path)) missing.push(`${method} ${path}`);
    }
  }
  assert.deepEqual(missing, []);
});

test("every core route in openapi.json is served by core", async () => {
  const stale: string[] = [];
  for (const route of specRoutes.filter((r) => r.owner === "core")) {
    if (!(await serves(route.method, route.path))) stale.push(`${route.method} ${route.template}`);
  }
  assert.deepEqual(stale, []);
});
