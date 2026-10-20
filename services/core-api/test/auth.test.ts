import assert from "node:assert/strict";
import { test } from "node:test";

import { handle, type CoreEnv, type Deps } from "../src/handler.ts";
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
