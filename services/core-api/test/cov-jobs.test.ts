import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { beforeEach, test } from "node:test";

import type { Query } from "../src/db.ts";
import { handle, type CoreEnv } from "../src/handler.ts";
import { resetLimits } from "../src/ratelimit.ts";

const ALICE = "aaaaaaaa-0000-4000-8000-000000000001";
const BOB = "bbbbbbbb-0000-4000-8000-000000000002";
const NOW = new Date("2026-10-22T00:00:00Z");
const env: CoreEnv = { APP_ENV: "production" };
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const TOKENS: Record<string, string> = { [sha("tok-alice")]: ALICE, [sha("tok-bob")]: BOB };

type Row = Record<string, unknown>;
type Call = { sql: string; params: unknown[] };
type Body = { data: Row & Row[]; page?: { nextCursor: string | null; hasMore: boolean }; error?: { code: string; message: string; details: unknown } };

// In-memory jobs/gap_analyses tables that honour the user_id predicate, so isolation is observable.
function world() {
  const seen: Call[] = [];
  const jobs = new Map<string, Row>();
  const analyses: Row[] = [];
  const out = (rows: Row[]) => ({ rows, rowCount: rows.length });
  const query: Query = async (sql, params = []) => {
    seen.push({ sql, params });
    if (sql.includes("access_tokens")) {
      const id = TOKENS[String(params[0])];
      return out(id ? [{ id, display_name: "u", locale: "ko", plan: "FREE", created_at: "2026-01-01T00:00:00Z", token_expires_at: "2099-01-01T00:00:00Z" }] : []);
    }
    if (sql.includes("rate_limits")) return out([{ hits: 1 }]);
    if (sql.startsWith("INSERT INTO idempotency_keys")) return out([{ id: "idem" }]);
    if (sql.startsWith("INSERT INTO jobs")) {
      const [id, user_id, company, title, source_kind, source_url, source_text, requirements, preferred, deadline, language, now] = params;
      jobs.set(String(id), { id, user_id, revision: 1, company, title, source_kind, source_url, source_text, requirements, preferred, keywords: "[]", risks: "[]", deadline, language, archived: false, created_at: now, updated_at: now });
      return out([]);
    }
    if (/^SELECT .* FROM jobs WHERE id = \$1 AND user_id = \$2$/.test(sql)) {
      const job = jobs.get(String(params[0]));
      return out(job && job.user_id === params[1] ? [{ ...job }] : []);
    }
    if (sql.includes("FROM jobs WHERE user_id = $1")) {
      const limit = Number(params[params.length - 1]);
      return out([...jobs.values()].filter((job) => job.user_id === params[0]).slice(0, limit));
    }
    if (sql.startsWith("UPDATE jobs")) {
      const job = jobs.get(String(params[0]));
      if (!job || job.user_id !== params[1] || job.revision !== params[15]) return out([]);
      Object.assign(job, {
        revision: Number(job.revision) + 1, company: params[2], title: params[3], requirements: params[7], preferred: params[8],
        deadline: params[11], archived: params[13], updated_at: params[14],
      });
      return out([{ ...job }]);
    }
    if (sql.includes("FROM gap_analyses")) {
      const limit = Number(params[params.length - 1]);
      return out(analyses.filter((row) => row.user_id === params[0] && row.job_id === params[1]).slice(0, limit));
    }
    if (sql.includes("INSERT INTO ai_jobs")) return out([{ id: params[0], queue: params[2] }]);
    return out([]);
  };
  const call = async (method: string, path: string, opts: { token?: string | null; body?: unknown } = {}) => {
    const headers: Record<string, string> = { "idempotency-key": crypto.randomUUID(), "content-type": "application/json" };
    const token = opts.token === undefined ? "tok-alice" : opts.token;
    if (token) headers.authorization = `Bearer ${token}`;
    const body = opts.body === undefined ? undefined : typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
    const res = await handle(new Request(`https://core.example${path}`, { method, headers, body }), env, { query, now: () => NOW });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as Body };
  };
  return { seen, jobs, analyses, query, call };
}

const valid = {
  company: "Acme", title: "Backend Engineer", sourceKind: "URL", sourceUrl: "https://jobs.example/1",
  sourceText: "We need TypeScript.", language: "en", deadline: "2026-11-30", requirements: ["TS"], preferred: ["Go"],
};

beforeEach(() => resetLimits());

test("jobs: missing or unknown bearer token is rejected with 401", async () => {
  const w = world();
  const missing = await w.call("GET", "/api/v1/jobs", { token: null });
  assert.equal(missing.status, 401);
  assert.equal(missing.body.error?.code, "UNAUTHENTICATED");
  const unknown = await w.call("GET", "/api/v1/jobs", { token: "tok-nobody" });
  assert.equal(unknown.status, 401);
  assert.equal(unknown.body.error?.code, "UNAUTHENTICATED");
  assert.equal(w.seen.some((c) => c.sql.includes("FROM jobs")), false);
});

test("jobs: create stores the job for the caller and get returns the same DTO", async () => {
  const w = world();
  const created = await w.call("POST", "/api/v1/jobs", { body: valid });
  assert.equal(created.status, 201);
  const job = created.body.data;
  assert.deepEqual({ ...job, id: "x" }, {
    id: "x", revision: 1, company: "Acme", title: "Backend Engineer", sourceKind: "URL", sourceUrl: "https://jobs.example/1",
    sourceText: "We need TypeScript.", requirements: ["TS"], preferred: ["Go"], keywords: [], risks: [], deadline: "2026-11-30",
    language: "en", createdAt: "2026-10-22T00:00:00Z", updatedAt: "2026-10-22T00:00:00Z",
  });
  const insert = w.seen.find((c) => c.sql.startsWith("INSERT INTO jobs"));
  assert.equal(insert?.params[1], ALICE);

  const got = await w.call("GET", `/api/v1/jobs/${job.id}`);
  assert.equal(got.status, 200);
  assert.deepEqual(got.body.data, job);
});

test("jobs: TEXT sources need no URL and default optional lists to empty", async () => {
  const w = world();
  const res = await w.call("POST", "/api/v1/jobs", { body: { company: "A", title: "T", sourceKind: "TEXT", sourceText: "x", language: "ko" } });
  assert.equal(res.status, 201);
  assert.equal(res.body.data.sourceUrl, null);
  assert.equal(res.body.data.deadline, null);
  assert.deepEqual(res.body.data.requirements, []);
});

test("jobs: create rejects malformed bodies with 400 VALIDATION_ERROR", async () => {
  const cases: [unknown, string, unknown][] = [
    ["", "request body required", undefined],
    ["{not json", "invalid request body", undefined],
    [[1, 2], "invalid request body", undefined],
    [{ ...valid, company: 5 }, "invalid request body", undefined],
    [{ ...valid, language: undefined }, "invalid request body", undefined],
    [{ ...valid, company: "" }, "company must be 1-200 characters", { field: "company" }],
    [{ ...valid, company: "c".repeat(201) }, "company must be 1-200 characters", { field: "company" }],
    [{ ...valid, title: "t".repeat(301) }, "title must be 1-300 characters", { field: "title" }],
    [{ ...valid, sourceKind: "PDF" }, "must be URL, TEXT or DOM", { field: "sourceKind" }],
    [{ ...valid, sourceKind: "DOM", sourceUrl: null }, "required for URL/DOM sources", { field: "sourceUrl" }],
    [{ ...valid, sourceUrl: "ftp://jobs.example/1" }, "must be an http(s) URL without credentials", { field: "sourceUrl" }],
    [{ ...valid, sourceUrl: "https://user:pw@jobs.example/1" }, "must be an http(s) URL without credentials", { field: "sourceUrl" }],
    [{ ...valid, sourceUrl: "not a url" }, "must be an http(s) URL without credentials", { field: "sourceUrl" }],
    [{ ...valid, sourceText: "" }, "collected source text is required (1-200000 characters)", { field: "sourceText" }],
    [{ ...valid, deadline: "30/11/2026" }, "must be YYYY-MM-DD", { field: "deadline" }],
    [{ ...valid, deadline: 20261130 }, "must be YYYY-MM-DD", { field: "deadline" }],
  ];
  for (const [body, message, details] of cases) {
    const w = world();
    resetLimits();
    const res = await w.call("POST", "/api/v1/jobs", { body });
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(res.body.error?.code, "VALIDATION_ERROR");
    assert.equal(res.body.error?.message, message);
    if (details) assert.deepEqual(res.body.error?.details, details);
    assert.equal(w.jobs.size, 0);
  }
});

test("jobs: another user cannot read, patch, or list analyses of someone else's job", async () => {
  const w = world();
  const id = (await w.call("POST", "/api/v1/jobs", { body: valid })).body.data.id;
  const before = w.seen.length;
  for (const [method, path, body] of [
    ["GET", `/api/v1/jobs/${id}`, undefined],
    ["PATCH", `/api/v1/jobs/${id}`, { expectedRevision: 1, title: "pwned" }],
    ["GET", `/api/v1/jobs/${id}/analyses`, undefined],
  ] as const) {
    const res = await w.call(method, path, { token: "tok-bob", body });
    assert.equal(res.status, 404, `${method} ${path}`);
    assert.equal(res.body.error?.code, "NOT_FOUND");
  }
  assert.equal(w.jobs.get(String(id))?.title, "Backend Engineer");
  const lookups = w.seen.slice(before).filter((call) => /FROM jobs WHERE id = \$1 AND user_id = \$2/.test(call.sql));
  assert.equal(lookups.length, 3);
  for (const c of lookups) assert.deepEqual(c.params, [id, BOB]);
  const listed = await w.call("GET", "/api/v1/jobs", { token: "tok-bob" });
  assert.deepEqual(listed.body.data, []);
  assert.equal(w.seen.at(-1)?.params[0], BOB);
});

test("jobs: non-UUID ids are rejected before touching the table", async () => {
  const w = world();
  const res = await w.call("GET", "/api/v1/jobs/not-a-uuid");
  assert.equal(res.status, 400);
  assert.deepEqual(res.body.error?.details, { field: "id" });
});

test("jobs: list filters by archived and query and paginates with a cursor", async () => {
  const w = world();
  for (let i = 0; i < 3; i++) {
    const id = `00000000-0000-4000-8000-00000000000${i}`;
    w.jobs.set(id, { id, user_id: ALICE, revision: 1, company: `C${i}`, title: "T", source_kind: "TEXT", source_url: null, source_text: "x",
      requirements: '["a"]', preferred: "not json", keywords: null, risks: [], deadline: "2026-12-01T00:00:00Z", language: "ko",
      created_at: `2026-10-0${3 - i}T00:00:00Z`, updated_at: `2026-10-0${3 - i}T00:00:00Z` });
  }
  const first = await w.call("GET", "/api/v1/jobs?limit=2&archived=true&query=acme");
  assert.equal(first.status, 200);
  const sql = w.seen.at(-1)!;
  assert.match(sql.sql, /WHERE user_id = \$1 AND archived = \$2 AND \(company ILIKE \$3 OR title ILIKE \$4\) ORDER BY created_at DESC, id DESC LIMIT \$5$/);
  assert.deepEqual(sql.params, [ALICE, true, "%acme%", "%acme%", 3]);
  assert.equal(first.body.data.length, 2);
  assert.equal(first.body.page?.hasMore, true);
  assert.equal(first.body.data[0].deadline, "2026-12-01");
  assert.deepEqual(first.body.data[0].requirements, ["a"]);
  assert.deepEqual(first.body.data[0].preferred, []);
  assert.ok(first.body.page?.nextCursor);

  await w.call("GET", `/api/v1/jobs?archived=false&cursor=${first.body.page!.nextCursor}`);
  const next = w.seen.at(-1)!;
  assert.match(next.sql, /archived = \$2 AND \(created_at, id\) < \(\$3, \$4\)/);
  assert.deepEqual(next.params, [ALICE, false, "2026-10-02T00:00:00Z", "00000000-0000-4000-8000-000000000001", 51]);
});

test("jobs: list rejects a bad limit or cursor", async () => {
  const w = world();
  const limit = await w.call("GET", "/api/v1/jobs?limit=0");
  assert.equal(limit.status, 400);
  assert.deepEqual(limit.body.error?.details, { field: "limit" });
  const cursor = await w.call("GET", "/api/v1/jobs?cursor=%%%");
  assert.equal(cursor.status, 400);
  assert.deepEqual(cursor.body.error?.details, { field: "cursor" });
});

test("jobs: patch updates fields with optimistic revision and clears the deadline", async () => {
  const w = world();
  const id = (await w.call("POST", "/api/v1/jobs", { body: valid })).body.data.id;
  const res = await w.call("PATCH", `/api/v1/jobs/${id}`, {
    body: { expectedRevision: 1, company: "Beta", title: "Staff", requirements: ["Rust"], preferred: ["K8s"], deadline: null },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.revision, 2);
  assert.equal(res.body.data.company, "Beta");
  assert.equal(res.body.data.title, "Staff");
  assert.deepEqual(res.body.data.requirements, ["Rust"]);
  assert.deepEqual(res.body.data.preferred, ["K8s"]);
  assert.equal(res.body.data.deadline, null);
  const update = w.seen.find((c) => c.sql.startsWith("UPDATE jobs"))!;
  assert.match(update.sql, /WHERE id = \$1 AND user_id = \$2 AND revision = \$16/);
  assert.equal(update.params[1], ALICE);

  const kept = await w.call("PATCH", `/api/v1/jobs/${id}`, { body: { expectedRevision: 2, deadline: "2027-01-02" } });
  assert.equal(kept.body.data.deadline, "2027-01-02");
  assert.equal(kept.body.data.company, "Beta");
});

test("jobs: patch with a stale revision answers 409 with the current revision", async () => {
  const w = world();
  const id = (await w.call("POST", "/api/v1/jobs", { body: valid })).body.data.id;
  const res = await w.call("PATCH", `/api/v1/jobs/${id}`, { body: { expectedRevision: 7, title: "x" } });
  assert.equal(res.status, 409);
  assert.equal(res.body.error?.code, "REVISION_CONFLICT");
  assert.deepEqual(res.body.error?.details, { currentRevision: 1 });
});

test("jobs: patch validates its body", async () => {
  const w = world();
  const id = (await w.call("POST", "/api/v1/jobs", { body: valid })).body.data.id;
  const cases: [unknown, unknown][] = [
    [{ title: "x" }, null],
    [{ expectedRevision: 1, company: "" }, { field: "company" }],
    [{ expectedRevision: 1, company: 3 }, { field: "company" }],
    [{ expectedRevision: 1, title: "" }, { field: "title" }],
    [{ expectedRevision: 1, deadline: "tomorrow" }, { field: "deadline" }],
  ];
  for (const [body, details] of cases) {
    const res = await w.call("PATCH", `/api/v1/jobs/${id}`, { body });
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(res.body.error?.code, "VALIDATION_ERROR");
    assert.deepEqual(res.body.error?.details, details);
  }
  assert.equal(w.jobs.get(String(id))?.revision, 1);
});

test("jobs: analyses are listed for the owner and mapped to the API shape", async () => {
  const w = world();
  const id = String((await w.call("POST", "/api/v1/jobs", { body: valid })).body.data.id);
  const app = "cccccccc-0000-4000-8000-000000000003";
  w.analyses.push(
    { id: "dddddddd-0000-4000-8000-000000000001", user_id: ALICE, application_id: app, job_id: id, job_revision: "1", evidence_ids: '["e1"]',
      matched: ["TS"], missing: "[]", preferred_missing: ["Go"], risks: [], fit_score: "72", method: "LLM", stale: "t", created_at: "2026-10-21T00:00:00Z" },
    { id: "dddddddd-0000-4000-8000-000000000002", user_id: ALICE, application_id: app, job_id: id, job_revision: 1, evidence_ids: null,
      matched: [], missing: [], preferred_missing: [], risks: [], fit_score: null, method: "RULES", stale: false, created_at: "2026-10-20T00:00:00Z" },
  );
  const res = await w.call("GET", `/api/v1/jobs/${id}/analyses?limit=1`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data, [{
    id: "dddddddd-0000-4000-8000-000000000001", applicationId: app, jobId: id, jobRevision: 1, evidenceIds: ["e1"], matched: ["TS"],
    missing: [], preferredMissing: ["Go"], risks: [], fitScore: 72, method: "LLM", stale: true, createdAt: "2026-10-21T00:00:00Z",
  }]);
  assert.equal(res.body.page?.hasMore, true);
  const list = w.seen.at(-1)!;
  assert.deepEqual(list.params, [ALICE, id, 2]);

  const next = await w.call("GET", `/api/v1/jobs/${id}/analyses?cursor=${res.body.page!.nextCursor}`);
  assert.equal(next.status, 200);
  assert.match(w.seen.at(-1)!.sql, /AND \(created_at, id\) < \(\$3, \$4\)/);
});
