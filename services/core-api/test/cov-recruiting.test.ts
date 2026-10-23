import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import type { Query } from "../src/db.ts";
import { handle, type CoreEnv } from "../src/handler.ts";
import { resetLimits } from "../src/ratelimit.ts";

const ME = "12345678-1234-4678-8234-567812345678";
const OTHER = "bbbbbbbb-0000-4000-8000-000000000002";
const OFFER = "eeeeeeee-0000-4000-8000-000000000005";
const POSTING = "dddddddd-0000-4000-8000-000000000004";
const LINK = "aaaaaaaa-0000-4000-8000-000000000001";
const NOW = new Date("2026-10-22T00:00:00Z");
const env: CoreEnv = { APP_ENV: "production" };

type Row = Record<string, unknown>;
type Call = { sql: string; params: unknown[] };
type Body = { data: Row & Row[]; page?: { nextCursor: string | null; hasMore: boolean; total?: number }; error?: { code: string; message: string; details: unknown } };

function world(reply: (sql: string, params: unknown[]) => Row[] | Error | undefined = () => undefined) {
  const seen: Call[] = [];
  const query: Query = async (sql, params = []) => {
    seen.push({ sql, params });
    const rows = (r: Row[]) => ({ rows: r, rowCount: r.length });
    if (sql.includes("rate_limits")) return rows([{ hits: 1 }]);
    if (sql.includes("access_tokens")) {
      return rows([{ id: ME, display_name: "Ada", locale: "ko", plan: "FREE", created_at: "2026-01-01T00:00:00Z", token_expires_at: "2099-01-01T00:00:00Z" }]);
    }
    if (sql.startsWith("INSERT INTO idempotency_keys")) return rows([{ id: "idem" }]);
    const r = reply(sql, params);
    if (r instanceof Error) throw r;
    return rows(r ?? []);
  };
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await handle(new Request(`https://core.example${path}`, {
      method,
      headers: { authorization: "Bearer t", "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    }), env, { query, now: () => NOW });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as Body };
  };
  return { seen, call };
}

beforeEach(() => resetLimits());

// --- links ---------------------------------------------------------------

test("links: list is scoped to the caller, filters by kind and paginates", async () => {
  const rows = [1, 2].map((i) => ({ id: `0000000${i}-0000-4000-8000-000000000000`, kind: "github", url: "https://github.com/a", title: null,
    status: null, fit_count: null, ai_read: "t", created_at: `2026-10-0${3 - i}T00:00:00Z` }));
  const w = world((sql, params) => sql.includes("FROM user_links") ? rows.slice(0, Number(params.at(-1))) : undefined);
  const res = await w.call("GET", "/api/v1/me/links?kind=github&limit=1");
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data, [{ id: rows[0].id, kind: "github", url: "https://github.com/a", title: "", status: "READ", fitCount: 0, aiRead: true, createdAt: "2026-10-02T00:00:00Z" }]);
  assert.equal(res.body.page?.hasMore, true);
  assert.match(w.seen.at(-1)!.sql, /WHERE user_id = \$1 AND kind = \$2 ORDER BY created_at DESC, id DESC LIMIT \$3$/);
  assert.deepEqual(w.seen.at(-1)!.params, [ME, "github", 2]);

  await w.call("GET", `/api/v1/me/links?cursor=${res.body.page!.nextCursor}`);
  assert.match(w.seen.at(-1)!.sql, /WHERE user_id = \$1 AND \(created_at, id\) < \(\$2, \$3\)/);

  const bad = await w.call("GET", "/api/v1/me/links?kind=video");
  assert.equal(bad.status, 422);
  assert.deepEqual(bad.body.error?.details, { field: "kind" });
});

test("links: create infers the kind from the host", async () => {
  for (const [url, kind] of [
    ["https://github.com/ada", "github"], ["https://gist.github.com/ada", "github"], ["https://ada.velog.io/x", "blog"],
    ["https://ada.notion.site/cv", "portfolio"], ["http://example.com", "other"],
  ]) {
    resetLimits();
    const w = world();
    const res = await w.call("POST", "/api/v1/me/links", { url, title: "mine", aiRead: true });
    assert.equal(res.status, 201, url);
    assert.equal(res.body.data.kind, kind, url);
    assert.equal(res.body.data.aiRead, true);
    const insert = w.seen.find((c) => c.sql.startsWith("INSERT INTO user_links"))!;
    assert.deepEqual(insert.params.slice(1, 4), [ME, kind, url]);
  }
});

test("links: create validates url, kind, managed fields and aiRead", async () => {
  const cases: [unknown, number, unknown][] = [
    [{ url: "ftp://x.example" }, 400, { field: "url" }],
    [{ url: "https://u:p@x.example" }, 400, { field: "url" }],
    [{ url: "" }, 400, { field: "url" }],
    [{ url: "https://x.example", kind: "video" }, 422, { field: "kind" }],
    [{ url: "https://x.example", status: "READ" }, 400, { field: "status" }],
    [{ url: "https://x.example", aiRead: "yes" }, 400, { field: "aiRead" }],
  ];
  for (const [body, status, details] of cases) {
    resetLimits();
    const w = world();
    const res = await w.call("POST", "/api/v1/me/links", body);
    assert.equal(res.status, status, JSON.stringify(body));
    assert.deepEqual(res.body.error?.details, details);
    assert.equal(w.seen.some((c) => c.sql.startsWith("INSERT INTO user_links")), false);
  }
});

test("links: patch and delete only touch the caller's link", async () => {
  const w = world((sql, params) => {
    if (sql.startsWith("UPDATE user_links") || sql.startsWith("DELETE FROM user_links")) {
      return params[1] === ME && params[0] === LINK ? [{ id: LINK, kind: "blog", url: "https://b.example", title: "t", status: "READ", fit_count: 2, ai_read: false, created_at: "2026-10-01T00:00:00Z" }] : [];
    }
    return undefined;
  });
  const patched = await w.call("PATCH", `/api/v1/me/links/${LINK}`, { kind: "blog", title: "t", url: "https://b.example", aiRead: false });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.data.fitCount, 2);
  assert.match(w.seen.at(-1)!.sql, /WHERE id = \$1 AND user_id = \$2 RETURNING/);
  assert.deepEqual(w.seen.at(-1)!.params, [LINK, ME, "t", "blog", "https://b.example", false]);

  const missing = await w.call("PATCH", `/api/v1/me/links/${OTHER}`, { title: "x" });
  assert.equal(missing.status, 404);
  assert.deepEqual(w.seen.at(-1)!.params, [OTHER, ME, "x", null, null, null]);

  for (const body of [{ url: "javascript:alert(1)" }, { kind: "nope" }, { fitCount: 3 }]) {
    const bad = await w.call("PATCH", `/api/v1/me/links/${LINK}`, body);
    assert.ok(bad.status === 400 || bad.status === 422, JSON.stringify(body));
  }

  const removed = await w.call("DELETE", `/api/v1/me/links/${LINK}`);
  assert.equal(removed.status, 204);
  assert.deepEqual(w.seen.at(-1)!.params, [LINK, ME]);
  const notMine = await w.call("DELETE", `/api/v1/me/links/${OTHER}`);
  assert.equal(notMine.status, 404);
});

// --- devices & notifications --------------------------------------------

test("devices: register upserts the caller's push token and delete removes it", async () => {
  const w = world();
  const res = await w.call("POST", "/api/v1/me/devices", { token: "ExponentPushToken[abc]", platform: "ios" });
  assert.equal(res.status, 201);
  assert.deepEqual(res.body.data, { token: "ExponentPushToken[abc]", platform: "ios" });
  assert.deepEqual(w.seen.find((c) => c.sql.startsWith("INSERT INTO user_devices"))?.params.slice(0, 3), [ME, "ExponentPushToken[abc]", "ios"]);

  const bad = await w.call("POST", "/api/v1/me/devices", { token: "t", platform: "web" });
  assert.equal(bad.status, 422);
  assert.deepEqual(bad.body.error?.details, { field: "platform" });

  const del = await w.call("DELETE", `/api/v1/me/devices/${encodeURIComponent("ExponentPushToken[abc]")}`);
  assert.equal(del.status, 204);
  assert.deepEqual(w.seen.at(-1)!.params, [ME, "ExponentPushToken[abc]"]);
});

test("notifications: unread count, list mapping and pagination", async () => {
  const w = world((sql, params) => {
    if (sql.startsWith("SELECT count(*)::int AS count FROM notifications")) return [{ count: "4" }];
    if (sql.includes("FROM notifications WHERE user_id = $1")) {
      return [
        { id: "n2", type: "OFFER", title: "새 제안", body: null, target: '{"kind":"offer","id":"o1"}', read_at: null, created_at: "2026-10-02T00:00:00Z" },
        { id: "n1", type: null, title: null, body: "b", target: "[1]", read_at: "2026-10-02T00:00:00Z", created_at: "2026-10-01T00:00:00Z" },
      ].slice(0, Number(params.at(-1)));
    }
    return undefined;
  });
  const unread = await w.call("GET", "/api/v1/me/notifications/unread");
  assert.deepEqual(unread.body.data, { count: 4 });
  assert.deepEqual(w.seen.at(-1)!.params, [ME]);

  const list = await w.call("GET", "/api/v1/me/notifications?limit=1");
  assert.deepEqual(list.body.data, [{ id: "n2", type: "OFFER", title: "새 제안", body: "", target: { kind: "offer", id: "o1" }, readAt: null, createdAt: "2026-10-02T00:00:00Z" }]);
  assert.equal(list.body.page?.hasMore, true);
  await w.call("GET", `/api/v1/me/notifications?cursor=${list.body.page!.nextCursor}`);
  assert.match(w.seen.at(-1)!.sql, /AND \(created_at, id\) < \(\$2, \$3\)/);
  const rest = await w.call("GET", "/api/v1/me/notifications");
  assert.deepEqual(rest.body.data[1].target, {});
});

test("notifications: mark all, mark ids, and reject non-array ids", async () => {
  const w = world();
  assert.equal((await w.call("POST", "/api/v1/me/notifications/read", { all: true })).status, 204);
  assert.match(w.seen.find((c) => c.sql.startsWith("UPDATE notifications"))!.sql, /WHERE user_id = \$1 AND read_at IS NULL$/);

  const ids = [LINK, OTHER];
  assert.equal((await w.call("POST", "/api/v1/me/notifications/read", { ids })).status, 204);
  assert.deepEqual(w.seen.filter((c) => c.sql.startsWith("UPDATE notifications")).at(-1)!.params.slice(0, 2), [ME, ids.join("\u001f")]);

  const before = w.seen.length;
  assert.equal((await w.call("POST", "/api/v1/me/notifications/read", { ids: [] })).status, 204);
  assert.equal(w.seen.slice(before).some((c) => c.sql.startsWith("UPDATE notifications")), false);

  const bad = await w.call("POST", "/api/v1/me/notifications/read", { ids: "all" });
  assert.equal(bad.status, 400);
  assert.deepEqual(bad.body.error?.details, { field: "ids" });
  const badId = await w.call("POST", "/api/v1/me/notifications/read", { ids: ["nope"] });
  assert.equal(badId.status, 400);
  assert.deepEqual(badId.body.error?.details, { field: "ids" });
});

// --- offers --------------------------------------------------------------

const offerRow = (extra: Row = {}): Row => ({
  id: OFFER, sender_id: ME, sender_name: "Ada", profile_user_id: OTHER, recipient_name: "Bob", message: "join us",
  posting_id: POSTING, posting_title: "Backend", posting_company: "Acme", posting_image: "logo.png", status: "SENT", read_at: null,
  created_at: "2026-10-22T00:00:00Z", sender_headline: null, sender_avatar: "me.png", sender_company: "", ...extra,
});

const offerWorld = (opts: { posting?: boolean; profile?: Row | null; insert?: Error; pref?: boolean } = {}) => world((sql) => {
  if (sql.startsWith("SELECT id FROM job_postings")) return opts.posting === false ? [] : [{ id: POSTING }];
  if (sql.includes("FROM profiles p LEFT JOIN user_settings")) return opts.profile === null ? [] : [opts.profile ?? { user_id: OTHER, open_to_offers: true, profile_public: true }];
  if (sql.startsWith("INSERT INTO offers")) return opts.insert;
  if (sql.includes("AS enabled FROM user_settings")) return opts.pref === undefined ? [] : [{ enabled: opts.pref }];
  if (sql.startsWith("SELECT o.id")) return [offerRow()];
  return undefined;
});

test("offers: sending an offer stores it, notifies the recipient and returns the offer", async () => {
  const w = offerWorld();
  const res = await w.call("POST", `/api/v1/profiles/${OTHER}/offer`, { message: "join us", postingId: POSTING });
  assert.equal(res.status, 201);
  assert.deepEqual(res.body.data, {
    id: OFFER, sender: { id: ME, displayName: "Ada", companyName: null, headline: "", avatarUrl: "/api/v1/uploads/images/me.png" },
    recipient: { id: OTHER, displayName: "Bob" }, message: "join us",
    posting: { id: POSTING, title: "Backend", company: "Acme", imageUrl: "/api/v1/uploads/images/logo.png" },
    status: "SENT", readAt: null, createdAt: "2026-10-22T00:00:00Z",
  });
  const insert = w.seen.find((c) => c.sql.startsWith("INSERT INTO offers"))!;
  assert.deepEqual(insert.params.slice(1, 5), [ME, OTHER, "join us", POSTING]);
  const note = w.seen.find((c) => c.sql.startsWith("INSERT INTO notifications"))!;
  assert.deepEqual(note.params.slice(1, 5), [OTHER, "OFFER", "새 제안", "join us"]);
});

test("offers: a recipient who muted offer notifications gets no notification row", async () => {
  const w = offerWorld({ pref: false });
  const res = await w.call("POST", `/api/v1/profiles/${OTHER}/offer`, { message: "hi" });
  assert.equal(res.status, 201);
  assert.equal(w.seen.find((c) => c.sql.startsWith("INSERT INTO offers"))!.params[4], null);
  assert.equal(w.seen.some((c) => c.sql.startsWith("INSERT INTO notifications")), false);
});

test("offers: sending is refused for self, closed postings, hidden or closed profiles and duplicates", async () => {
  const dup = Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" });
  const cases: [ReturnType<typeof offerWorld>, string, unknown, number, string][] = [
    [offerWorld(), ME, { message: "hi" }, 400, "VALIDATION_ERROR"],
    [offerWorld(), OTHER, { message: "" }, 400, "VALIDATION_ERROR"],
    [offerWorld(), OTHER, { message: "hi", status: "ACCEPTED" }, 400, "VALIDATION_ERROR"],
    [offerWorld({ posting: false }), OTHER, { message: "hi", postingId: POSTING }, 404, "NOT_FOUND"],
    [offerWorld({ profile: null }), OTHER, { message: "hi" }, 404, "NOT_FOUND"],
    [offerWorld({ profile: { user_id: OTHER, open_to_offers: true, profile_public: false } }), OTHER, { message: "hi" }, 404, "NOT_FOUND"],
    [offerWorld({ profile: { user_id: OTHER, open_to_offers: "f", profile_public: true } }), OTHER, { message: "hi" }, 403, "FORBIDDEN"],
    [offerWorld({ insert: dup }), OTHER, { message: "hi" }, 409, "CONFLICT"],
    [offerWorld({ insert: new Error("db down") }), OTHER, { message: "hi" }, 500, "INTERNAL"],
  ];
  for (const [w, target, body, status, code] of cases) {
    resetLimits();
    const res = await w.call("POST", `/api/v1/profiles/${target}/offer`, body);
    assert.equal(res.status, status, JSON.stringify(body));
    assert.equal(res.body.error?.code, code);
    assert.equal(w.seen.some((c) => c.sql.startsWith("INSERT INTO notifications")), false);
  }
});

test("offers: messages are listed only for a participant and paginate", async () => {
  const w = world((sql, params) => {
    if (sql.startsWith("SELECT o.id")) return params[0] === OFFER && params[1] === ME ? [offerRow({ status: "ACCEPTED" })] : [];
    if (sql.includes("FROM offer_messages m")) {
      return [
        { id: "m2", offer_id: OFFER, sender_id: OTHER, sender_name: "Bob", body: "hey", created_at: "2026-10-22T00:00:02Z" },
        { id: "m1", offer_id: OFFER, sender_id: ME, sender_name: "Ada", body: null, created_at: "2026-10-22T00:00:01Z" },
      ].slice(0, Number(params.at(-1)));
    }
    return undefined;
  });
  const res = await w.call("GET", `/api/v1/me/offers/${OFFER}/messages?limit=1`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data, [{ id: "m2", offerId: OFFER, sender: { id: OTHER, displayName: "Bob" }, body: "hey", createdAt: "2026-10-22T00:00:02Z" }]);
  assert.equal(res.body.page?.hasMore, true);
  const lookup = w.seen.find((c) => c.sql.startsWith("SELECT o.id"))!;
  assert.match(lookup.sql, /WHERE o\.id = \$1 AND \(o\.sender_id = \$2 OR o\.profile_user_id = \$2\)$/);
  await w.call("GET", `/api/v1/me/offers/${OFFER}/messages?cursor=${res.body.page!.nextCursor}`);
  assert.match(w.seen.at(-1)!.sql, /AND \(m\.created_at, m\.id\) < \(\$2, \$3\)/);

  const stranger = await w.call("GET", `/api/v1/me/offers/${LINK}/messages`);
  assert.equal(stranger.status, 404);
});
