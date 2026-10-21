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
    APP_ENV: "production", MANAGED_AI: "1", MANAGED_GO: "0",
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
    if (init?.method === "GET") return Response.json({ data: [{ id: "sub_1" }, { id: "sub_2" }] });
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
    if (init?.method === "GET") return Response.json({ data: [{ id: "sub_1" }, { id: "sub_2" }] });
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
    APP_ENV: "production", MANAGED_AI: "1", MANAGED_GO: "0",
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
