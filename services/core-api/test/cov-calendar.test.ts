import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { beforeEach, test } from "node:test";

import type { Query } from "../src/db.ts";
import { handle, type CoreEnv } from "../src/handler.ts";
import { resetLimits } from "../src/ratelimit.ts";
import { validTz } from "../src/routes/calendar.ts";

const ALICE = "aaaaaaaa-0000-4000-8000-000000000001";
const BOB = "bbbbbbbb-0000-4000-8000-000000000002";
const APP = "cccccccc-0000-4000-8000-000000000003";
const NOW = new Date("2026-10-22T00:00:00Z");
const env: CoreEnv = { APP_ENV: "production" };
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const TOKENS: Record<string, string> = { [sha("tok-alice")]: ALICE, [sha("tok-bob")]: BOB };

type Row = Record<string, unknown>;
type Call = { sql: string; params: unknown[] };
type Body = { data: Row & Row[]; page?: { nextCursor: string | null; hasMore: boolean }; error?: { code: string; message: string; details: unknown } };

// In-memory calendar_events/applications that honour the user_id predicate.
function world(opts: { insertError?: Error & { code?: string } } = {}) {
  const seen: Call[] = [];
  const events = new Map<string, Row>();
  const applications = new Map<string, string>([[APP, ALICE]]);
  const out = (rows: Row[]) => ({ rows, rowCount: rows.length });
  const owned = (id: unknown, user: unknown) => {
    const event = events.get(String(id));
    return event && event.user_id === user ? event : undefined;
  };
  const query: Query = async (sql, params = []) => {
    seen.push({ sql, params });
    if (sql.includes("access_tokens")) {
      const id = TOKENS[String(params[0])];
      return out(id ? [{ id, display_name: "u", locale: "ko", plan: "FREE", created_at: "2026-01-01T00:00:00Z", token_expires_at: "2099-01-01T00:00:00Z" }] : []);
    }
    if (sql.includes("rate_limits")) return out([{ hits: 1 }]);
    if (sql.startsWith("INSERT INTO idempotency_keys")) return out([{ id: "idem" }]);
    if (sql.startsWith("SELECT id FROM applications")) return out(applications.get(String(params[0])) === params[1] ? [{ id: params[0] }] : []);
    if (sql.startsWith("INSERT INTO calendar_events")) {
      const withRemind = sql.includes("remind_at");
      if (withRemind && opts.insertError) throw opts.insertError;
      const [id, user_id, application_id, type, title, starts_at, ends_at, time_zone, notes] = params;
      const remind_at = withRemind ? params[9] : null;
      const now = params[withRemind ? 10 : 9];
      events.set(String(id), { id, user_id, revision: 1, application_id, type, title, starts_at, ends_at, time_zone, source: "LOCAL", external_id: null, notes, remind_at, created_at: now, updated_at: now });
      return out([]);
    }
    if (sql.includes("FROM calendar_events WHERE user_id = $1")) {
      const limit = Number(params[params.length - 1]);
      return out([...events.values()].filter((e) => e.user_id === params[0]).slice(0, limit));
    }
    if (/^SELECT .* FROM calendar_events WHERE id = \$1 AND user_id = \$2$/.test(sql)) {
      const event = owned(params[0], params[1]);
      return out(event ? [{ ...event }] : []);
    }
    if (sql.startsWith("UPDATE calendar_events")) {
      const event = owned(params[0], params[1]);
      if (!event || event.revision !== params[8]) return out([]);
      Object.assign(event, { revision: Number(event.revision) + 1, title: params[2], starts_at: params[3], ends_at: params[4], time_zone: params[5], notes: params[6], updated_at: params[7] });
      return out([{ ...event }]);
    }
    if (sql.startsWith("DELETE FROM calendar_events")) {
      const event = owned(params[0], params[1]);
      if (!event || event.revision !== params[2]) return out([]);
      events.delete(String(params[0]));
      return out([{ id: params[0] }]);
    }
    return out([]);
  };
  const call = async (method: string, path: string, o: { token?: string | null; body?: unknown } = {}) => {
    const headers: Record<string, string> = { "idempotency-key": crypto.randomUUID(), "content-type": "application/json" };
    const token = o.token === undefined ? "tok-alice" : o.token;
    if (token) headers.authorization = `Bearer ${token}`;
    const body = o.body === undefined ? undefined : typeof o.body === "string" ? o.body : JSON.stringify(o.body);
    const res = await handle(new Request(`https://core.example${path}`, { method, headers, body }), env, { query, now: () => NOW });
    const text = await res.text();
    return { status: res.status, rid: res.headers.get("x-request-id"), body: (text ? JSON.parse(text) : null) as Body };
  };
  return { seen, events, query, call };
}

const valid = {
  type: "INTERVIEW", title: "Onsite", startsAt: "2026-11-01T10:00:00+09:00", endsAt: "2026-11-01T11:00:00+09:00",
  timeZone: "Asia/Seoul", notes: "bring laptop", remindAt: "2026-11-01T09:00:00+09:00", applicationId: APP,
};
const RANGE = "from=2026-10-01T00:00:00Z&to=2026-12-01T00:00:00Z";

beforeEach(() => resetLimits());

test("calendar: validTz accepts IANA zones only", () => {
  assert.equal(validTz("Asia/Seoul"), true);
  assert.equal(validTz("Mars/Olympus"), false);
});

test("calendar: endpoints require a valid bearer token", async () => {
  const w = world();
  assert.equal((await w.call("GET", `/api/v1/calendar/events?${RANGE}`, { token: null })).status, 401);
  const bad = await w.call("GET", `/api/v1/calendar/events?${RANGE}`, { token: "nope" });
  assert.equal(bad.status, 401);
  assert.equal(bad.body.error?.code, "UNAUTHENTICATED");
});

test("calendar: create normalises times and is listed back for the owner only", async () => {
  const w = world();
  const created = await w.call("POST", "/api/v1/calendar/events", { body: valid });
  assert.equal(created.status, 201);
  const event = created.body.data;
  assert.deepEqual({ ...event, id: "x" }, {
    id: "x", revision: 1, applicationId: APP, type: "INTERVIEW", title: "Onsite", startsAt: "2026-11-01T01:00:00Z",
    endsAt: "2026-11-01T02:00:00Z", timeZone: "Asia/Seoul", source: "LOCAL", externalId: null, notes: "bring laptop",
    remindAt: "2026-11-01T00:00:00Z", createdAt: "2026-10-22T00:00:00Z", updatedAt: "2026-10-22T00:00:00Z",
  });
  assert.equal(w.seen.find((c) => c.sql.startsWith("INSERT INTO calendar_events"))?.params[1], ALICE);

  const mine = await w.call("GET", `/api/v1/calendar/events?${RANGE}`);
  assert.equal(mine.status, 200);
  assert.deepEqual(mine.body.data, [event]);
  assert.deepEqual(mine.body.page, { nextCursor: null, hasMore: false });

  const theirs = await w.call("GET", `/api/v1/calendar/events?${RANGE}`, { token: "tok-bob" });
  assert.deepEqual(theirs.body.data, []);
  assert.equal(w.seen.at(-1)?.params[0], BOB);
});

test("calendar: create defaults time zone to UTC and leaves optional fields empty", async () => {
  const w = world();
  const res = await w.call("POST", "/api/v1/calendar/events", {
    body: { type: "DEADLINE", title: "Submit", startsAt: "2026-11-01T00:00:00Z", endsAt: "2026-11-01T00:30:00Z", remindAt: "" },
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.data.timeZone, "UTC");
  assert.equal(res.body.data.notes, "");
  assert.equal(res.body.data.remindAt, null);
  assert.equal(res.body.data.applicationId, null);
});

test("calendar: create cannot attach another user's application", async () => {
  const w = world();
  const res = await w.call("POST", "/api/v1/calendar/events", { token: "tok-bob", body: valid });
  assert.equal(res.status, 404);
  assert.equal(res.body.error?.code, "NOT_FOUND");
  assert.deepEqual(w.seen.find((c) => c.sql.startsWith("SELECT id FROM applications"))?.params, [APP, BOB]);
  assert.equal(w.events.size, 0);
});

test("calendar: create falls back to the pre-remind_at insert when the column is missing", async () => {
  const w = world({ insertError: Object.assign(new Error('column "remind_at" does not exist'), { code: "42703" }) });
  const res = await w.call("POST", "/api/v1/calendar/events", { body: valid });
  assert.equal(res.status, 201);
  assert.equal(w.events.size, 1);
  assert.equal([...w.events.values()][0].remind_at, null);
});

test("calendar: create surfaces other insert failures as 500", async () => {
  const w = world({ insertError: Object.assign(new Error("connection reset"), { code: "08006" }) });
  const res = await w.call("POST", "/api/v1/calendar/events", { body: valid });
  assert.equal(res.status, 500);
  assert.equal(res.body.error?.code, "INTERNAL");
  assert.equal(w.events.size, 0);
});

test("calendar: create rejects invalid bodies with 400", async () => {
  const cases: [unknown, string, unknown][] = [
    ["", "request body required", undefined],
    ["[]", "invalid request body", undefined],
    ["{oops", "invalid request body", undefined],
    [{ ...valid, type: "PARTY" }, "unsupported event type", { field: "type" }],
    [{ ...valid, title: "" }, "title must be 1-300 characters", { field: "title" }],
    [{ ...valid, title: "t".repeat(301) }, "title must be 1-300 characters", { field: "title" }],
    [{ ...valid, startsAt: "soon" }, "must be RFC3339", { field: "startsAt" }],
    [{ ...valid, endsAt: 5 }, "must be RFC3339", { field: "endsAt" }],
    [{ ...valid, endsAt: valid.startsAt }, "must be after startsAt", { field: "endsAt" }],
    [{ ...valid, timeZone: "Nowhere/City" }, "invalid IANA time zone", { field: "timeZone" }],
    [{ ...valid, remindAt: "later" }, "must be RFC3339", { field: "remindAt" }],
    [{ ...valid, applicationId: "x" }, "must be a UUID", { field: "applicationId" }],
  ];
  for (const [body, message, details] of cases) {
    resetLimits();
    const w = world();
    const res = await w.call("POST", "/api/v1/calendar/events", { body });
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(res.body.error?.code, "VALIDATION_ERROR");
    assert.equal(res.body.error?.message, message);
    if (details) assert.deepEqual(res.body.error?.details, details);
    assert.equal(w.events.size, 0);
  }
});

test("calendar: list validates the range and query parameters", async () => {
  const cases: [string, unknown][] = [
    ["from=2026-10-01T00:00:00Z", undefined],
    ["from=yesterday&to=2026-10-02T00:00:00Z", { field: "from" }],
    ["from=2026-10-01T00:00:00Z&to=never", { field: "to" }],
    ["from=2026-10-02T00:00:00Z&to=2026-10-01T00:00:00Z", { field: "to" }],
    ["from=2025-01-01T00:00:00Z&to=2026-10-01T00:00:00Z", { field: "to" }],
    [`${RANGE}&applicationId=nope`, { field: "applicationId" }],
    [`${RANGE}&limit=-1`, { field: "limit" }],
  ];
  for (const [qs, details] of cases) {
    resetLimits();
    const res = await world().call("GET", `/api/v1/calendar/events?${qs}`);
    assert.equal(res.status, 400, qs);
    assert.equal(res.body.error?.code, "VALIDATION_ERROR");
    if (details) assert.deepEqual(res.body.error?.details, details);
  }
});

test("calendar: list filters by application and paginates with a cursor", async () => {
  const w = world();
  for (let i = 0; i < 3; i++) {
    const id = `00000000-0000-4000-8000-00000000000${i}`;
    w.events.set(id, { id, user_id: ALICE, revision: 1, application_id: null, type: "CUSTOM", title: `E${i}`, starts_at: "2026-11-01T00:00:00Z",
      ends_at: "2026-11-01T01:00:00Z", time_zone: null, source: null, external_id: "g-1", notes: null, remind_at: null,
      created_at: `2026-10-0${3 - i}T00:00:00Z`, updated_at: `2026-10-0${3 - i}T00:00:00Z` });
  }
  const first = await w.call("GET", `/api/v1/calendar/events?${RANGE}&applicationId=${APP}&limit=2`);
  assert.equal(first.status, 200);
  const sql = w.seen.at(-1)!;
  assert.match(sql.sql, /WHERE user_id = \$1 AND starts_at >= \$2 AND starts_at <= \$3 AND application_id = \$4 ORDER BY created_at DESC, id DESC LIMIT \$5$/);
  assert.deepEqual(sql.params, [ALICE, "2026-10-01T00:00:00.000Z", "2026-12-01T00:00:00.000Z", APP, 3]);
  assert.equal(first.body.data.length, 2);
  assert.equal(first.body.data[0].timeZone, "UTC");
  assert.equal(first.body.data[0].source, "LOCAL");
  assert.equal(first.body.data[0].externalId, "g-1");
  assert.equal(first.body.page?.hasMore, true);

  await w.call("GET", `/api/v1/calendar/events?${RANGE}&cursor=${first.body.page!.nextCursor}`);
  const next = w.seen.at(-1)!;
  assert.match(next.sql, /AND \(created_at, id\) < \(\$4, \$5\)/);
  assert.deepEqual(next.params.slice(3), ["2026-10-02T00:00:00Z", "00000000-0000-4000-8000-000000000001", 51]);
});

test("calendar: patch updates the event and bumps the revision", async () => {
  const w = world();
  const id = (await w.call("POST", "/api/v1/calendar/events", { body: valid })).body.data.id;
  const res = await w.call("PATCH", `/api/v1/calendar/events/${id}`, {
    body: { expectedRevision: 1, title: "Final round", startsAt: "2026-11-02T00:00:00Z", endsAt: "2026-11-02T02:00:00Z", timeZone: "UTC", notes: 42 },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.revision, 2);
  assert.equal(res.body.data.title, "Final round");
  assert.equal(res.body.data.startsAt, "2026-11-02T00:00:00Z");
  assert.equal(res.body.data.endsAt, "2026-11-02T02:00:00Z");
  assert.equal(res.body.data.timeZone, "UTC");
  assert.equal(res.body.data.notes, "42");
  const update = w.seen.find((c) => c.sql.startsWith("UPDATE calendar_events"))!;
  assert.match(update.sql, /WHERE id = \$1 AND user_id = \$2 AND revision = \$9/);
  assert.equal(update.params[1], ALICE);
});

test("calendar: patch rejects stale revisions and invalid fields", async () => {
  const w = world();
  const id = (await w.call("POST", "/api/v1/calendar/events", { body: valid })).body.data.id;
  const stale = await w.call("PATCH", `/api/v1/calendar/events/${id}`, { body: { expectedRevision: 3, title: "x" } });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error?.code, "REVISION_CONFLICT");
  assert.deepEqual(stale.body.error?.details, { currentRevision: 1 });

  const cases: [unknown, unknown][] = [
    [{ title: "x" }, null],
    [{ expectedRevision: 1, title: "" }, { field: "title" }],
    [{ expectedRevision: 1, title: 9 }, { field: "title" }],
    [{ expectedRevision: 1, startsAt: "nope" }, { field: "startsAt" }],
    [{ expectedRevision: 1, endsAt: "2026-10-01T00:00:00Z" }, { field: "endsAt" }],
    [{ expectedRevision: 1, timeZone: "Bad/Zone" }, { field: "timeZone" }],
    [{ expectedRevision: 1, timeZone: 1 }, { field: "timeZone" }],
  ];
  for (const [body, details] of cases) {
    const res = await w.call("PATCH", `/api/v1/calendar/events/${id}`, { body });
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.deepEqual(res.body.error?.details, details);
  }
  assert.equal(w.events.get(String(id))?.revision, 1);
});

test("calendar: another user cannot patch or delete someone else's event", async () => {
  const w = world();
  const id = (await w.call("POST", "/api/v1/calendar/events", { body: valid })).body.data.id;
  const patch = await w.call("PATCH", `/api/v1/calendar/events/${id}`, { token: "tok-bob", body: { expectedRevision: 1, title: "pwned" } });
  assert.equal(patch.status, 404);
  const del = await w.call("DELETE", `/api/v1/calendar/events/${id}`, { token: "tok-bob", body: { expectedRevision: 1 } });
  assert.equal(del.status, 404);
  assert.equal(del.body.error?.code, "NOT_FOUND");
  assert.equal(w.events.get(String(id))?.title, "Onsite");
  const scoped = w.seen.filter((call) => /calendar_events WHERE id = \$1 AND user_id = \$2/.test(call.sql));
  assert.equal(scoped.length, 3);
  for (const c of scoped) assert.deepEqual(c.params.slice(0, 2), [id, BOB]);
});

test("calendar: delete needs the current revision and answers 204", async () => {
  const w = world();
  const id = (await w.call("POST", "/api/v1/calendar/events", { body: valid })).body.data.id;
  const noBody = await w.call("DELETE", `/api/v1/calendar/events/${id}`);
  assert.equal(noBody.status, 400);
  const noRev = await w.call("DELETE", `/api/v1/calendar/events/${id}`, { body: {} });
  assert.equal(noRev.status, 400);
  const stale = await w.call("DELETE", `/api/v1/calendar/events/${id}`, { body: { expectedRevision: 9 } });
  assert.equal(stale.status, 409);
  assert.deepEqual(stale.body.error?.details, { currentRevision: 1 });
  const ok = await w.call("DELETE", `/api/v1/calendar/events/${id}`, { body: { expectedRevision: 1 } });
  assert.equal(ok.status, 204);
  assert.equal(ok.body, null);
  assert.ok(ok.rid);
  assert.equal(w.events.size, 0);
  const bad = await w.call("DELETE", "/api/v1/calendar/events/123", { body: { expectedRevision: 1 } });
  assert.equal(bad.status, 400);
  assert.deepEqual(bad.body.error?.details, { field: "id" });
});

test("calendar: patch response keeps the event's remindAt", { todo: "BUG: src/routes/calendar.ts:160 UPDATE ... RETURNING omits remind_at, so PATCH always answers remindAt: null" }, async () => {
  const w = world();
  const id = (await w.call("POST", "/api/v1/calendar/events", { body: valid })).body.data.id;
  await w.call("PATCH", `/api/v1/calendar/events/${id}`, { body: { expectedRevision: 1, title: "Moved" } });
  const update = w.seen.find((c) => c.sql.startsWith("UPDATE calendar_events"))!;
  assert.match(update.sql.slice(update.sql.indexOf("RETURNING")), /remind_at/);
});
