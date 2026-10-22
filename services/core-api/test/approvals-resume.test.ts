import assert from "node:assert/strict";
import { test } from "node:test";

import { handle, type CoreEnv, type Deps } from "../src/handler.ts";
import { uuid5Url } from "../src/http.ts";
import { resetLimits } from "../src/ratelimit.ts";

const USER = "12345678-1234-5678-1234-567812345678";
const CONV = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const APPROVAL = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const NOW = new Date("2026-10-22T00:00:00Z");
const SECRET = "internal-secret";
const OPTIONS = JSON.stringify([{ id: "approve", label: "실행" }, { id: "reject", label: "취소" }]);

type Row = Record<string, unknown>;

const env = (): CoreEnv => ({ APP_ENV: "production", AI_ORIGIN: "https://ai.example.test", INTERNAL_API_SECRET: SECRET });

const fakeDb = (approval: Row | null) => {
  const sqls: string[] = [];
  const state = { approval: approval ? { ...approval } : null, jobs: 0 };
  const query: Deps["query"] = async (sql, params = []) => {
    sqls.push(sql);
    const rows = (list: Row[]) => ({ rows: list, rowCount: list.length });
    if (sql.includes("access_tokens")) {
      return rows([{ id: USER, display_name: "Ada", locale: "ko", plan: "PRO", created_at: "2026-01-02T03:04:05Z", token_expires_at: "2099-01-01T00:00:00Z" }]);
    }
    if (sql.includes("rate_limits")) return rows([{ hits: 1 }]);
    if (sql.includes("idempotency_keys") && sql.includes("INSERT")) return rows([{ id: "idem" }]);
    if (sql.includes("FROM users") && sql.includes("display_name")) {
      return rows([{ id: USER, display_name: "Ada", locale: "ko", plan: "PRO", created_at: NOW.toISOString() }]);
    }
    if (sql.startsWith("SELECT id, status, kind, options, job_id, expires_at FROM approvals")) {
      return rows(state.approval && params[0] === APPROVAL && params[1] === CONV && params[2] === USER ? [state.approval] : []);
    }
    if (sql.startsWith("UPDATE approvals SET status = $1")) {
      if (!state.approval || state.approval.status !== "PENDING") return rows([]);
      state.approval.status = params[0];
      return rows([{ id: APPROVAL }]);
    }
    if (sql.startsWith("UPDATE approvals SET status = 'EXPIRED'")) {
      if (state.approval) state.approval.status = "EXPIRED";
      return rows([]);
    }
    if (sql.includes("INSERT INTO chat_jobs")) {
      state.jobs += 1;
      return rows([{ id: params[2] }]);
    }
    return rows([]);
  };
  return { query, sqls, state };
};

const deps = (query: Deps["query"], woke: string[] = []): Deps => ({
  query,
  now: () => NOW,
  fetch: async (input) => {
    woke.push(String(input));
    return new Response("{}", { status: 200 });
  },
});

const resolve = (optionId: string, key = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"): Request =>
  new Request(`https://core.example/api/v1/conversations/${CONV}/approvals/${APPROVAL}`, {
    method: "POST",
    headers: { authorization: "Bearer t", "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify({ optionId }),
  });

const pending = (extra: Row = {}): Row => ({
  id: APPROVAL, status: "PENDING", kind: "TOOL_ACTION", options: OPTIONS, job_id: "job-1",
  expires_at: "2026-10-23T00:00:00Z", ...extra,
});

test("approving a tool card queues one resume job and the second answer is 409", async () => {
  resetLimits();
  const db = fakeDb(pending());
  const woke: string[] = [];
  const res = await handle(resolve("approve"), env(), deps(db.query, woke));
  assert.equal(res.status, 202);
  const body = await res.json() as { data: { id: string; status: string; optionId: string; jobId: string } };
  assert.equal(body.data.status, "APPROVED");
  assert.equal(body.data.optionId, "approve");
  assert.match(body.data.jobId, /^[0-9a-f-]{36}$/);
  assert.equal(db.state.jobs, 1);
  assert.deepEqual(woke, ["https://ai.example.test/internal/chat/schedule"]);
  const insert = db.sqls.find((sql) => sql.includes("INSERT INTO chat_jobs")) || "";
  assert.match(insert, /'ai', payload->'ai'/);

  resetLimits();
  const again = await handle(resolve("approve", "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee"), env(), deps(db.query));
  assert.equal(again.status, 409);
  assert.equal((await again.json() as { error: { code: string } }).error.code, "APPROVAL_ALREADY_RESOLVED");
  assert.equal(db.state.jobs, 1);
});

test("an expired card is 410 and is marked EXPIRED", async () => {
  resetLimits();
  const db = fakeDb(pending({ expires_at: "2026-10-21T00:00:00Z" }));
  const res = await handle(resolve("approve"), env(), deps(db.query));
  assert.equal(res.status, 410);
  assert.equal((await res.json() as { error: { code: string } }).error.code, "APPROVAL_EXPIRED");
  assert.equal(db.state.approval?.status, "EXPIRED");
  assert.equal(db.state.jobs, 0);
});

test("rejecting a tool card still resumes so the model hears the rejection", async () => {
  resetLimits();
  const db = fakeDb(pending());
  const res = await handle(resolve("reject"), env(), deps(db.query));
  assert.equal(res.status, 202);
  assert.equal((await res.json() as { data: { status: string } }).data.status, "REJECTED");
  assert.equal(db.state.jobs, 1);
});

test("a legacy document card keeps 200, applies through a job, and someone else's card is 404", async () => {
  const legacy = () => pending({
    kind: "DOCUMENT_EDIT", job_id: null, expires_at: null,
    options: JSON.stringify([{ id: "apply", label: "적용" }, { id: "skip", label: "그대로 두기" }]),
  });
  resetLimits();
  const skipped = fakeDb(legacy());
  const skip = await handle(resolve("skip"), env(), deps(skipped.query));
  assert.equal(skip.status, 200);
  assert.deepEqual((await skip.json() as { data: unknown }).data, { id: APPROVAL, status: "APPROVED", optionId: "skip" });
  assert.equal(skipped.state.jobs, 0);

  resetLimits();
  const applied = fakeDb(legacy());
  const apply = await handle(resolve("apply"), env(), deps(applied.query));
  assert.equal(apply.status, 200);
  const body = await apply.json() as { data: { status: string; jobId: string } };
  assert.equal(body.data.status, "APPROVED");
  assert.match(body.data.jobId, /^[0-9a-f-]{36}$/);
  assert.equal(applied.state.jobs, 1);

  resetLimits();
  const missing = await handle(resolve("approve"), env(), deps(fakeDb(null).query));
  assert.equal(missing.status, 404);

  resetLimits();
  const unknown = await handle(resolve("nope"), env(), deps(fakeDb(pending()).query));
  assert.equal(unknown.status, 400);
});

test("a new message rejects waiting tool cards but not resume gates", async () => {
  resetLimits();
  const db = fakeDb(null);
  const res = await handle(new Request(`https://core.example/api/v1/conversations/${CONV}/messages`, {
    method: "POST",
    headers: { authorization: "Bearer t", "content-type": "application/json", "idempotency-key": "cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee" },
    body: JSON.stringify({ text: "다른 얘기", accessMode: "AUTO" }),
  }), env(), deps(db.query));
  assert.equal(res.status, 202);
  const insert = db.sqls.find((sql) => sql.includes("INSERT INTO chat_jobs")) || "";
  assert.match(insert, /UPDATE approvals SET status = 'REJECTED'/);
  assert.match(insert, /kind <> 'RESUME_GATE'/);
});

test("the ai worker queues the next resume phase only through act-as", async () => {
  const request = (headers: Record<string, string>): Request => new Request(`https://core.example/api/v1/conversations/${CONV}/resume-jobs`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "dddddddd-bbbb-4ccc-8ddd-eeeeeeeeeeee", ...headers },
    body: JSON.stringify({ resume: { gate: "analyze", optionId: "continue", auto: true } }),
  });
  resetLimits();
  const db = fakeDb(null);
  const acted = await handle(request({ "x-push-internal-secret": SECRET, "x-push-act-as": USER }), env(), deps(db.query));
  assert.equal(acted.status, 202);
  assert.equal(db.state.jobs, 1);

  resetLimits();
  const bearer = await handle(request({ authorization: "Bearer t" }), env(), deps(db.query));
  assert.equal(bearer.status, 404);
  assert.equal(db.state.jobs, 1);
});

test("an answer without Idempotency-Key uses a key derived from the card and option", async () => {
  resetLimits();
  const db = fakeDb(pending());
  const keys: unknown[] = [];
  const query: Deps["query"] = async (sql, params = []) => {
    if (sql.includes("idempotency_keys") && sql.includes("INSERT")) keys.push(params[3]);
    return db.query(sql, params);
  };
  const res = await handle(new Request(`https://core.example/api/v1/conversations/${CONV}/approvals/${APPROVAL}`, {
    method: "POST",
    headers: { authorization: "Bearer t", "content-type": "application/json" },
    body: JSON.stringify({ optionId: "approve" }),
  }), env(), deps(query));
  assert.equal(res.status, 202);
  assert.deepEqual(keys, [await uuid5Url(`push:approval-answer:${APPROVAL}:approve`)]);

  resetLimits();
  const other = await handle(new Request("https://core.example/api/v1/conversations", {
    method: "POST",
    headers: { authorization: "Bearer t", "content-type": "application/json" },
    body: JSON.stringify({ title: "x" }),
  }), env(), deps(query));
  assert.equal(other.status, 400);
});
