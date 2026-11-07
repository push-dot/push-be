import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import type { Query } from "../src/db.ts";
import { handle, type CoreEnv } from "../src/handler.ts";
import { resetLimits } from "../src/ratelimit.ts";

const ME = "12345678-1234-4678-8234-567812345678";
const OTHER = "bbbbbbbb-0000-4000-8000-000000000002";
const OFFER = "eeeeeeee-0000-4000-8000-000000000005";
const STRANGER = "aaaaaaaa-0000-4000-8000-000000000001";
const NOW = new Date("2026-10-22T00:00:00Z");
const env: CoreEnv = { APP_ENV: "production" };

type Row = Record<string, unknown>;
type Body = { data: Row & Row[]; page?: { nextCursor: string | null; hasMore: boolean; total?: number }; error?: { code: string; message: string; details: unknown } };

function world(reply: (sql: string, params: unknown[]) => Row[] | Error | undefined = () => undefined) {
  const seen: { sql: string; params: unknown[] }[] = [];
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

const offerRow = (extra: Row = {}): Row => ({
  id: OFFER, sender_id: OTHER, sender_name: "Bob", profile_user_id: ME, recipient_name: "Ada", message: "join us",
  posting_id: null, status: "SENT", read_at: null, created_at: "2026-10-22T00:00:00Z", archived_at: null, ...extra,
});

beforeEach(() => resetLimits());


const archiveWorld = (stored: { at: string | null } = { at: null }) => world((sql, params) => {
  if (sql.startsWith("SELECT oa.archived_at, o.id")) return params[1] === ME ? [offerRow({ archived_at: stored.at })] : [];
  if (sql.startsWith("INSERT INTO offer_archives")) stored.at ??= String(params[2]);
  if (sql.startsWith("DELETE FROM offer_archives")) stored.at = null;
  return undefined;
});

test("archive stores the caller's archive row and returns the stored archivedAt", async () => {
  const w = archiveWorld();
  const res = await w.call("POST", `/api/v1/me/offers/${OFFER}/archive`);
  assert.equal(res.status, 200);
  assert.equal(res.body.data.archivedAt, "2026-10-22T00:00:00Z");
  const insert = w.seen.find((c) => c.sql.startsWith("INSERT INTO offer_archives"))!;
  assert.match(insert.sql, /ON CONFLICT \(user_id, offer_id\) DO NOTHING$/);
  assert.deepEqual(insert.params, [ME, OFFER, NOW.toISOString()]);
});

test("archiving twice keeps the first archivedAt", async () => {
  const w = archiveWorld({ at: "2026-09-01T00:00:00Z" });
  const res = await w.call("POST", `/api/v1/me/offers/${OFFER}/archive`);
  assert.equal(res.status, 200);
  assert.equal(res.body.data.archivedAt, "2026-09-01T00:00:00Z");
});

test("unarchive removes the row and returns archivedAt null, also when nothing was archived", async () => {
  const w = archiveWorld({ at: "2026-09-01T00:00:00Z" });
  for (let i = 0; i < 2; i += 1) {
    resetLimits();
    const res = await w.call("POST", `/api/v1/me/offers/${OFFER}/unarchive`);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.archivedAt, null);
  }
  assert.deepEqual(w.seen.find((c) => c.sql.startsWith("DELETE FROM offer_archives"))!.params, [ME, OFFER]);
});

test("archive and unarchive are 404 for a non-party and write nothing", async () => {
  const w = world((sql) => (sql.startsWith("SELECT oa.archived_at, o.id") ? [] : undefined));
  for (const action of ["archive", "unarchive"]) {
    resetLimits();
    const res = await w.call("POST", `/api/v1/me/offers/${STRANGER}/${action}`);
    assert.equal(res.status, 404, action);
  }
  assert.equal(w.seen.some((c) => /^(INSERT|DELETE)/.test(c.sql) && c.sql.includes("offer_archives")), false);
});


test("offer lists hide archived and blocked offers by default and show only archived ones with archived=1", async () => {
  for (const [box, mine, other] of [["received", "o.profile_user_id", "o.sender_id"], ["sent", "o.sender_id", "o.profile_user_id"]]) {
    for (const [query, archived] of [["", "NULL"], ["&archived=0", "NULL"], ["&archived=1", "NOT NULL"]]) {
      const w = world((sql) => (sql.startsWith("SELECT oa.archived_at, o.id") ? [offerRow({ archived_at: archived === "NULL" ? null : "2026-10-01T00:00:00Z" })] : undefined));
      const res = await w.call("GET", `/api/v1/me/offers?box=${box}${query}`);
      assert.equal(res.status, 200, box + query);
      assert.equal(res.body.data[0].archivedAt, archived === "NULL" ? null : "2026-10-01T00:00:00Z");
      const list = w.seen.find((c) => c.sql.startsWith("SELECT oa.archived_at, o.id"))!;
      assert.ok(list.sql.includes(`LEFT JOIN offer_archives oa ON oa.offer_id = o.id AND oa.user_id = $1 WHERE ${mine} = $1 AND oa.offer_id IS ${archived}`), list.sql);
      assert.ok(list.sql.includes(`NOT EXISTS (SELECT 1 FROM user_blocks b WHERE b.blocker_id = $1 AND b.blocked_id = ${other})`), list.sql);
      const count = w.seen.find((c) => c.sql.startsWith("SELECT count(*)"))!;
      assert.ok(count.sql.includes(`oa.offer_id IS ${archived}`) && count.sql.includes("user_blocks"), count.sql);
      assert.deepEqual(count.params, [ME]);
    }
  }
});

test("offer lists reject an archived value other than 0 or 1", async () => {
  const w = world();
  const res = await w.call("GET", "/api/v1/me/offers?box=received&archived=yes");
  assert.equal(res.status, 400);
  assert.equal(res.body.error?.code, "VALIDATION_ERROR");
  assert.deepEqual(res.body.error?.details, { field: "archived" });
});


const reportWorld = (row: Row) => world((sql, params) => (sql.startsWith("SELECT oa.archived_at, o.id") ? (params[0] === OFFER && params[1] === ME ? [row] : []) : undefined));

test("report stores the other party as reported_user_id and returns 204, with or without a reason", async () => {
  for (const [row, reported] of [[offerRow(), OTHER], [offerRow({ sender_id: ME, profile_user_id: OTHER }), OTHER]] as const) {
    for (const body of [undefined, {}, { reason: "spam" }, { reason: null }]) {
      resetLimits();
      const w = reportWorld(row);
      const res = await w.call("POST", `/api/v1/me/offers/${OFFER}/report`, body);
      assert.equal(res.status, 204, JSON.stringify(body));
      const insert = w.seen.find((c) => c.sql.startsWith("INSERT INTO offer_reports"))!;
      assert.deepEqual(insert.params.slice(1), [ME, reported, OFFER, body?.reason ?? null, NOW.toISOString()]);
    }
  }
});

test("report rejects an empty or oversized reason and stores nothing", async () => {
  const w = reportWorld(offerRow());
  for (const reason of ["", "x".repeat(501), 5]) {
    resetLimits();
    const res = await w.call("POST", `/api/v1/me/offers/${OFFER}/report`, { reason });
    assert.equal(res.status, 400, String(reason).slice(0, 5));
    assert.equal(res.body.error?.code, "VALIDATION_ERROR");
  }
  assert.equal(w.seen.some((c) => c.sql.startsWith("INSERT INTO offer_reports")), false);
});

test("report is 404 for a non-party", async () => {
  const w = reportWorld(offerRow());
  const res = await w.call("POST", `/api/v1/me/offers/${STRANGER}/report`, { reason: "spam" });
  assert.equal(res.status, 404);
  assert.equal(w.seen.some((c) => c.sql.startsWith("INSERT INTO offer_reports")), false);
});


test("blocking yourself is 400 and an unknown user is 404", async () => {
  const w = world();
  const self = await w.call("POST", "/api/v1/me/blocks", { userId: ME });
  assert.equal(self.status, 400);
  assert.deepEqual(self.body.error?.details, { field: "userId" });
  for (const body of [{}, { userId: "nope" }]) {
    resetLimits();
    assert.equal((await w.call("POST", "/api/v1/me/blocks", body)).status, 400);
  }
  resetLimits();
  const unknown = await w.call("POST", "/api/v1/me/blocks", { userId: OTHER });
  assert.equal(unknown.status, 404);
  assert.equal(w.seen.some((c) => c.sql.startsWith("INSERT INTO user_blocks")), false);
});

test("blocking inserts idempotently and returns 204; unblocking deletes and returns 204", async () => {
  const w = world((sql) => (sql.startsWith("SELECT id FROM users") ? [{ id: OTHER }] : undefined));
  const block = await w.call("POST", "/api/v1/me/blocks", { userId: OTHER });
  assert.equal(block.status, 204);
  const insert = w.seen.find((c) => c.sql.startsWith("INSERT INTO user_blocks"))!;
  assert.match(insert.sql, /ON CONFLICT \(blocker_id, blocked_id\) DO NOTHING$/);
  assert.deepEqual(insert.params, [ME, OTHER, NOW.toISOString()]);
  resetLimits();
  const unblock = await w.call("DELETE", `/api/v1/me/blocks/${OTHER}`);
  assert.equal(unblock.status, 204);
  assert.deepEqual(w.seen.find((c) => c.sql.startsWith("DELETE FROM user_blocks"))!.params, [ME, OTHER]);
  resetLimits();
  assert.equal((await w.call("DELETE", "/api/v1/me/blocks/nope")).status, 400);
});

test("the block list is newest first, paginates and reports the total", async () => {
  const rows = [
    { blocked_id: OTHER, display_name: "Bob", created_at: "2026-10-02T00:00:00Z" },
    { blocked_id: STRANGER, display_name: "Cy", created_at: "2026-10-01T00:00:00Z" },
  ];
  const w = world((sql, params) => {
    if (sql.startsWith("SELECT count(*)")) return [{ total: 2 }];
    if (sql.includes("FROM user_blocks b")) return rows.slice(0, Number(params.at(-1)));
    return undefined;
  });
  const res = await w.call("GET", "/api/v1/me/blocks?limit=1");
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data, [{ user: { id: OTHER, displayName: "Bob" }, createdAt: "2026-10-02T00:00:00Z" }]);
  assert.deepEqual([res.body.page?.hasMore, res.body.page?.total], [true, 2]);
  const list = w.seen.find((c) => c.sql.startsWith("SELECT b.blocked_id"))!;
  assert.match(list.sql, /WHERE b\.blocker_id = \$1 ORDER BY b\.created_at DESC, b\.blocked_id DESC LIMIT \$2$/);
  await w.call("GET", `/api/v1/me/blocks?cursor=${res.body.page!.nextCursor}`);
  assert.match(w.seen.at(-1)!.sql, /AND \(b\.created_at, b\.blocked_id\) < \(\$2, \$3\)/);
});

test("sending an offer to a user who blocked the sender is 403 BLOCKED and inserts nothing", async () => {
  const w = world((sql, params) => {
    if (sql.includes("FROM profiles p LEFT JOIN user_settings")) return [{ user_id: OTHER, open_to_offers: true, profile_public: true }];
    if (sql.includes("FROM user_blocks")) return params[0] === OTHER && params[1] === ME ? [{ blocked: 1 }] : [];
    return undefined;
  });
  const res = await w.call("POST", `/api/v1/profiles/${OTHER}/offer`, { message: "hi" });
  assert.equal(res.status, 403);
  assert.equal(res.body.error?.code, "BLOCKED");
  assert.equal(w.seen.some((c) => c.sql.startsWith("INSERT INTO offers")), false);
});

const messageWorld = (blockedBy: string | null) => world((sql, params) => {
  if (sql.startsWith("SELECT oa.archived_at, o.id")) return [offerRow({ status: "ACCEPTED" })];
  if (sql.includes("FROM user_blocks")) return params[0] === blockedBy && params[1] === ME ? [{ blocked: 1 }] : [];
  return undefined;
});

test("messaging a user who blocked the sender is 403 BLOCKED and inserts nothing", async () => {
  const w = messageWorld(OTHER);
  const res = await w.call("POST", `/api/v1/me/offers/${OFFER}/messages`, { body: "hi" });
  assert.equal(res.status, 403);
  assert.equal(res.body.error?.code, "BLOCKED");
  assert.equal(w.seen.some((c) => c.sql.startsWith("INSERT INTO offer_messages")), false);
});

test("messaging still works when only the sender blocked the other user", async () => {
  const res = await messageWorld(null).call("POST", `/api/v1/me/offers/${OFFER}/messages`, { body: "hi" });
  assert.equal(res.status, 201);
});

test("listing messages and deciding an offer ignore blocks", async () => {
  const w = world((sql) => {
    if (sql.startsWith("SELECT oa.archived_at, o.id")) return [offerRow()];
    if (sql.includes("FROM user_blocks")) return [{ blocked: 1 }];
    if (sql.startsWith("UPDATE offers SET status = $2")) return [{ id: OFFER }];
    return undefined;
  });
  assert.equal((await w.call("GET", `/api/v1/me/offers/${OFFER}/messages`)).status, 200);
  resetLimits();
  assert.equal((await w.call("POST", `/api/v1/me/offers/${OFFER}/decline`)).status, 200);
  assert.equal(w.seen.some((c) => c.sql.includes("FROM user_blocks")), false);
});
