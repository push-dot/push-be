import assert from "node:assert/strict";
import { test } from "node:test";

import { handle, type CoreEnv, type Deps } from "../src/handler.ts";
import { clearDeletion } from "../src/routes/auth.ts";
import type { Ctx } from "../src/types.ts";
import { resetLimits } from "../src/ratelimit.ts";

const NOW = new Date("2026-10-21T00:00:00Z");

test("github callback sends a User-Agent when fetching the user", async () => {
  resetLimits();
  const env = {
    APP_ENV: "production", MANAGED_AI: "1",
    GITHUB_CLIENT_ID: "id", GITHUB_CLIENT_SECRET: "secret",
  } as CoreEnv;
  const query: Deps["query"] = async (sql) => {
    if (sql.includes("rate_limits")) return { rows: [{ hits: 1 }], rowCount: 1 };
    if (sql.includes("FROM oauth_states")) {
      return {
        rows: [{
          state: "s1", provider: "github", code_challenge: "c", redirect_uri: "https://x/cb",
          final_uri: "push://auth/callback", expires_at: "2099-01-01T00:00:00Z",
        }],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 1 };
  };
  // Mirrors api.github.com: 403 without a User-Agent header.
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("access_token")) return Response.json({ access_token: "gho_x" });
    const ua = new Headers(init?.headers).get("user-agent");
    return ua ? Response.json({ id: 42, login: "ada" }) : new Response("forbidden", { status: 403 });
  };
  const res = await handle(
    new Request("https://core.example/api/v1/auth/github/callback?code=abc&state=s1"),
    env,
    { query, now: () => NOW, fetch: fetch as typeof globalThis.fetch },
  );
  assert.equal(res.status, 302);
  assert.match(res.headers.get("location") ?? "", /^push:\/\/auth\/callback\?code=/);
});

function deletionDeps(stripeOk: boolean) {
  const sqls: string[] = [];
  const stripeCalls: string[] = [];
  const query: Deps["query"] = async (sql) => {
    sqls.push(sql);
    if (sql.includes("rate_limits")) return { rows: [{ hits: 1 }], rowCount: 1 };
    if (sql.includes("FROM users WHERE id")) {
      return { rows: [{ id: "u1", display_name: "a", locale: "ko", plan: "PRO", subscription_status: "ACTIVE", stripe_customer_id: "cus_1", period_ends_at: null, created_at: NOW.toISOString() }], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  };
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    stripeCalls.push(`${init?.method} ${String(input).replace("https://api.stripe.com", "")}`);
    if (!stripeOk) return Response.json({ error: {} }, { status: 500 });
    if (init?.method === "GET") return Response.json({ data: [{ id: "sub_1", status: "active" }, { id: "sub_2", status: "past_due" }, { id: "sub_3", status: "incomplete_expired" }] });
    return Response.json({ id: "sub", status: "canceled" });
  };
  const env = { APP_ENV: "development", DEV_AUTH_TOKEN: "dev", DEV_USER_ID: "u1", STRIPE_SECRET_KEY: "sk" } as CoreEnv;
  const call = () => handle(
    new Request("https://core.example/api/v1/me", { method: "DELETE", headers: { authorization: "Bearer dev" } }),
    env,
    { query, now: () => NOW, fetch: fetch as typeof globalThis.fetch },
  );
  return { sqls, stripeCalls, call };
}

test("DELETE /me cancels subscriptions, marks the account, and revokes tokens", async () => {
  resetLimits();
  const d = deletionDeps(true);
  const res = await d.call();
  assert.equal(res.status, 204);
  assert.deepEqual(d.stripeCalls, [
    "GET /v1/subscriptions?limit=100&customer=cus_1",
    "DELETE /v1/subscriptions/sub_1",
    "DELETE /v1/subscriptions/sub_2",
  ]);
  assert.ok(d.sqls.some((s) => s.includes("SET deletion_requested_at = $2")));
  assert.ok(d.sqls.some((s) => s.includes("UPDATE refresh_tokens SET revoked_at")));
});

test("DELETE /me keeps the account when Stripe cancel fails", async () => {
  resetLimits();
  const d = deletionDeps(false);
  const res = await d.call();
  assert.equal(res.status, 502);
  assert.ok(d.sqls.some((s) => s.includes("SET deletion_requested_at = NULL WHERE id = $1")), "mark is undone");
});

test("DELETE /me still deletes when the companies table is missing", async () => {
  resetLimits();
  const stripeCalls: string[] = [];
  const query: Deps["query"] = async (sql) => {
    if (sql.includes("company_members") || sql.includes("UPDATE companies")) {
      throw Object.assign(new Error('relation "companies" does not exist'), { code: "42P01" });
    }
    if (sql.includes("rate_limits")) return { rows: [{ hits: 1 }], rowCount: 1 };
    if (sql.includes("FROM users WHERE id")) {
      return { rows: [{ id: "u1", display_name: "a", locale: "ko", plan: "PRO", subscription_status: "ACTIVE", stripe_customer_id: "cus_1", period_ends_at: null, created_at: NOW.toISOString() }], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  };
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    stripeCalls.push(`${init?.method} ${String(input).replace("https://api.stripe.com", "")}`);
    if (init?.method === "GET") return Response.json({ data: [{ id: "sub_1", status: "active" }, { id: "sub_2", status: "past_due" }, { id: "sub_3", status: "incomplete_expired" }] });
    return Response.json({ id: "sub", status: "canceled" });
  };
  const env = { APP_ENV: "development", DEV_AUTH_TOKEN: "dev", DEV_USER_ID: "u1", STRIPE_SECRET_KEY: "sk" } as CoreEnv;
  const res = await handle(
    new Request("https://core.example/api/v1/me", { method: "DELETE", headers: { authorization: "Bearer dev" } }),
    env,
    { query, now: () => NOW, fetch: fetch as typeof globalThis.fetch },
  );
  assert.equal(res.status, 204);
  assert.deepEqual(stripeCalls, [
    "GET /v1/subscriptions?limit=100&customer=cus_1",
    "DELETE /v1/subscriptions/sub_1",
    "DELETE /v1/subscriptions/sub_2",
  ]);
});

test("clearDeletion ignores a missing companies table", async () => {
  const query: Deps["query"] = async (sql) => {
    if (sql.includes("UPDATE companies")) {
      throw Object.assign(new Error('relation "companies" does not exist'), { code: "42P01" });
    }
    return { rows: [], rowCount: 1 };
  };
  await clearDeletion({ deps: { query } } as Ctx, "u1");
});

test("login still works before migration 0018 is applied", async () => {
  resetLimits();
  const env = {
    APP_ENV: "production", MANAGED_AI: "1",
    GITHUB_CLIENT_ID: "id", GITHUB_CLIENT_SECRET: "secret",
  } as CoreEnv;
  const query: Deps["query"] = async (sql) => {
    if (sql.includes("rate_limits")) return { rows: [{ hits: 1 }], rowCount: 1 };
    if (sql.includes("deletion_requested_at")) throw Object.assign(new Error('column "deletion_requested_at" does not exist'), { code: "42703" });
    if (sql.includes("FROM oauth_states")) {
      return {
        rows: [{
          state: "s1", provider: "github", code_challenge: "c", redirect_uri: "https://x/cb",
          final_uri: "push://auth/callback", expires_at: "2099-01-01T00:00:00Z",
        }],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 1 };
  };
  const fetch = async (input: RequestInfo | URL) =>
    String(input).includes("access_token") ? Response.json({ access_token: "gho_x" }) : Response.json({ id: 42, login: "ada" });
  const res = await handle(
    new Request("https://core.example/api/v1/auth/github/callback?code=abc&state=s1"),
    env,
    { query, now: () => NOW, fetch: fetch as typeof globalThis.fetch },
  );
  assert.equal(res.status, 302);
});

test("logout deletes the caller's push token, or all of the user's when none is sent", async () => {
  const seen: { sql: string; params: unknown[] }[] = [];
  const query: Deps["query"] = async (sql, params = []) => {
    seen.push({ sql, params });
    if (sql.includes("rate_limits")) return { rows: [{ hits: 1 }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  };
  const logout = (body: Record<string, unknown>) => handle(
    new Request("https://core.example/api/v1/auth/logout", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }),
    { APP_ENV: "production" } as CoreEnv,
    { query, now: () => NOW },
  );
  resetLimits();
  assert.equal((await logout({ refreshToken: "r1", pushToken: "ExponentPushToken[a]" })).status, 204);
  assert.equal((await logout({ refreshToken: "r1" })).status, 204);
  const calls = seen.filter((c) => c.sql.includes("DELETE FROM user_devices"));
  assert.equal(calls.length, 2);
  assert.match(calls[0].sql, /user_id IN \(SELECT user_id FROM target\) AND \(\$3::text IS NULL OR token = \$3::text\)/);
  assert.equal(calls[0].params[2], "ExponentPushToken[a]");
  assert.equal(calls[1].params[2], null);
});

const reauthDeps = (loginAt: string | null | "none") => {
  const sqls: string[] = [];
  const stripeCalls: string[] = [];
  const query: Deps["query"] = async (sql) => {
    sqls.push(sql);
    if (sql.includes("rate_limits")) return { rows: [{ hits: 1 }], rowCount: 1 };
    if (sql.includes("FROM access_tokens t JOIN users u")) {
      return { rows: [{ id: "u1", display_name: "a", locale: "ko", plan: "FREE", subscription_status: "NONE", stripe_customer_id: null, period_ends_at: null, created_at: NOW.toISOString(), token_expires_at: "2099-01-01T00:00:00Z" }], rowCount: 1 };
    }
    if (sql.includes("r.login_at")) return loginAt === "none" ? { rows: [], rowCount: 0 } : { rows: [{ login_at: loginAt }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  };
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    stripeCalls.push(`${init?.method} ${String(input)}`);
    return Response.json({ data: [] });
  };
  const call = () => handle(
    new Request("https://core.example/api/v1/me", { method: "DELETE", headers: { authorization: "Bearer session-token" } }),
    { APP_ENV: "production", MANAGED_AI: "1" } as CoreEnv,
    { query, now: () => NOW, fetch: fetch as typeof globalThis.fetch },
  );
  return { sqls, stripeCalls, call };
};

test("DELETE /me within 10 minutes of sign-in is allowed", async () => {
  resetLimits();
  const d = reauthDeps(new Date(NOW.getTime() - 9 * 60 * 1000).toISOString());
  assert.equal((await d.call()).status, 204);
});

for (const [name, loginAt] of [["older than 10 minutes", new Date(NOW.getTime() - 11 * 60 * 1000).toISOString()], ["unknown", null], ["missing", "none"]] as const) {
  test(`DELETE /me is REAUTH_REQUIRED when the sign-in time is ${name}`, async () => {
    resetLimits();
    const d = reauthDeps(loginAt);
    const res = await d.call();
    assert.equal(res.status, 403);
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, "REAUTH_REQUIRED");
    assert.deepEqual(d.stripeCalls, []);
    assert.equal(d.sqls.some((s) => s.includes("deletion_requested_at")), false);
  });
}

test("refresh keeps the original sign-in time", async () => {
  resetLimits();
  const loginAt = "2026-10-20T23:55:00.000Z";
  let inserted: unknown[] = [];
  const query: Deps["query"] = async (sql, params = []) => {
    if (sql.includes("rate_limits")) return { rows: [{ hits: 1 }], rowCount: 1 };
    if (sql.includes("FROM refresh_tokens WHERE token_hash")) {
      return { rows: [{ id: "r1", user_id: "u1", expires_at: "2099-01-01T00:00:00Z", revoked_at: null, login_at: new Date(loginAt) }], rowCount: 1 };
    }
    if (sql.includes("WITH revoked AS (UPDATE refresh_tokens")) return { rows: [{ id: "r1" }], rowCount: 1 };
    if (sql.includes("INSERT INTO refresh_tokens")) inserted = params;
    if (sql.includes("FROM users WHERE id")) {
      return { rows: [{ id: "u1", display_name: "a", locale: "ko", created_at: NOW.toISOString() }], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  };
  const res = await handle(
    new Request("https://core.example/api/v1/auth/refresh", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ refreshToken: "t" }) }),
    { APP_ENV: "production", MANAGED_AI: "1" } as CoreEnv,
    { query, now: () => NOW },
  );
  assert.equal(res.status, 200);
  assert.equal(inserted[8], loginAt);
});
