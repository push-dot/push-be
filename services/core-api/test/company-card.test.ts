import assert from "node:assert/strict";
import { test } from "node:test";

import type { QueryResult, Row } from "../src/db.ts";
import { handle } from '../src/handler.ts';
import type { CoreEnv, Deps } from '../src/handler.ts';
import type { Json } from "../src/json.ts";
import { resetLimits } from "../src/ratelimit.ts";

const USER = "12345678-1234-5678-1234-567812345678";
const COMPANY = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const POSTING = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const APP = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const APPLICANT = "99999999-9999-4999-8999-999999999999";
const NOW = "2026-10-21T00:00:00.000Z";

type Call = { sql: string; params: Array<unknown> };

const env = (): CoreEnv => ({ APP_ENV: "production", MANAGED_AI: "1" });
const deps = (query: Deps["query"]): Deps => ({ query, now: () => new Date(NOW) });
const empty: QueryResult = { rows: [], rowCount: 0 };

const authed = (seen: Array<Call>, extra: Deps["query"]): Deps["query"] => async (sql, params = []) => {
  seen.push({ sql, params });
  if (sql.includes("rate_limits")) {return { rows: [{ hits: 1 }], rowCount: 1 };}
  if (sql.includes("access_tokens")) {
    return {
      rows: [{
        id: USER, display_name: "Ada", locale: "ko", plan: "FREE", subscription_status: "NONE",
        created_at: NOW, token_expires_at: "2099-01-01T00:00:00Z", is_employer: true,
      }],
      rowCount: 1,
    };
  }
  if (sql.includes("idempotency_keys") && sql.includes("INSERT")) {return { rows: [{ id: "1" }], rowCount: 1 };}
  if (sql.includes("idempotency_keys")) {return empty;}
  if (sql.includes("is_employer") && sql.includes("FROM users") && !sql.includes("access_tokens")) {
    return { rows: [{ is_employer: true, display_name: "Ada" }], rowCount: 1 };
  }
  if (sql.includes("INSERT INTO ai_jobs")) {return { rows: [{ id: String(params[0]), queue: String(params[2]) }], rowCount: 1 };}
  return extra(sql, params);
};

const missingColumn = (): Error => Object.assign(new Error('column "created_by" of relation "job_postings" does not exist'), { code: "42703" });

const get = (path: string): Request => new Request("https://core.example" + path, {
  headers: { authorization: "Bearer secret-token" },
});

const post = (path: string, body: unknown, key: string): Request => new Request("https://core.example" + path, {
  method: "POST",
  headers: {
    authorization: "Bearer secret-token",
    "content-type": "application/json",
    "idempotency-key": key,
  },
  body: JSON.stringify(body),
});

test("company postings count unseen applicants and name the creator", async () => {
  resetLimits();
  const seen: Array<Call> = [];
  const res = await handle(get("/api/v1/companies/me/postings"), env(), deps(authed(seen, async (sql) => {
    if (sql.includes("SELECT company_id FROM company_members")) {return { rows: [{ company_id: COMPANY }], rowCount: 1 };}
    if (sql.includes("count(*)") && sql.includes("job_postings") && !sql.includes("company_seen_at")) {
      return { rows: [{ total: 1 }], rowCount: 1 };
    }
    if (sql.includes("company_seen_at") && sql.includes("created_by")) {
      return {
        rows: [{
          id: POSTING, company: "Acme", title: "Backend", created_at: NOW, revision: 1,
          new_applicant_count: 3, created_by_name: "Ada", status: "OPEN", closed_at: null,
        }],
        rowCount: 1,
      };
    }
    return empty;
  })));
  assert.equal(res.status, 200);
  const body = await readJson(res);
  assert.equal(at(body, "data", 0, "newApplicantCount"), 3);
  assert.deepEqual(at(body, "data", 0, "createdBy"), { displayName: "Ada" });
  const list = seen.find((call) => call.sql.includes("company_seen_at") && call.sql.includes("ORDER BY"));
  assert.ok(list);
  assert.match(list.sql, /to_jsonb\(a\) ->> 'company_seen_at'/);
  assert.match(list.sql, /to_jsonb\(p\) ->> 'created_by'/);
});

test("opening an applicant marks it seen once", async () => {
  resetLimits();
  const seen: Array<Call> = [];
  const res = await handle(get(`/api/v1/postings/${POSTING}/applicants/${APP}`), env(), deps(authed(seen, async (sql) => {
    if (sql.includes("company_members") && sql.includes("job_postings")) {return { rows: [{ id: POSTING }], rowCount: 1 };}
    if (sql.includes("FROM applications")) {
      return { rows: [{ id: APP, user_id: APPLICANT, stage: "APPLIED", revision: 1, applied_at: NOW, notes: "secret" }], rowCount: 1 };
    }
    if (sql.includes("UPDATE") && sql.includes("company_seen_at")) {return empty;}
    if (sql.includes("FROM users")) {return { rows: [{ display_name: "Bea", email: "bea@push.app" }], rowCount: 1 };}
    return empty;
  })));
  assert.equal(res.status, 200);
  const body = await readJson(res);
  assert.equal(at(body, "data", "application", "notes"), undefined);
  const update = seen.find((call) => call.sql.includes("UPDATE") && call.sql.includes("company_seen_at"));
  assert.ok(update);
  assert.equal(update.params[0], APP);
  assert.equal(update.params[1], NOW);

  resetLimits();
  const legacy = await handle(get(`/api/v1/postings/${POSTING}/applicants/${APP}`), env(), deps(authed([], async (sql) => {
    if (sql.includes("company_members") && sql.includes("job_postings")) {return { rows: [{ id: POSTING }], rowCount: 1 };}
    if (sql.includes("FROM applications")) {
      return { rows: [{ id: APP, user_id: APPLICANT, stage: "APPLIED", revision: 1, applied_at: NOW }], rowCount: 1 };
    }
    if (sql.includes("company_seen_at")) {throw missingColumn();}
    if (sql.includes("FROM users")) {return { rows: [{ display_name: "Bea", email: "bea@push.app" }], rowCount: 1 };}
    return empty;
  })));
  assert.equal(legacy.status, 200);
});

test("create stores created_by and retries when the column is missing", async () => {
  resetLimits();
  const seen: Array<Call> = [];
  const res = await handle(post("/api/v1/postings", {
    title: "Backend",
    jobCategory: "dev",
    careerMin: 1,
    careerMax: 3,
    location: "서울",
    employmentType: "full_time",
    description: "Build APIs",
  }, "33333333-3333-4333-8333-333333333333"), env(), deps(authed(seen, async (sql) => {
    if (sql.includes("verified_at IS NOT NULL")) {return { rows: [{ id: COMPANY, name: "Acme" }], rowCount: 1 };}
    if (sql.includes("INSERT INTO job_postings") && sql.includes("created_by")) {throw missingColumn();}
    return empty;
  })));
  assert.equal(res.status, 201);
  const body = await readJson(res);
  assert.deepEqual(at(body, "data", "createdBy"), { displayName: "Ada" });
  assert.equal(at(body, "data", "newApplicantCount"), 0);
  const inserts = seen.filter((call) => call.sql.includes("INSERT INTO job_postings"));
  assert.equal(inserts.length, 3);
  assert.match(inserts[0].sql, /created_by, draft_source/);
  assert.deepEqual(inserts[0].params.slice(-2), [USER, null]);
  assert.match(inserts[1].sql, /created_by/);
  assert.doesNotMatch(inserts[2].sql, /created_by|draft_source/);
  assert.doesNotMatch(inserts[0].sql, /company_user_id/);
});

test("a public posting detail omits the company-only applicant counters", async () => {
  resetLimits();
  const res = await handle(new Request(`https://core.example/api/v1/postings/${POSTING}`), env(), deps(async (sql) => {
    if (sql.includes("rate_limits")) {return { rows: [{ hits: 1 }], rowCount: 1 };}
    if (sql.includes("FROM job_postings")) {
      return { rows: [{ id: POSTING, company: "Acme", title: "Backend", created_at: NOW, applicant_count: 4, closed_at: null }], rowCount: 1 };
    }
    return empty;
  }));
  assert.equal(res.status, 200);
  const body = await readJson(res);
  assert.equal(at(body, "data", "applicantCount"), 4);
  assert.equal(at(body, "data", "newApplicantCount"), undefined);
});

const posting = { title: "Backend", jobCategory: "dev", careerMin: 1, careerMax: 3, location: "서울", employmentType: "full_time", description: "Build APIs" };

const verified = async (sql: string) => sql.includes("verified_at IS NOT NULL") ? { rows: [{ id: COMPANY, name: "Acme" }], rowCount: 1 } : empty;

test("create stores draftSource and rejects unknown values", async () => {
  resetLimits();
  const seen: Array<Call> = [];
  const res = await handle(post("/api/v1/postings", { ...posting, draftSource: "AGENT" }, "44444444-4444-4444-8444-444444444444"), env(), deps(authed(seen, verified)));
  assert.equal(res.status, 201);
  assert.equal(at(await readJson(res), "data", "draftSource"), "AGENT");
  const insert = seen.find((call) => call.sql.includes("INSERT INTO job_postings"));
  assert.ok(insert);
  assert.match(insert.sql, /draft_source/);
  assert.equal(insert.params.at(-1), "AGENT");

  resetLimits();
  const bad = await handle(post("/api/v1/postings", { ...posting, draftSource: "ROBOT" }, "55555555-5555-4555-8555-555555555555"), env(), deps(authed([], verified)));
  assert.equal(bad.status, 400);
  assert.deepEqual(at(await readJson(bad), "error", "details"), { field: "draftSource" });
});

test("create falls back to created_by only when draft_source is missing", async () => {
  resetLimits();
  const seen: Array<Call> = [];
  const res = await handle(post("/api/v1/postings", posting, "66666666-6666-4666-8666-666666666666"), env(), deps(authed(seen, async (sql) => {
    if (sql.includes("verified_at IS NOT NULL")) {return { rows: [{ id: COMPANY, name: "Acme" }], rowCount: 1 };}
    if (sql.includes("INSERT INTO job_postings") && sql.includes("draft_source")) {throw missingColumn();}
    return empty;
  })));
  assert.equal(res.status, 201);
  const inserts = seen.filter((call) => call.sql.includes("INSERT INTO job_postings"));
  assert.equal(inserts.length, 2);
  assert.match(inserts[1].sql, /created_by/);
  assert.equal(at(await readJson(res), "data", "draftSource"), null);
});

test("company postings expose draftSource to members only", async () => {
  resetLimits();
  const seen: Array<Call> = [];
  const res = await handle(get("/api/v1/companies/me/postings"), env(), deps(authed(seen, async (sql) => {
    if (sql.includes("SELECT company_id FROM company_members")) {return { rows: [{ company_id: COMPANY }], rowCount: 1 };}
    if (sql.includes("count(*)") && !sql.includes("company_seen_at")) {return { rows: [{ total: 2 }], rowCount: 1 };}
    if (sql.includes("company_seen_at")) {
      return { rows: [
        { id: POSTING, company: "Acme", title: "A", created_at: NOW, revision: 1, status: "DRAFT", draft_source: "AGENT" },
        { id: APP, company: "Acme", title: "B", created_at: NOW, revision: 1, status: "DRAFT" },
      ], rowCount: 2 };
    }
    return empty;
  })));
  const body = await readJson(res);
  const rows = at(body, "data");
  assert.ok(Array.isArray(rows));
  assert.deepEqual(rows.map((row) => at(row, "draftSource")), ["AGENT", null]);
  assert.match(seen.find((call) => call.sql.includes("company_seen_at") && call.sql.includes("ORDER BY"))!.sql, /to_jsonb\(p\) ->> 'draft_source'/);

  resetLimits();
  const publicList = await handle(new Request("https://core.example/api/v1/postings"), env(), deps(async (sql) => {
    if (sql.includes("rate_limits")) {return { rows: [{ hits: 1 }], rowCount: 1 };}
    if (sql.includes("count(*)")) {return { rows: [{ total: 1 }], rowCount: 1 };}
    if (sql.includes("FROM job_postings")) {return { rows: [{ id: POSTING, company: "Acme", title: "A", created_at: NOW, revision: 1, status: "OPEN", draft_source: "AGENT" }], rowCount: 1 };}
    return empty;
  }));
  assert.equal(at(await readJson(publicList), "data", 0, "draftSource"), undefined);
});

const listRow = (extra: Row) => ({
  id: APP, stage: "APPLIED", applied_at: NOW, display_name: "Bea", headline: null, job_category: null, tenure_years: null, avatar_key: null, ...extra,
});

test("applicant list derives documentKinds from the aggregated documents in one query", async () => {
  resetLimits();
  const seen: Array<Call> = [];
  const res = await handle(get(`/api/v1/postings/${POSTING}/applicants`), env(), deps(authed(seen, async (sql) => {
    if (sql.includes("company_members")) {return { rows: [{ id: POSTING }], rowCount: 1 };}
    if (sql.includes("FROM applications")) {
      return { rows: [
        listRow({ documents: [{ title: "x.pdf", pages: 2, kind: "PDF" }, { title: "프로필", pages: null, kind: "PROFILE" }, { title: "y.zip", pages: null, kind: "FILE" }, { title: "z.pdf", pages: 1, kind: "PDF" }] }),
        listRow({ documents: [{ title: "이력서", pages: null, kind: null }] }),
        listRow({ documents: [] }),
      ], rowCount: 3 };
    }
    return empty;
  })));
  const body = await readJson(res);
  const rows = at(body, "data");
  assert.ok(Array.isArray(rows));
  assert.deepEqual(rows.map((row) => at(row, "documentKinds")), [["PROFILE", "PDF", "FILE"], [], []]);
  const docs = at(rows[0], "documents");
  assert.ok(Array.isArray(docs));
  assert.equal(docs.length, 4);
  const sql = seen.filter((call) => call.sql.includes("FROM applications a"));
  assert.equal(sql.length, 1);
  assert.match(sql[0].sql, /dd\.kind = 'HUB_PROFILE'/);
  assert.match(sql[0].sql, /application\/pdf%/);
});

const detailQuery = (person: Row, files: Array<Row> = []): Deps["query"] => async (sql) => {
  if (sql.includes("company_members") && sql.includes("job_postings")) {return { rows: [{ id: POSTING }], rowCount: 1 };}
  if (sql.includes("application_snapshots")) {return { rows: [{ id: APP, title: "이력서", content: "{}" }], rowCount: 1 };}
  if (sql.includes("FROM application_files")) {return { rows: files, rowCount: files.length };}
  if (sql.includes("FROM applications")) {return { rows: [{ id: APP, user_id: APPLICANT, stage: "APPLIED", revision: 1, applied_at: NOW }], rowCount: 1 };}
  if (sql.includes("FROM users")) {return { rows: [{ display_name: "Bea", email: "bea@push.app", ...person }], rowCount: 1 };}
  return empty;
};

test("applicant detail links the hub profile only when it is public and lists attached files apart from documents", async () => {
  resetLimits();
  const seen: Array<Call> = [];
  const res = await handle(get(`/api/v1/postings/${POSTING}/applicants/${APP}`), env(), deps(authed(seen, detailQuery({ hub_public: true }, [
    { id: POSTING, file_name: "resume.pdf", mime_type: "application/pdf", size: 2048, page_count: 3 },
  ]))));
  const body = await readJson(res);
  assert.equal(at(body, "data", "applicant", "hubProfileId"), APPLICANT);
  assert.deepEqual(at(body, "data", "documents"), [{ id: APP, title: "이력서", content: "{}" }]);
  assert.deepEqual(at(body, "data", "files"), [{ id: POSTING, fileName: "resume.pdf", mimeType: "application/pdf", size: 2048, pageCount: 3 }]);
  const person = seen.find((call) => call.sql.includes("hub_public"));
  assert.ok(person);
  assert.match(person.sql, /COALESCE\(s\.profile_public, true\)/);
  assert.match(person.sql, /deletion_requested_at/);

  resetLimits();
  const hidden = await handle(get(`/api/v1/postings/${POSTING}/applicants/${APP}`), env(), deps(authed([], detailQuery({ hub_public: false }))));
  assert.equal(at(await readJson(hidden), "data", "applicant", "hubProfileId"), null);
});

// One typed boundary for response bodies in this test file.
async function readJson(res: Pick<Response, "json">): Promise<Json> {
  const body: Json = await res.json();
  return body;
}

// Walks a JSON path; undefined when any step is missing.
function at(value: Json | undefined, ...path: Array<string | number>): Json | undefined {
  let cur = value;
  for (const key of path) {
    if (cur === null || typeof cur !== "object") {return undefined;}
    cur = Array.isArray(cur) ? cur[Number(key)] : cur[key];
  }
  return cur;
}
