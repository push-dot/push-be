import assert from "node:assert/strict";
import { test } from "node:test";

import { handle, type CoreEnv, type Deps } from "../src/handler.ts";
import { resetLimits } from "../src/ratelimit.ts";

const USER = "12345678-1234-5678-1234-567812345678";
const OTHER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
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

const settingsRow = () => ({
  notify_deadline: true, notify_offer: true, notify_comment: true, notify_ai_done: true,
  notify_application_stage: true, locale: "ko", profile_public: true,
  career_status_visibility: "everyone", hide_from_current_company: false,
  contact_visibility: "accepted", default_tone: "as_is", chat_retention_days: null,
  allow_ai_read_my_files: true,
});

test("auth me adds email, provider, and plan", async () => {
  resetLimits();
  const res = await handle(get("/api/v1/auth/me"), env(), deps(authed([], async () => empty)));
  assert.equal(res.status, 200);
  const body = await res.json() as { data: { email: string; provider: string; plan: string } };
  assert.equal(body.data.email, "ada@push.app");
  assert.equal(body.data.provider, "email");
  assert.equal(body.data.plan, "PRO");
});

test("settings omit retired effort and retention fields", async () => {
  resetLimits();
  const seen: Call[] = [];
  const res = await handle(get("/api/v1/me/settings"), env(), deps(authed(seen, async (sql) => {
    if (sql.includes("INSERT INTO user_settings")) return empty;
    if (sql.includes("user_settings")) return { rows: [settingsRow()], rowCount: 1 };
    return empty;
  })));
  assert.equal(res.status, 200);
  const body = await res.json() as { data: Record<string, unknown> };
  assert.equal("defaultEffort" in body.data, false);
  assert.equal("confirmBeforeEdit" in body.data, false);
  assert.equal("chatRetentionDays" in body.data, false);
  assert.equal(body.data.aiAccessMode, "AUTO");
  const select = seen.find((call) => call.sql.includes("user_settings") && call.sql.includes("to_jsonb"));
  assert.ok(select);
  assert.doesNotMatch(select?.sql ?? "", /default_effort|confirm_before_edit|chat_retention_days/);

  resetLimits();
  const patchedSeen: Call[] = [];
  const patched = await handle(patch("/api/v1/me/settings", {
    defaultEffort: "HIGH",
    confirmBeforeEdit: false,
    chatRetentionDays: 7,
    aiAccessMode: "BYPASS",
  }), env(), deps(authed(patchedSeen, async (sql) => {
    if (sql.includes("INSERT INTO user_settings")) return empty;
    if (sql.includes("user_settings") || sql.includes("FROM users")) return { rows: [settingsRow()], rowCount: 1 };
    return empty;
  })));
  assert.equal(patched.status, 200);
  const update = patchedSeen.find((call) => call.sql.includes("UPDATE user_settings"));
  assert.doesNotMatch(update?.sql ?? "", /default_effort|confirm_before_edit|chat_retention_days/);
  assert.match(update?.sql ?? "", /ai_access_mode = \$14/);
  assert.equal(update?.params[13], "BYPASS");
});

test("profile contact follows the visibility setting", async () => {
  resetLimits();
  const self = await handle(get("/api/v1/me/profile"), env(), deps(authed([], async (sql) => {
    if (sql.includes("INSERT INTO profiles")) return empty;
    if (sql.includes("SELECT email FROM users")) return { rows: [{ email: "ada@push.app" }], rowCount: 1 };
    if (sql.includes("FROM profiles")) {
      return {
        rows: [{
          user_id: USER, display_name: "Ada", contact: "010", contact_visibility: "private",
          updated_at: NOW, profile_public: true,
        }],
        rowCount: 1,
      };
    }
    return empty;
  })));
  assert.equal(self.status, 200);
  assert.equal((await self.json() as { data: { contact: string | null } }).data.contact, "010");

  resetLimits();
  const hidden = await handle(get(`/api/v1/profiles/${OTHER}`), env(), deps(authed([], async (sql) => {
    if (sql.includes("SELECT email FROM users")) return { rows: [{ email: "ada@push.app" }], rowCount: 1 };
    if (sql.includes("FROM profiles")) {
      return {
        rows: [{
          user_id: OTHER, display_name: "Bea", contact: "010", contact_visibility: "private",
          updated_at: NOW, profile_public: true, following: false, offer_accepted: false,
        }],
        rowCount: 1,
      };
    }
    return empty;
  })));
  assert.equal(hidden.status, 200);
  assert.equal((await hidden.json() as { data: { contact: string | null } }).data.contact, null);

  resetLimits();
  const open = await handle(get(`/api/v1/profiles/${OTHER}`), env(), deps(authed([], async (sql) => {
    if (sql.includes("SELECT email FROM users")) return { rows: [{ email: "" }], rowCount: 1 };
    if (sql.includes("FROM profiles")) {
      return {
        rows: [{
          user_id: OTHER, display_name: "Bea", contact: "010", contact_visibility: "everyone",
          updated_at: NOW, profile_public: true,
        }],
        rowCount: 1,
      };
    }
    return empty;
  })));
  assert.equal((await open.json() as { data: { contact: string | null } }).data.contact, "010");

  resetLimits();
  const followed = await handle(get(`/api/v1/profiles/${OTHER}`), env(), deps(authed([], async (sql) => {
    if (sql.includes("SELECT email FROM users")) return empty;
    if (sql.includes("FROM profiles")) {
      return {
        rows: [{
          user_id: OTHER, display_name: "Bea", contact: "010", contact_visibility: "followers",
          updated_at: NOW, profile_public: true, following: true,
        }],
        rowCount: 1,
      };
    }
    return empty;
  })));
  assert.equal((await followed.json() as { data: { contact: string | null } }).data.contact, "010");

  resetLimits();
  const accepted = await handle(get(`/api/v1/profiles/${OTHER}`), env(), deps(authed([], async (sql) => {
    if (sql.includes("SELECT email FROM users")) return empty;
    if (sql.includes("FROM profiles")) {
      return {
        rows: [{
          user_id: OTHER, display_name: "Bea", contact: "010", contact_visibility: "accepted",
          updated_at: NOW, profile_public: true, following: false, offer_accepted: true,
        }],
        rowCount: 1,
      };
    }
    return empty;
  })));
  assert.equal((await accepted.json() as { data: { contact: string | null } }).data.contact, "010");
  const acceptedSql = "";
  assert.equal(acceptedSql, "");
});
