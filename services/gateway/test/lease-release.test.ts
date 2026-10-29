import assert from "node:assert/strict";
import { test } from "node:test";

import { handle, resetLimits, type Deps, type FrontEnv, type Query } from "../src/handler.ts";

const USER = "12345678-1234-5678-1234-567812345678";
const NOW = new Date("2026-10-18T00:00:10Z");
const env = { APP_ENV: "production" } as FrontEnv;

test("returning another token's stale lease does not hold up this request", async () => {
  resetLimits();
  let now = NOW;
  let openRelease: () => void = () => {};
  const released: unknown[][] = [];
  const background: Promise<unknown>[] = [];
  const query: Query = async (sql, params) => {
    if (sql.includes("GREATEST(0, hits")) {
      released.push(params);
      await new Promise<void>((resolve) => { openRelease = resolve; });
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
  now = new Date(NOW.getTime() + 6_000);
  const late = await Promise.race([me("token-b"), new Promise<string>((r) => setTimeout(() => r("blocked"), 50))]);
  assert.notEqual(late, "blocked");
  assert.equal((late as Response).status, 200);
  assert.deepEqual(released.map((params) => params[1]), [3]);
  openRelease();
  assert.ok(background.length >= 1);
});
