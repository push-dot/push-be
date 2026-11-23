import assert from "node:assert/strict";
import { test } from "node:test";

import { handle, resetLimits } from '../src/handler.ts';
import type { Deps, FrontEnv, Query } from '../src/handler.ts';

const USER = "12345678-1234-5678-1234-567812345678";
const NOW = new Date("2026-10-18T00:00:10Z");
const env = { APP_ENV: "production" } as FrontEnv;

interface Gate { open?: () => void }

// The release query never settles before the end, so a request that waited on it would hang until the timeout fails the test.
test("returning another token's stale lease does not hold up this request", { timeout: 10_000 }, async () => {
  resetLimits();
  let now = NOW;
  const gate: Gate = {};
  const released: Array<Array<unknown>> = [];
  const background: Array<Promise<unknown>> = [];
  const query: Query = async (sql, params) => {
    if (sql.includes("GREATEST(0, hits")) {
      released.push(params);
      await new Promise<void>((resolve) => { gate.open = resolve; });
      return [];
    }
    return [{ id: USER, created_at: "2026-01-02T03:04:05Z", expires_at: "2099-01-01T00:00:00Z", hits: 4, granted: 4 }];
  };
  const deps = {
    query, now: () => now, sleep: () => new Promise<void>(() => {}),
    waitUntil: (promise) => { background.push(promise); },
  } as Deps;
  const me = (token: string) => handle(new Request("https://push-be.example/api/v1/auth/me", {
    headers: { authorization: `Bearer ${token}` },
  }), env, deps);

  assert.equal((await me("token-a")).status, 200);
  now = new Date(NOW.getTime() + 6000);
  assert.equal((await me("token-b")).status, 200);
  assert.deepEqual(released.map((params) => params[1]), [3]);
  gate.open?.();
  assert.ok(background.length >= 1);
});
