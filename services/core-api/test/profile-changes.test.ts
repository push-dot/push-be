import assert from "node:assert/strict";
import { test } from "node:test";

import { handle, type CoreEnv, type Deps } from "../src/handler.ts";
import { resetLimits } from "../src/ratelimit.ts";

const USER = "12345678-1234-5678-1234-567812345678";
const CHANGE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const NOW = "2026-11-17T00:00:00.000Z";

type Call = { sql: string; params: unknown[] };
type Row = Record<string, unknown>;

const env = (): CoreEnv => ({ APP_ENV: "production", MANAGED_AI: "1" });
const empty = { rows: [] as Row[], rowCount: 0 };

const current = (): Row => ({
  display_name: "Ada", headline: "백엔드 개발자", job_category: "dev", tenure_years: 3, career_status: null,
  open_to_offers: false, intro: "소개", careers: [], skills: ["Kotlin"], avatar_key: null, resume_source_id: null,
});

// One fake database: the profile row, the change rows, and whatever the request wrote.
const world = (changes: Map<string, { before: Row; undone: boolean }> = new Map(), failWrite = false) => {
  const seen: Call[] = [];
  const query: Deps["query"] = async (sql, params = []) => {
    seen.push({ sql, params });
    if (sql.includes("rate_limits")) return { rows: [{ hits: 1 }], rowCount: 1 };
    if (sql.includes("access_tokens")) {
      return {
        rows: [{
          id: USER, display_name: "Ada", locale: "ko", plan: "PRO", subscription_status: "NONE",
          created_at: NOW, token_expires_at: "2099-01-01T00:00:00Z", is_employer: false, email: "ada@push.app", provider: "email",
        }],
        rowCount: 1,
      };
    }
    if (sql.includes("idempotency_keys") && sql.includes("INSERT")) return { rows: [{ id: "1" }], rowCount: 1 };
    if (sql.includes("idempotency_keys")) return empty;
    if (sql.includes("is_employer") && sql.includes("FROM users") && !sql.includes("access_tokens")) return { rows: [{ is_employer: false }], rowCount: 1 };
    if (sql.includes("INSERT INTO profile_changes")) {
      const id = String(params[1]);
      if (!changes.has(id)) changes.set(id, { before: JSON.parse(String(params[2])), undone: false });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("UPDATE profile_changes SET undone_at = NULL")) {
      const change = changes.get(String(params[1]));
      if (change) change.undone = false;
      return { rows: [], rowCount: 1 };
    }
    if (failWrite && sql.startsWith("UPDATE profiles SET headline")) throw new Error("db down");
    if (sql.includes("UPDATE profile_changes")) {
      const change = changes.get(String(params[1]));
      if (!change || change.undone) return empty;
      change.undone = true;
      return { rows: [{ before: change.before }], rowCount: 1 };
    }
    if (sql.includes("FROM profile_changes")) {
      const change = changes.get(String(params[1]));
      return change ? { rows: [{ id: params[1], found: 1, before: change.before, created_at: NOW, undone_at: change.undone ? NOW : null }], rowCount: 1 } : empty;
    }
    if (sql.includes("INSERT INTO profiles")) return empty;
    if (sql.includes("SELECT email FROM users")) return { rows: [{ email: "ada@push.app" }], rowCount: 1 };
    if (sql.includes("AS follower_count")) return { rows: [{ user_id: USER, display_name: "Ada", updated_at: NOW, profile_public: true }], rowCount: 1 };
    if (sql.includes("JOIN users u ON u.id = p.user_id WHERE p.user_id = $1")) return { rows: [current()], rowCount: 1 };
    return empty;
  };
  return { seen, changes, deps: { query, now: () => new Date(NOW) } as Deps };
};

const send = (method: string, path: string, body?: unknown, key?: string): Request =>
  new Request("https://core.example" + path, {
    method,
    headers: { authorization: "Bearer secret-token", "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const written = (seen: Call[]) => seen.find((call) => call.sql.startsWith("UPDATE profiles SET headline"));

test("a PATCH with an Idempotency-Key keeps the replaced values and answers with the change id", async () => {
  resetLimits();
  const w = world();
  const res = await handle(send("PATCH", "/api/v1/me/profile", { headline: "시니어 백엔드", skills: ["Kotlin"] }, CHANGE), env(), w.deps);
  assert.equal(res.status, 200);
  const body = await res.json() as { data: { changeId?: string } };
  assert.equal(body.data.changeId, CHANGE);
  assert.deepEqual(w.changes.get(CHANGE)?.before, { headline: "백엔드 개발자" });
  const insert = w.seen.findIndex((call) => call.sql.includes("INSERT INTO profile_changes"));
  const update = w.seen.findIndex((call) => call.sql.startsWith("UPDATE profiles SET headline"));
  assert.ok(insert >= 0 && insert < update, "the old values are kept before the write");
});

test("a PATCH without a key, or one that changes nothing, leaves no change", async () => {
  resetLimits();
  const plain = world();
  const first = await handle(send("PATCH", "/api/v1/me/profile", { headline: "다른 말" }), env(), plain.deps);
  assert.equal(((await first.json()) as { data: { changeId?: string } }).data.changeId, undefined);
  assert.equal(plain.changes.size, 0);

  resetLimits();
  const same = world();
  const second = await handle(send("PATCH", "/api/v1/me/profile", { headline: "백엔드 개발자" }, CHANGE), env(), same.deps);
  assert.equal(((await second.json()) as { data: { changeId?: string } }).data.changeId, undefined);
  assert.equal(same.changes.size, 0);
});

test("a retried PATCH keeps the first change and still answers with its id", async () => {
  resetLimits();
  const w = world(new Map([[CHANGE, { before: { headline: "처음 값" }, undone: false }]]));
  const res = await handle(send("PATCH", "/api/v1/me/profile", { headline: "백엔드 개발자" }, CHANGE), env(), w.deps);
  assert.equal(((await res.json()) as { data: { changeId?: string } }).data.changeId, CHANGE);
  assert.deepEqual(w.changes.get(CHANGE)?.before, { headline: "처음 값" });
});

test("GET change says which fields it moved and whether it was undone", async () => {
  resetLimits();
  const w = world(new Map([[CHANGE, { before: { headline: "a", skills: [] }, undone: false }]]));
  const res = await handle(send("GET", `/api/v1/me/profile/changes/${CHANGE}`), env(), w.deps);
  assert.equal(res.status, 200);
  assert.deepEqual(((await res.json()) as { data: unknown }).data, { id: CHANGE, fields: ["headline", "skills"], undone: false, createdAt: "2026-11-17T00:00:00Z" });
  resetLimits();
  assert.equal((await handle(send("GET", "/api/v1/me/profile/changes/cccccccc-cccc-4ccc-8ccc-cccccccccccc"), env(), w.deps)).status, 404);
});

test("undo writes the kept values back once, then answers 409", async () => {
  resetLimits();
  const w = world(new Map([[CHANGE, { before: { headline: "옛 소개", skills: ["Go"] }, undone: false }]]));
  const undo = () => handle(send("POST", `/api/v1/me/profile/changes/${CHANGE}/undo`, undefined, "dddddddd-dddd-4ddd-8ddd-dddddddddddd"), env(), w.deps);
  const res = await undo();
  assert.equal(res.status, 200);
  const params = written(w.seen)?.params ?? [];
  assert.equal(params[1], "옛 소개");
  assert.equal(params[8], JSON.stringify(["Go"]));
  assert.equal(params[2], "dev", "fields the change did not move stay as they are");
  assert.equal(w.changes.get(CHANGE)?.undone, true);
  resetLimits();
  assert.equal((await handle(send("POST", `/api/v1/me/profile/changes/${CHANGE}/undo`, undefined, "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"), env(), w.deps)).status, 409);
});

test("undo of an unknown change is 404 and writes nothing", async () => {
  resetLimits();
  const w = world();
  const res = await handle(send("POST", `/api/v1/me/profile/changes/${CHANGE}/undo`, undefined, "dddddddd-dddd-4ddd-8ddd-dddddddddddd"), env(), w.deps);
  assert.equal(res.status, 404);
  assert.equal(written(w.seen), undefined);
});

test("an undo whose write fails can be tried again", async () => {
  resetLimits();
  const w = world(new Map([[CHANGE, { before: { headline: "옛 소개" }, undone: false }]]), true);
  const res = await handle(send("POST", `/api/v1/me/profile/changes/${CHANGE}/undo`, undefined, "dddddddd-dddd-4ddd-8ddd-dddddddddddd"), env(), w.deps);
  assert.equal(res.status, 500);
  assert.equal(w.changes.get(CHANGE)?.undone, false);
});
