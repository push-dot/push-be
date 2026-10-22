import assert from "node:assert/strict";
import { test } from "node:test";

import { handle, type CoreEnv, type Deps } from "../src/handler.ts";
import { resetLimits } from "../src/ratelimit.ts";

const USER = "12345678-1234-5678-1234-567812345678";
const NOW = "2026-10-21T00:00:00.000Z";

type Call = { sql: string; params: unknown[] };

const env = (): CoreEnv => ({ APP_ENV: "production", MANAGED_AI: "1", MANAGED_GO: "0" });
const deps = (query: Deps["query"]): Deps => ({ query, now: () => new Date(NOW) });
const empty = { rows: [] as Record<string, unknown>[], rowCount: 0 };

const authed = (seen: Call[], extra: Deps["query"]): Deps["query"] => async (sql, params = []) => {
  seen.push({ sql, params });
  if (sql.includes("rate_limits")) return { rows: [{ hits: 1 }], rowCount: 1 };
  if (sql.includes("access_tokens")) {
    return {
      rows: [{
        id: USER, display_name: "Ada", locale: "ko", plan: "PRO", subscription_status: "NONE",
        created_at: NOW, token_expires_at: "2099-01-01T00:00:00Z", is_employer: false,
        email: "ada@push.app", provider: "email",
      }],
      rowCount: 1,
    };
  }
  if (sql.includes("idempotency_keys") && sql.includes("INSERT")) return { rows: [{ id: "1" }], rowCount: 1 };
  if (sql.includes("idempotency_keys")) return empty;
  if (sql.includes("is_employer") && sql.includes("FROM users") && !sql.includes("access_tokens")) {
    return { rows: [{ is_employer: false }], rowCount: 1 };
  }
  return extra(sql, params);
};

const get = (path: string): Request => new Request("https://core.example" + path, {
  headers: { authorization: "Bearer secret-token" },
});

const patch = (path: string, body: unknown): Request => new Request("https://core.example" + path, {
  method: "PATCH",
  headers: { authorization: "Bearer secret-token", "content-type": "application/json" },
  body: JSON.stringify(body),
});

const settingsRow = (mode: string | null = null) => ({
  notify_deadline: true, notify_offer: true, notify_comment: true, notify_ai_done: true,
  notify_application_stage: true, locale: "ko", profile_public: true,
  career_status_visibility: "everyone", hide_from_current_company: false,
  contact_visibility: "accepted", default_tone: "as_is", chat_retention_days: null,
  allow_ai_read_my_files: true, default_effort: "MEDIUM", confirm_before_edit: true,
  ai_access_mode: mode,
});

test("settings round-trip aiAccessMode and reject an unknown mode", async () => {
  resetLimits();
  const seen: Call[] = [];
  let stored: string | null = null;
  const query = authed(seen, async (sql, params) => {
    if (sql.includes("INSERT INTO user_settings")) return empty;
    if (sql.includes("UPDATE user_settings")) {
      stored = String(params?.[16] ?? stored);
      return empty;
    }
    if (sql.includes("user_settings")) return { rows: [settingsRow(stored)], rowCount: 1 };
    return empty;
  });

  const patched = await handle(patch("/api/v1/me/settings", { aiAccessMode: "BYPASS" }), env(), deps(query));
  assert.equal(patched.status, 200);
  assert.equal((await patched.json() as { data: { aiAccessMode: string } }).data.aiAccessMode, "BYPASS");

  resetLimits();
  const loaded = await handle(get("/api/v1/me/settings"), env(), deps(query));
  assert.equal(loaded.status, 200);
  assert.equal((await loaded.json() as { data: { aiAccessMode: string } }).data.aiAccessMode, "BYPASS");
  const update = seen.find((call) => call.sql.includes("UPDATE user_settings"));
  assert.match(update?.sql ?? "", /ai_access_mode = \$17/);
  assert.match(update?.sql ?? "", /default_effort = \$15/);
  assert.equal(update?.params[16], "BYPASS");

  resetLimits();
  const bad = await handle(patch("/api/v1/me/settings", { aiAccessMode: "YOLO" }), env(), deps(authed([], async (sql) => {
    if (sql.includes("INSERT INTO user_settings")) return empty;
    if (sql.includes("user_settings")) return { rows: [settingsRow("AUTO")], rowCount: 1 };
    return empty;
  })));
  assert.equal(bad.status, 400);
  assert.equal((await bad.json() as { error: { code: string } }).error.code, "VALIDATION_ERROR");
});

test("a message stores the canonical access mode in both keys", async () => {
  resetLimits();
  const seen: Call[] = [];
  const api = { fetch: async () => new Response("{}", { status: 200 }) };
  const res = await handle(new Request("https://core.example/api/v1/conversations/" + USER + "/messages", {
    method: "POST",
    headers: {
      authorization: "Bearer secret-token",
      "content-type": "application/json",
      "idempotency-key": "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    },
    body: JSON.stringify({ text: "hi", accessMode: "CONFIRM_ACTIONS" }),
  }), { ...env(), API: api } as CoreEnv, deps(authed(seen, async (sql) => {
    if (sql.includes("chat_jobs")) return { rows: [{ id: "job-1" }], rowCount: 1 };
    return empty;
  })));
  assert.equal(res.status, 202);
  const insert = seen.find((call) => call.sql.includes("chat_jobs"));
  const payload = JSON.parse(String(insert?.params[3]));
  assert.equal(payload.accessMode, "ALWAYS_ASK");
  assert.equal(payload.access_mode, "ALWAYS_ASK");

  resetLimits();
  const unknown = await handle(new Request("https://core.example/api/v1/conversations/" + USER + "/messages", {
    method: "POST",
    headers: {
      authorization: "Bearer secret-token",
      "content-type": "application/json",
      "idempotency-key": "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    },
    body: JSON.stringify({ text: "hi", accessMode: "YOLO" }),
  }), env(), deps(authed([], async () => empty)));
  assert.equal(unknown.status, 400);
  assert.equal((await unknown.json() as { error: { code: string } }).error.code, "VALIDATION_ERROR");
});
