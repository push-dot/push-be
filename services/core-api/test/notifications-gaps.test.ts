import assert from "node:assert/strict";
import { test } from "node:test";

import { handle, type CoreEnv, type Deps } from "../src/handler.ts";
import { resetLimits } from "../src/ratelimit.ts";

const USER = "12345678-1234-5678-1234-567812345678";
const OTHER = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const POST = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PARENT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OFFER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const CONV = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const NOW = "2026-10-21T00:00:00.000Z";

type Call = { sql: string; params: unknown[] };

const env = (extra: Partial<CoreEnv> = {}): CoreEnv => ({
  APP_ENV: "production", MANAGED_AI: "1", MANAGED_GO: "0", ...extra,
});

const deps = (query: Deps["query"], fetchImpl?: typeof fetch): Deps => ({
  query, now: () => new Date(NOW), fetch: fetchImpl,
});

const authed = (seen: Call[], extra: Deps["query"]): Deps["query"] => async (sql, params = []) => {
  seen.push({ sql, params });
  if (sql.includes("rate_limits")) return { rows: [{ hits: 1 }], rowCount: 1 };
  if (sql.includes("access_tokens")) {
    return {
      rows: [{
        id: USER, display_name: "Ada", locale: "ko", plan: "FREE", subscription_status: "NONE",
        created_at: NOW, token_expires_at: "2099-01-01T00:00:00Z", is_employer: false,
      }],
      rowCount: 1,
    };
  }
  if (sql.includes("idempotency_keys") && sql.includes("INSERT")) {
    return { rows: [{ id: "11111111-1111-4111-8111-111111111111" }], rowCount: 1 };
  }
  if (sql.includes("idempotency_keys")) return { rows: [], rowCount: 0 };
  if (sql.includes("is_employer") && sql.includes("FROM users") && !sql.includes("access_tokens")) {
    return { rows: [{ is_employer: false, display_name: "Ada" }], rowCount: 1 };
  }
  return extra(sql, params);
};

const empty = { rows: [] as Record<string, unknown>[], rowCount: 0 };

const post = (path: string, body: unknown, key = "44444444-4444-4444-8444-444444444444"): Request => new Request("https://core.example" + path, {
  method: "POST",
  headers: {
    authorization: "Bearer secret-token",
    "content-type": "application/json",
    "idempotency-key": key,
  },
  body: JSON.stringify(body),
});

const titles = (seen: Call[]): unknown[] => seen
  .filter((call) => call.sql.includes("INSERT INTO notifications"))
  .map((call) => call.params[3]);

test("a reply stores parentId and tells the parent author", async () => {
  resetLimits();
  const seen: Call[] = [];
  const res = await handle(
    post(`/api/v1/posts/${POST}/comments`, { body: "동의해요", parentId: PARENT }),
    env(),
    deps(authed(seen, async (sql) => {
      if (sql.includes("FROM posts")) return { rows: [{ id: POST, user_id: OTHER, title: "글" }], rowCount: 1 };
      if (sql.includes("FROM post_comments")) {
        return { rows: [{ id: PARENT, user_id: "99999999-9999-4999-8999-999999999999" }], rowCount: 1 };
      }
      return empty;
    })),
  );
  assert.equal(res.status, 201);
  const body = await res.json() as { data: { parentId: string } };
  assert.equal(body.data.parentId, PARENT);
  const insert = seen.find((call) => call.sql.includes("INSERT INTO post_comments"));
  assert.ok(insert);
  assert.match(insert.sql, /parent_id/);
  assert.equal(insert.params.includes(PARENT), true);
  assert.equal(titles(seen).includes("답글을 남겼어요"), true);
  assert.equal(titles(seen).includes("새 댓글"), true);
});

test("ai-done is a job route and pushes only when expo is configured", async () => {
  resetLimits();
  const missing = await handle(new Request("https://core.example/api/v1/internal/notifications/ai-done", {
    method: "POST",
    headers: { authorization: "Bearer job-secret", "content-type": "application/json" },
    body: JSON.stringify({ userId: USER, conversationId: CONV }),
  }), env(), deps(async () => empty));
  assert.equal(missing.status, 503);

  resetLimits();
  const denied = await handle(new Request("https://core.example/api/v1/internal/notifications/ai-done", {
    method: "POST",
    headers: { authorization: "Bearer wrong", "content-type": "application/json" },
    body: JSON.stringify({ userId: USER, conversationId: CONV }),
  }), env({ INTERNAL_JOB_TOKEN: "job-secret" }), deps(async () => empty));
  assert.equal(denied.status, 401);

  resetLimits();
  const quiet: string[] = [];
  const seen: Call[] = [];
  const quietRes = await handle(new Request("https://core.example/api/v1/internal/notifications/ai-done", {
    method: "POST",
    headers: { authorization: "Bearer job-secret", "content-type": "application/json" },
    body: JSON.stringify({ userId: USER, conversationId: CONV }),
  }), env({ INTERNAL_JOB_TOKEN: "job-secret" }), deps(async (sql, params = []) => {
    seen.push({ sql, params });
    if (sql.includes("user_settings")) return { rows: [{ enabled: true }], rowCount: 1 };
    if (sql.includes("user_devices")) return { rows: [{ token: "ExponentPushToken[abc]" }], rowCount: 1 };
    return empty;
  }, async (input) => {
    quiet.push(String(input));
    return new Response("{}", { status: 200 });
  }));
  assert.equal(quietRes.status, 201);
  const inserted = seen.find((call) => call.sql.includes("INSERT INTO notifications"));
  assert.ok(inserted);
  assert.equal(inserted.params.includes("AI_DONE"), true);
  assert.equal(inserted.params.includes(USER), true);
  assert.equal(quiet.length, 0);

  resetLimits();
  const pushed: { url: string; authorization: string; body: string }[] = [];
  const loud = await handle(new Request("https://core.example/api/v1/internal/notifications/ai-done", {
    method: "POST",
    headers: { authorization: "Bearer job-secret", "content-type": "application/json" },
    body: JSON.stringify({ userId: USER, conversationId: CONV }),
  }), env({ INTERNAL_JOB_TOKEN: "job-secret", EXPO_ACCESS_TOKEN: "expo-secret" }), deps(async (sql) => {
    if (sql.includes("user_settings")) return { rows: [{ enabled: true }], rowCount: 1 };
    if (sql.includes("user_devices")) return { rows: [{ token: "ExponentPushToken[abc]" }], rowCount: 1 };
    return empty;
  }, async (input, init) => {
    pushed.push({
      url: String(input),
      authorization: new Headers(init?.headers).get("authorization") ?? "",
      body: String(init?.body ?? ""),
    });
    return new Response("{}", { status: 200 });
  }));
  assert.equal(loud.status, 201);
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0].url, "https://exp.host/--/api/v2/push/send");
  assert.equal(pushed[0].authorization, "Bearer expo-secret");
  assert.match(pushed[0].body, /ExponentPushToken\[abc\]/);
});

test("the notification job writes one D-3 deadline and one due reminder", async () => {
  resetLimits();
  const seen: Call[] = [];
  const res = await handle(new Request("https://core.example/api/v1/internal/notifications/run", {
    method: "POST",
    headers: { authorization: "Bearer job-secret" },
  }), env({ INTERNAL_JOB_TOKEN: "job-secret" }), deps(async (sql, params = []) => {
    seen.push({ sql, params });
    if (sql.includes("FROM bookmarks")) {
      assert.equal(params[0], "2026-10-24");
      return { rows: [{ user_id: OTHER, id: POST, title: "Backend" }], rowCount: 1 };
    }
    if (sql.includes("FROM calendar_events")) {
      return { rows: [{ id: "ffffffff-ffff-4fff-8fff-ffffffffffff", user_id: OTHER, title: "커피챗" }], rowCount: 1 };
    }
    if (sql.includes("notification_dedupes") && sql.includes("INSERT")) {
      return { rows: [{ dedupe_key: params[0] }], rowCount: 1 };
    }
    if (sql.includes("user_settings")) return { rows: [{ enabled: true }], rowCount: 1 };
    return empty;
  }));
  assert.equal(res.status, 200);
  const notes = seen.filter((call) => call.sql.includes("INSERT INTO notifications"));
  assert.equal(notes.length, 2);
  assert.equal(notes.some((call) => call.params.includes("DEADLINE")), true);
  assert.equal(notes.some((call) => call.params.includes("Backend")), true);
  assert.equal(notes.some((call) => call.params.includes("커피챗")), true);
});

test("accepting an offer and sending a message notify the other person", async () => {
  resetLimits();
  const offerRow = {
    id: OFFER, sender_id: OTHER, sender_name: "Bea", profile_user_id: USER, recipient_name: "Ada",
    message: "합류해요", posting_id: null, status: "READ", read_at: NOW, created_at: NOW,
    sender_company: "Acme", sender_headline: "Recruiter", sender_avatar: "avatars/bea.png",
  };
  const seen: Call[] = [];
  const accepted = await handle(
    post(`/api/v1/me/offers/${OFFER}/accept`, {}, "55555555-5555-4555-8555-555555555555"),
    env(),
    deps(authed(seen, async (sql) => {
      if (sql.includes("FROM offers")) return { rows: [offerRow], rowCount: 1 };
      if (sql.includes("user_settings")) return { rows: [{ enabled: true }], rowCount: 1 };
      return empty;
    })),
  );
  assert.equal(accepted.status, 200);
  const acceptBody = await accepted.json() as { data: { sender: { companyName: string | null; headline: string; avatarUrl: string | null } } };
  assert.equal(acceptBody.data.sender.companyName, "Acme");
  assert.equal(acceptBody.data.sender.headline, "Recruiter");
  assert.equal(acceptBody.data.sender.avatarUrl, "/api/v1/uploads/images/avatars%2Fbea.png");
  const acceptNote = seen.find((call) => call.sql.includes("INSERT INTO notifications"));
  assert.ok(acceptNote);
  assert.equal(acceptNote.params.includes(OTHER), true);
  assert.equal(acceptNote.params.includes("제안을 수락했어요"), true);

  resetLimits();
  const messageSeen: Call[] = [];
  const message = await handle(
    post(`/api/v1/me/offers/${OFFER}/messages`, { body: "내일 봐요" }, "66666666-6666-4666-8666-666666666666"),
    env(),
    deps(authed(messageSeen, async (sql) => {
      if (sql.includes("FROM offers")) return { rows: [{ ...offerRow, status: "ACCEPTED" }], rowCount: 1 };
      if (sql.includes("user_settings")) return { rows: [{ enabled: true }], rowCount: 1 };
      return empty;
    })),
  );
  assert.equal(message.status, 201);
  const messageNote = messageSeen.find((call) => call.sql.includes("INSERT INTO notifications"));
  assert.ok(messageNote);
  assert.equal(messageNote.params.includes(OTHER), true);
  assert.equal(messageNote.params.includes("새 메시지"), true);
});

test("unread notification count is the unread rows", async () => {
  resetLimits();
  const res = await handle(new Request("https://core.example/api/v1/me/notifications/unread", {
    headers: { authorization: "Bearer secret-token" },
  }), env(), deps(authed([], async (sql) => {
    if (sql.includes("count(*)") && sql.includes("notifications")) return { rows: [{ count: 3 }], rowCount: 1 };
    return empty;
  })));
  assert.equal(res.status, 200);
  const body = await res.json() as { data: { count: number } };
  assert.equal(body.data.count, 3);
});

test("calendar stores a coffee chat and remindAt", async () => {
  resetLimits();
  const seen: Call[] = [];
  const res = await handle(
    post("/api/v1/calendar/events", {
      type: "COFFEE_CHAT",
      title: "커피챗",
      startsAt: "2026-10-24T01:00:00Z",
      endsAt: "2026-10-24T02:00:00Z",
      remindAt: "2026-10-23T01:00:00Z",
    }, "77777777-7777-4777-8777-777777777777"),
    env(),
    deps(authed(seen, async () => empty)),
  );
  assert.equal(res.status, 201);
  const body = await res.json() as { data: { type: string; remindAt: string | null } };
  assert.equal(body.data.type, "COFFEE_CHAT");
  assert.equal(body.data.remindAt, "2026-10-23T01:00:00Z");
  const insert = seen.find((call) => call.sql.includes("INSERT INTO calendar_events"));
  assert.ok(insert);
  assert.match(insert.sql, /remind_at/);
  assert.equal(insert.params.includes("2026-10-23T01:00:00.000Z"), true);
});

test("the notification job claims and filters in two statements, not per row", async () => {
  resetLimits();
  const seen: Call[] = [];
  const rows = Array.from({ length: 5 }, (_, i) => ({ user_id: OTHER, id: `p-${i}`, title: `T${i}` }));
  const res = await handle(new Request("https://core.example/api/v1/internal/notifications/run", {
    method: "POST",
    headers: { authorization: "Bearer job-secret" },
  }), env({ INTERNAL_JOB_TOKEN: "job-secret" }), deps(async (sql, params = []) => {
    seen.push({ sql, params });
    if (sql.includes("FROM bookmarks")) return { rows, rowCount: rows.length };
    return empty;
  }));
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json() as { data: unknown }).data, { deadlines: 5, reminders: 0 });
  const picks = seen.filter((call) => call.sql.includes("notification_dedupes"));
  assert.equal(picks.length, 2);
  assert.ok(picks.every((call) => call.sql.includes("COALESCE(s.notify_deadline, true)")));
  assert.equal(seen.some((call) => call.sql.startsWith("SELECT notify_deadline")), false);
});
