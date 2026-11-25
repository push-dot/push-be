import assert from "node:assert/strict";
import { test } from "node:test";
import { postJson, recorder } from "../test-support/recorder.ts";

import type { JsonObject } from "../src/json.ts";
import type { QueryResult, Row } from "../src/db.ts";
import { handle } from '../src/handler.ts';
import type { CoreEnv, Deps } from '../src/handler.ts';
import { resetLimits } from "../src/ratelimit.ts";

// Test data comes from JSON bodies and rows; the round trip types it without an assertion.
const viaJson = <T>(value: unknown): T => {
  const out: T = JSON.parse(JSON.stringify(value) ?? "null");
  return out;
};

const readJson = async <T>(res: Response): Promise<T> => {
  const body: T = await res.json();
  return body;
};
const parseJson = <T>(text: string): T => {
  const value: T = JSON.parse(text);
  return value;
};

const USER = "12345678-1234-5678-1234-567812345678";
const COMPANY = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OTHER = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const POSTING = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const APP = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const DOC = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const APPLICANT = "99999999-9999-4999-8999-999999999999";
const JOB = "abababab-abab-4bab-8bab-abababababab";
const NOW = "2026-10-21T00:00:00.000Z";

type Call = { sql: string; params: Array<unknown> };
type Err = { error: { code: string; details: { currentRevision?: unknown } } };

const env = (): CoreEnv => ({ APP_ENV: "production", MANAGED_AI: "1" });

const deps = (query: Deps["query"]): Deps => ({ query, now: () => new Date(NOW) });

const tokenRow = (employer: boolean, plan = "FREE") => ({
  id: USER,
  display_name: "Ada",
  locale: "ko",
  plan,
  subscription_status: "NONE",
  created_at: NOW,
  token_expires_at: "2099-01-01T00:00:00Z",
  is_employer: employer,
});

const authed = (seen: Array<Call>, employer: boolean, extra: Deps["query"], plan = "FREE"): Deps["query"] => async (sql, params = []) => {
  seen.push({ sql, params });
  if (sql.includes("rate_limits")) {return { rows: [{ hits: 1 }], rowCount: 1 };}
  if (sql.includes("access_tokens")) {return { rows: [tokenRow(employer, plan)], rowCount: 1 };}
  if (sql.includes("idempotency_keys") && sql.includes("INSERT")) {
    return { rows: [{ id: "11111111-1111-4111-8111-111111111111" }], rowCount: 1 };
  }
  if (sql.includes("idempotency_keys")) {return { rows: [], rowCount: 0 };}
  if (sql.includes("is_employer") && sql.includes("FROM users") && !sql.includes("access_tokens")) {
    return { rows: [{ is_employer: employer, display_name: "Ada" }], rowCount: 1 };
  }
  if (sql.includes("INSERT INTO ai_jobs")) {return { rows: [{ id: String(params[0]), queue: String(params[2]) }], rowCount: 1 };}
  return extra(sql, params);
};

const empty: QueryResult = { rows: [], rowCount: 0 };

const post = (path: string, body: unknown, key: string): Request => new Request("https://core.example" + path, {
  method: "POST",
  headers: {
    authorization: "Bearer secret-token",
    "content-type": "application/json",
    "idempotency-key": key,
  },
  body: JSON.stringify(body),
});

const patch = (path: string, body: unknown): Request => new Request("https://core.example" + path, {
  method: "PATCH",
  headers: { authorization: "Bearer secret-token", "content-type": "application/json" },
  body: JSON.stringify(body),
});

const postingBody = {
  title: "Backend",
  jobCategory: "dev",
  careerMin: 1,
  careerMax: 3,
  location: "서울 강남구",
  employmentType: "full_time",
  description: "Build APIs",
};

const verified = { id: COMPANY, name: "Acme", verified_at: NOW };

const companyQuery = async (sql: string) => {
  if (sql.includes("company_members") && !sql.includes("access_tokens")) {return { rows: [verified], rowCount: 1 };}
  return empty;
};

const codeOf = async (res: Response) => (await readJson<Err>(res)).error.code;

test("unverified or non-member create is forbidden and does not insert company_user_id", async () => {
  resetLimits();
  const unverifiedSeen: Array<Call> = [];
  const unverified = authed(unverifiedSeen, true, async (sql) => {
    if (sql.includes("company_members") && !sql.includes("access_tokens")) {
      if (sql.includes("verified_at IS NOT NULL")) {return empty;}
      return { rows: [{ id: COMPANY, name: "Acme", verified_at: null }], rowCount: 1 };
    }
    return empty;
  });
  const denied = await handle(post("/api/v1/postings", postingBody, "11111111-1111-4111-8111-111111111111"), env(), deps(unverified));
  assert.equal(denied.status, 403);
  assert.equal(await codeOf(denied), "FORBIDDEN");
  assert.equal(unverifiedSeen.some((call) => call.sql.includes("company_user_id")), false);
  assert.equal(unverifiedSeen.some((call) => call.sql.includes("INSERT INTO job_postings")), false);

  resetLimits();
  const outsiderSeen: Array<Call> = [];
  const outsider = authed(outsiderSeen, true, async (sql) => {
    if (sql.includes("company_members") && !sql.includes("access_tokens")) {return empty;}
    return empty;
  });
  const missing = await handle(post("/api/v1/postings", postingBody, "11111111-1111-4111-8111-111111111112"), env(), deps(outsider));
  assert.equal(missing.status, 403);
  assert.equal(await codeOf(missing), "FORBIDDEN");
  assert.equal(outsiderSeen.some((call) => call.sql.includes("company_user_id")), false);
  assert.equal(outsiderSeen.some((call) => call.sql.includes("INSERT INTO job_postings")), false);
});

test("verified create inserts company_id and defaults the company name", async () => {
  resetLimits();
  const seen: Array<Call> = [];
  const res = await handle(
    post("/api/v1/postings", postingBody, "22222222-2222-4222-8222-222222222222"),
    env(),
    deps(authed(seen, true, companyQuery)),
  );
  assert.equal(res.status, 201);
  const body = await readJson<{ data: { company: string; revision: number; preferred: Array<string>; closedAt: string | null; status: string } }>(res);
  assert.equal(body.data.company, "Acme");
  assert.equal(body.data.revision, 1);
  assert.deepEqual(body.data.preferred, []);
  assert.equal(body.data.closedAt, null);
  assert.equal(body.data.status, "OPEN");
  const insert = seen.find((call) => call.sql.includes("INSERT INTO job_postings"));
  assert.ok(insert);
  assert.match(insert.sql, /company_id/);
  assert.match(insert.sql, /status/);
  assert.doesNotMatch(insert.sql, /company_user_id/);
  assert.equal(insert.params.includes(COMPANY), true);
  assert.equal(insert.params.includes("Acme"), true);
  assert.equal(insert.params.includes("OPEN"), true);
});

test("a stale posting revision is 409 with the current revision", async () => {
  resetLimits();
  const seen: Array<Call> = [];
  const res = await handle(patch(`/api/v1/postings/${POSTING}`, {
    title: "Changed",
    expectedRevision: 1,
  }), env(), deps(authed(seen, true, async (sql) => {
    if (sql.includes("company_members") && !sql.includes("access_tokens")) {return { rows: [verified], rowCount: 1 };}
    if (sql.includes("job_postings")) {return { rows: [{ id: POSTING, revision: 4, company_id: COMPANY, closed_at: null }], rowCount: 1 };}
    return empty;
  })));
  assert.equal(res.status, 409);
  const body = await readJson<Err>(res);
  assert.equal(body.error.code, "REVISION_CONFLICT");
  assert.equal(typeof body.error.details.currentRevision, "number");
  assert.equal(body.error.details.currentRevision, 4);
  assert.equal(seen.some((call) => call.sql.includes("UPDATE") && call.sql.includes("job_postings")), false);
});

test("close sets closed_at and bumps revision", async () => {
  resetLimits();
  const seen: Array<Call> = [];
  const res = await handle(
    post(`/api/v1/postings/${POSTING}/close`, { expectedRevision: 2 }, "33333333-3333-4333-8333-333333333333"),
    env(),
    deps(authed(seen, true, async (sql, params = []) => {
      if (sql.includes("company_members") && !sql.includes("access_tokens")) {return { rows: [verified], rowCount: 1 };}
      if (sql.includes("UPDATE") && sql.includes("job_postings")) {
        assert.equal(params.includes(2), true);
        return { rows: [{ id: POSTING, revision: 3, closed_at: NOW, company: "Acme", title: "Backend" }], rowCount: 1 };
      }
      if (sql.includes("job_postings")) {
        return { rows: [{ id: POSTING, revision: 2, closed_at: null, company_id: COMPANY, company: "Acme", title: "Backend" }], rowCount: 1 };
      }
      return empty;
    })),
  );
  assert.equal(res.status, 200);
  const body = await readJson<{ data: { revision: number; closedAt: string | null } }>(res);
  assert.equal(body.data.revision, 3);
  assert.equal(body.data.closedAt, "2026-10-21T00:00:00Z");
  const update = seen.find((call) => call.sql.includes("UPDATE") && call.sql.includes("job_postings"));
  assert.ok(update);
  assert.match(update.sql, /closed_at/);
  assert.match(update.sql, /revision/);
  assert.match(update.sql, /status/);
  assert.match(update.sql, /CLOSED/);
});

test("closing another company's posting is 404 and an already closed posting is 409", async () => {
  resetLimits();
  const otherSeen: Array<Call> = [];
  const other = await handle(
    post(`/api/v1/postings/${POSTING}/close`, { expectedRevision: 1 }, "33333333-3333-4333-8333-333333333334"),
    env(),
    deps(authed(otherSeen, true, async (sql, params = []) => {
      if (sql.includes("company_members") && !sql.includes("access_tokens")) {return { rows: [verified], rowCount: 1 };}
      if (sql.includes("UPDATE")) {return { rows: [{ id: POSTING, revision: 2, closed_at: NOW }], rowCount: 1 };}
      if (sql.includes("job_postings")) {
        if (params.includes(COMPANY)) {return empty;}
        return { rows: [{ id: POSTING, revision: 1, closed_at: null, company_id: OTHER }], rowCount: 1 };
      }
      return empty;
    })),
  );
  assert.equal(other.status, 404);
  assert.equal(otherSeen.some((call) => call.sql.includes("UPDATE") && call.sql.includes("job_postings")), false);

  resetLimits();
  const closedSeen: Array<Call> = [];
  const closed = await handle(
    post(`/api/v1/postings/${POSTING}/close`, { expectedRevision: 5 }, "33333333-3333-4333-8333-333333333335"),
    env(),
    deps(authed(closedSeen, true, async (sql) => {
      if (sql.includes("company_members") && !sql.includes("access_tokens")) {return { rows: [verified], rowCount: 1 };}
      if (sql.includes("UPDATE")) {return { rows: [{ id: POSTING, revision: 6, closed_at: NOW, company: "Acme" }], rowCount: 1 };}
      if (sql.includes("job_postings")) {return { rows: [{ id: POSTING, revision: 5, closed_at: NOW, company_id: COMPANY }], rowCount: 1 };}
      return empty;
    })),
  );
  assert.equal(closed.status, 409);
  const body = await readJson<Err>(closed);
  assert.equal(body.error.code, "REVISION_CONFLICT");
  assert.equal(body.error.details.currentRevision, 5);
});

test("public list and detail hide closed postings and the company list keeps them", async () => {
  resetLimits();
  const guestSeen: Array<Call> = [];
  const guestQuery: Deps["query"] = async (sql, params = []) => {
    guestSeen.push({ sql, params });
    if (sql.includes("rate_limits")) {return { rows: [{ hits: 1 }], rowCount: 1 };}
    return empty;
  };
  const list = await handle(new Request("https://core.example/api/v1/postings"), env(), deps(guestQuery));
  assert.equal(list.status, 200);
  const listSql = guestSeen.find((call) => call.sql.includes("FROM job_postings") && call.sql.includes("ORDER BY"));
  assert.ok(listSql);
  assert.match(listSql.sql, /closed_at IS NULL/);

  const detail = await handle(new Request(`https://core.example/api/v1/postings/${POSTING}`), env(), deps(guestQuery));
  assert.equal(detail.status, 404);
  const detailSql = guestSeen.find((call) => call.sql.includes("job_postings") && call.sql.includes(POSTING) === false && call.params.includes(POSTING));
  assert.ok(detailSql);
  assert.match(detailSql.sql, /closed_at IS NULL/);

  resetLimits();
  const mineSeen: Array<Call> = [];
  const mine = await handle(
    new Request("https://core.example/api/v1/companies/me/postings", { headers: { authorization: "Bearer secret-token" } }),
    env(),
    deps(authed(mineSeen, true, async (sql) => {
      if (sql.includes("company_members") && !sql.includes("access_tokens")) {return { rows: [{ company_id: COMPANY, id: COMPANY }], rowCount: 1 };}
      if (sql.includes("count(*)")) {return { rows: [{ total: 1 }], rowCount: 1 };}
      return empty;
    })),
  );
  assert.equal(mine.status, 200);
  const mineSql = mineSeen.find((call) => call.sql.includes("FROM job_postings") && call.sql.includes("ORDER BY"));
  assert.ok(mineSql);
  assert.match(mineSql.sql, /company_id/);
  assert.doesNotMatch(mineSql.sql, /closed_at IS NULL/);
  assert.equal(mineSql.params.includes(COMPANY), true);

  resetLimits();
  const noneSeen: Array<Call> = [];
  const none = await handle(
    new Request("https://core.example/api/v1/companies/me/postings", { headers: { authorization: "Bearer secret-token" } }),
    env(),
    deps(authed(noneSeen, false, async () => empty)),
  );
  assert.equal(none.status, 404);
  assert.equal(noneSeen.some((call) => call.sql.includes("company_members") && !call.sql.includes("access_tokens")), true);
  assert.equal(noneSeen.some((call) => call.sql.includes("FROM job_postings")), false);
});

test("apply snapshots document json and a second apply does not snapshot again", async () => {
  resetLimits();
  const seen: Array<Call> = [];
  let applied = false;
  const query = authed(seen, false, async (sql) => {
    if (sql.includes("job_postings") && sql.includes("closed_at IS NULL") && !sql.includes("INSERT")) {
      return { rows: [{ company: "Acme", title: "Backend", description: "Build APIs", requirements: [], deadline: null }], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO applications")) {
      applied = true;
      return { rows: [{ id: APP }], rowCount: 1 };
    }
    if (sql.includes("document_versions") || (sql.includes("FROM documents") && sql.includes("content"))) {
      return { rows: [{ id: DOC, title: "Resume", content: { summary: "hi" } }], rowCount: 1 };
    }
    if (sql.includes("FROM documents")) {return { rows: [{ id: DOC, title: "Resume" }], rowCount: 1 };}
    if (sql.includes("applications") && sql.includes("source_posting_id") && !sql.includes("INSERT")) {
      if (!applied) {return empty;}
      return { rows: [{ id: APP, revision: 1, job_id: JOB, company: "Acme", title: "Backend", stage: "APPLIED", notes: "", applied_at: NOW, next_action_at: null, imported: false, created_at: NOW, updated_at: NOW }], rowCount: 1 };
    }
    if (sql.includes("FROM job_postings")) {
      return { rows: [{ company: "Acme", title: "Backend", description: "Build APIs", requirements: [], deadline: null }], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO applications")) {applied = true;}
    if (sql.includes("INSERT INTO ai_jobs")) {return { rows: [{ id: "00000000-0000-4000-8000-000000000099", queue: "q:ingest" }], rowCount: 1 };}
    return empty;
  });
  const first = await handle(
    post(`/api/v1/postings/${POSTING}/apply`, { documentIds: [DOC] }, "44444444-4444-4444-8444-444444444444"),
    env(),
    deps(query),
  );
  assert.equal(first.status, 201);
  const created = await readJson<{ data: { id: string; fitScore: null } }>(first);
  assert.equal(created.data.fitScore, null);
  const snapshot = seen.find((call) => call.sql.includes("INSERT INTO application_snapshots"));
  assert.ok(snapshot);
  const wrote = seen.find((call) => call.sql.includes("INSERT INTO applications"));
  assert.match(wrote!.sql, /applicant_snapshot/);
  assert.match(wrote!.sql, /'headline', p\.headline/);
  assert.match(wrote!.sql, /'jobCategory', p\.job_category/);
  assert.match(wrote!.sql, /'tenureYears', p\.tenure_years/);
  assert.match(wrote!.sql, /'capturedAt', \$9::timestamptz/);
  const snapshots = parseJson<Array<{ document_id: string; content: string }>>(String(snapshot.params[13]));
  assert.deepEqual(snapshots, [{ document_id: DOC, title: "Resume", content: JSON.stringify({ summary: "hi" }) }]);
  const second = await handle(
    post(`/api/v1/postings/${POSTING}/apply`, { documentIds: [DOC] }, "44444444-4444-4444-8444-444444444445"),
    env(),
    deps(query),
  );
  assert.equal(second.status, 201);
  const again = await readJson<{ data: { id: string } }>(second);
  assert.equal(again.data.id, APP);
  assert.equal(seen.filter((call) => call.sql.includes("INSERT INTO application_snapshots")).length, 1);
});

test("an employer cannot apply", async () => {
  resetLimits();
  const seen: Array<Call> = [];
  const res = await handle(
    post(`/api/v1/postings/${POSTING}/apply`, { documentIds: [DOC] }, "55555555-5555-4555-8555-555555555555"),
    env(),
    deps(authed(seen, true, async (sql) => {
      if (sql.includes("job_postings") && sql.includes("closed_at IS NULL")) {return { rows: [{ id: POSTING }], rowCount: 1 };}
      if (sql.includes("FROM documents")) {return { rows: [{ id: DOC }], rowCount: 1 };}
      if (sql.includes("FROM job_postings")) {return { rows: [{ company: "Acme", title: "Backend", description: "d", requirements: [], deadline: null }], rowCount: 1 };}
      return empty;
    })),
  );
  assert.equal(res.status, 403);
  assert.equal(await codeOf(res), "FORBIDDEN");
  assert.equal(seen.some((call) => call.sql.includes("INSERT INTO application_snapshots")), false);
  assert.equal(seen.some((call) => call.sql.includes("INSERT INTO applications")), false);
});

const applicationRow = (stage: string) => ({
  id: APP,
  user_id: APPLICANT,
  revision: 1,
  job_id: JOB,
  company: "Acme",
  title: "Backend",
  stage,
  notes: "",
  applied_at: NOW,
  next_action_at: null,
  imported: false,
  created_at: NOW,
  updated_at: NOW,
  fit_score: null,
});

const memberPosting = async (sql: string) => {
  if (sql.includes("company_members") && !sql.includes("access_tokens") && !sql.includes("applications")) {
    return { rows: [{ id: POSTING, company_id: COMPANY }], rowCount: 1 };
  }
  return null;
};

test("a stage jump to OFFER notifies the applicant", async () => {
  resetLimits();
  const seen: Array<Call> = [];
  const res = await handle(patch(`/api/v1/postings/${POSTING}/applicants/${APP}`, { stage: "OFFER" }), env(), deps(authed(seen, true, async (sql) => {
    const member = await memberPosting(sql);
    if (member) {return member;}
    if (sql.includes("UPDATE") && sql.includes("applications")) {
      return { rows: [{ ...applicationRow("OFFER"), revision: 2 }], rowCount: 1 };
    }
    if (sql.includes("applications")) {return { rows: [applicationRow("APPLIED")], rowCount: 1 };}
    if (sql.includes("user_settings")) {return empty;}
    return empty;
  })));
  assert.equal(res.status, 200);
  const body = await readJson<{ data: { stage: string; revision: number } }>(res);
  assert.equal(body.data.stage, "OFFER");
  assert.equal(body.data.revision, 2);
  const note = seen.find((call) => call.sql.includes("INSERT INTO notifications"));
  assert.ok(note);
  assert.equal(note.params.includes("APPLICATION_STAGE"), true);
  assert.equal(note.params.includes("지원 상태가 바뀌었어요"), true);
  assert.equal(note.params.includes(APPLICANT), true);
  assert.equal(note.params.some((param) => typeof param === "string" && param.includes("\"kind\":\"activity\"") && param.includes(APP)), true);
  const update = seen.find((call) => call.sql.includes("UPDATE") && call.sql.includes("applications"));
  assert.ok(update);
  assert.match(update.sql, /revision/);
  assert.equal(update.params.includes("OFFER"), true);
});

test("employer stage update falls back when stage_entered_at is missing", async () => {
  resetLimits();
  const seen: Array<Call> = [];
  const missing = Object.assign(new Error('column "stage_entered_at" of relation "applications" does not exist'), { code: "42703" });
  const res = await handle(patch(`/api/v1/postings/${POSTING}/applicants/${APP}`, { stage: "OFFER" }), env(), deps(authed(seen, true, async (sql) => {
    const member = await memberPosting(sql);
    if (member) {return member;}
    if (sql.includes("UPDATE") && sql.includes("stage_entered_at")) {throw missing;}
    if (sql.includes("UPDATE") && sql.includes("applications")) {
      return { rows: [{ ...applicationRow("OFFER"), revision: 2 }], rowCount: 1 };
    }
    if (sql.includes("applications")) {return { rows: [applicationRow("APPLIED")], rowCount: 1 };}
    if (sql.includes("user_settings")) {return empty;}
    return empty;
  })));
  assert.equal(res.status, 200);
  const body = await readJson<{ data: { stage: string; revision: number } }>(res);
  assert.equal(body.data.stage, "OFFER");
  assert.equal(body.data.revision, 2);
  const updates = seen.filter((call) => call.sql.includes("UPDATE") && call.sql.includes("applications"));
  assert.equal(updates.length, 2);
  assert.match(updates[0].sql, /stage_entered_at/);
  assert.match(updates[1].sql, /^UPDATE/);
  assert.equal(updates[1].sql.includes("stage_entered_at"), false);
});

test("application stage notifications respect the settings switch", async () => {
  resetLimits();
  const seen: Array<Call> = [];
  const res = await handle(patch(`/api/v1/postings/${POSTING}/applicants/${APP}`, { stage: "OFFER" }), env(), deps(authed(seen, true, async (sql) => {
    const member = await memberPosting(sql);
    if (member) {return member;}
    if (sql.includes("UPDATE") && sql.includes("applications")) {return { rows: [applicationRow("OFFER")], rowCount: 1 };}
    if (sql.includes("applications")) {return { rows: [applicationRow("APPLIED")], rowCount: 1 };}
    if (sql.includes("user_settings")) {return { rows: [{ enabled: false, notify_application_stage: false }], rowCount: 1 };}
    return empty;
  })));
  assert.equal(res.status, 200);
  assert.equal(seen.some((call) => call.sql.includes("INSERT INTO notifications")), false);
});

test("a terminal applicant stage cannot move to OFFER", async () => {
  resetLimits();
  const seen: Array<Call> = [];
  const res = await handle(patch(`/api/v1/postings/${POSTING}/applicants/${APP}`, { stage: "OFFER" }), env(), deps(authed(seen, true, async (sql) => {
    const member = await memberPosting(sql);
    if (member) {return member;}
    if (sql.includes("UPDATE") && sql.includes("applications")) {return { rows: [applicationRow("OFFER")], rowCount: 1 };}
    if (sql.includes("applications")) {return { rows: [applicationRow("REJECTED")], rowCount: 1 };}
    return empty;
  })));
  assert.equal(res.status, 409);
  assert.equal(await codeOf(res), "INVALID_TRANSITION");
  assert.equal(seen.some((call) => call.sql.includes("UPDATE") && call.sql.includes("applications")), false);
  assert.equal(seen.some((call) => call.sql.includes("INSERT INTO notifications")), false);
});

test("applicant detail returns the snapshot documents and never the applicant's own tracking", async () => {
  resetLimits();
  const seen: Array<Call> = [];
  const res = await handle(
    new Request(`https://core.example/api/v1/postings/${POSTING}/applicants/${APP}`, { headers: { authorization: "Bearer secret-token" } }),
    env(),
    deps(authed(seen, true, async (sql) => {
      const member = await memberPosting(sql);
      if (member) {return member;}
      if (sql.includes("application_snapshots")) {
        return { rows: [{ id: DOC, title: "Resume", content: "{\"summary\":\"hi\"}" }], rowCount: 1 };
      }
      if (sql.includes("applications")) {return { rows: [{ ...applicationRow("OFFER"), fit_score: 80 }], rowCount: 1 };}
      return empty;
    })),
  );
  assert.equal(res.status, 200);
  const body = await readJson<{ data: { application: { id: string; fitScore?: number; nextActionAt?: string }; documents: Array<{ id: string; title: string; content: string }> } }>(res);
  assert.equal("fitScore" in body.data.application, false, "the applicant's own fit score stays theirs");
  assert.equal("nextActionAt" in body.data.application, false, "the applicant's own next step stays theirs");
  assert.deepEqual(body.data.documents, [{ id: DOC, title: "Resume", content: "{\"summary\":\"hi\"}" }]);
  const appSql = seen.find((call) => call.sql.includes("applications") && call.sql.includes("fit_score"));
  assert.ok(appSql);
  assert.match(appSql.sql, /gap_analyses/);
});

const settingsRow = (notify: boolean, days: number | null) => ({
  notify_deadline: true,
  notify_offer: true,
  notify_comment: true,
  notify_ai_done: true,
  notify_application_stage: notify,
  locale: "ko",
  profile_public: true,
  career_status_visibility: "everyone",
  hide_from_current_company: false,
  contact_visibility: "accepted",
  default_tone: "as_is",
  chat_retention_days: days,
  allow_ai_read_my_files: true,
});

test("settings store notifyApplicationStage and ignore retired retention", async () => {
  resetLimits();
  const notifySeen: Array<Call> = [];
  let notify = true;
  const days: number | null = 7;
  const notifyRes = await handle(patch("/api/v1/me/settings", { notifyApplicationStage: false }), env(), deps(authed(notifySeen, false, async (sql, params = []) => {
    if (sql.includes("UPDATE user_settings")) {
      const stage = /notify_application_stage = \$(\d+)/.exec(sql);
      if (stage) {notify = Boolean(params[Number(stage[1]) - 1]);}
      return empty;
    }
    if (sql.includes("user_settings") || sql.includes("FROM users")) {return { rows: [settingsRow(notify, days)], rowCount: 1 };}
    return empty;
  })));
  assert.equal(notifyRes.status, 200);
  const notifyBody = await readJson<{ data: { notifyApplicationStage: boolean } }>(notifyRes);
  assert.equal(notifyBody.data.notifyApplicationStage, false);
  const update = notifySeen.find((call) => call.sql.includes("UPDATE user_settings"));
  assert.ok(update);
  assert.match(update.sql, /notify_application_stage/);

  resetLimits();
  const daysSeen: Array<Call> = [];
  let stored: number | null = 7;
  const daysRes = await handle(patch("/api/v1/me/settings", { chatRetentionDays: null }), env(), deps(authed(daysSeen, false, async (sql, params = []) => {
    if (sql.includes("UPDATE user_settings")) {
      const mark = /chat_retention_days = \$(\d+)/.exec(sql);
      if (mark) {stored = viaJson<number | null>(params[Number(mark[1]) - 1]);}
      return empty;
    }
    if (sql.includes("user_settings") || sql.includes("FROM users")) {return { rows: [settingsRow(true, stored)], rowCount: 1 };}
    return empty;
  }, "FREE")));
  assert.equal(daysRes.status, 200);
  const daysBody = await readJson<{ data: JsonObject }>(daysRes);
  assert.equal("chatRetentionDays" in daysBody.data, false);
  assert.equal(stored, 7);
  const daysUpdate = daysSeen.find((call) => call.sql.includes("UPDATE user_settings"));
  assert.ok(daysUpdate);
  assert.doesNotMatch(daysUpdate.sql, /chat_retention_days/);
});

test("a post author includes employer and company name", async () => {
  resetLimits();
  const seen: Array<Call> = [];
  const res = await handle(
    new Request("https://core.example/api/v1/posts/" + POSTING, { headers: { authorization: "Bearer secret-token" } }),
    env(),
    deps(authed(seen, false, async (sql) => {
      if (sql.includes("UPDATE posts")) {return { rows: [{ id: POSTING }], rowCount: 1 };}
      if (sql.includes("FROM posts")) {
        return {
          rows: [{
            id: POSTING,
            user_id: USER,
            display_name: "Ada",
            is_employer: true,
            company_name: "Acme",
            category: "work",
            title: "Hi",
            body: "There",
            image_keys: [],
            view_count: 1,
            comment_count: 0,
            created_at: NOW,
          }],
          rowCount: 1,
        };
      }
      return empty;
    })),
  );
  assert.equal(res.status, 200);
  const body = await readJson<{ data: { author: { displayName: string; employer: boolean; companyName: string | null } } }>(res);
  assert.equal(body.data.author.displayName, "Ada");
  assert.equal(body.data.author.employer, true);
  assert.equal(body.data.author.companyName, "Acme");
  const select = seen.find((call) => call.sql.includes("FROM posts") && call.sql.includes("is_employer"));
  assert.ok(select);
  assert.match(select.sql, /companies/);
});

test("a company member can read a closed posting and another user cannot", async () => {
  resetLimits();
  const memberSeen: Array<Call> = [];
  const member = await handle(
    new Request(`https://core.example/api/v1/postings/${POSTING}`, { headers: { authorization: "Bearer secret-token" } }),
    env(),
    deps(authed(memberSeen, true, async (sql) => {
      if (sql.includes("FROM job_postings") && sql.includes("company_members")) {
        return { rows: [{ id: POSTING }], rowCount: 1 };
      }
      if (sql.includes("FROM job_postings") && sql.includes("closed_at IS NULL")) {return empty;}
      if (sql.includes("FROM job_postings")) {
        return {
          rows: [{
            id: POSTING,
            company: "Acme",
            title: "Backend",
            description: "Build APIs",
            revision: 2,
            preferred: [],
            closed_at: NOW,
          }],
          rowCount: 1,
        };
      }
      return empty;
    })),
  );
  assert.equal(member.status, 200);
  const body = await readJson<{ data: { description: string; closedAt: string | null } }>(member);
  assert.equal(body.data.description, "Build APIs");
  assert.equal(body.data.closedAt, "2026-10-21T00:00:00Z");

  resetLimits();
  const otherSeen: Array<Call> = [];
  const other = await handle(
    new Request(`https://core.example/api/v1/postings/${POSTING}`, { headers: { authorization: "Bearer secret-token" } }),
    env(),
    deps(authed(otherSeen, false, async (sql) => {
      if (sql.includes("FROM job_postings") && sql.includes("closed_at IS NULL")) {return empty;}
      if (sql.includes("company_members")) {return empty;}
      if (sql.includes("FROM job_postings")) {
        return { rows: [{ id: POSTING, description: "Build APIs", closed_at: NOW }], rowCount: 1 };
      }
      return empty;
    })),
  );
  assert.equal(other.status, 404);
  assert.equal(otherSeen.some((call) => call.sql.includes("FROM job_postings") && !call.sql.includes("closed_at IS NULL") && !call.sql.includes("company_members")), false);
});

test("repeating REJECTED returns the row without a notification", async () => {
  resetLimits();
  const seen: Array<Call> = [];
  const res = await handle(patch(`/api/v1/postings/${POSTING}/applicants/${APP}`, { stage: "REJECTED" }), env(), deps(authed(seen, true, async (sql) => {
    const member = await memberPosting(sql);
    if (member) {return member;}
    if (sql.includes("UPDATE") && sql.includes("applications")) {return { rows: [{ ...applicationRow("REJECTED"), revision: 2 }], rowCount: 1 };}
    if (sql.includes("applications")) {return { rows: [applicationRow("REJECTED")], rowCount: 1 };}
    return empty;
  })));
  assert.equal(res.status, 200);
  const body = await readJson<{ data: { stage: string; revision: number } }>(res);
  assert.equal(body.data.stage, "REJECTED");
  assert.equal(body.data.revision, 1);
  assert.equal(seen.some((call) => call.sql.includes("UPDATE") && call.sql.includes("applications")), false);
  assert.equal(seen.some((call) => call.sql.includes("INSERT INTO notifications")), false);
});

const deferred = () => {
  let settle: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => { settle = resolve; });
  return { promise, resolve: () => { settle?.(); } };
};

const asksOpen = (sql: string) => /p\.status = 'OPEN'|status = 'OPEN'/.test(sql);

const missingRelation = (code: string, message: string): Error => {
  return Object.assign(new Error(message), { code });
};

test("a post still loads before company tables exist", async () => {
  resetLimits();
  const seen: Array<Call> = [];
  const res = await handle(
    new Request("https://core.example/api/v1/posts/" + POSTING, { headers: { authorization: "Bearer secret-token" } }),
    env(),
    deps(authed(seen, false, async (sql) => {
      if (sql.includes("company_members") || sql.includes("companies")) {
        throw missingRelation("42P01", "relation \"company_members\" does not exist");
      }
      if (sql.includes("UPDATE posts")) {return { rows: [{ id: POSTING }], rowCount: 1 };}
      if (sql.includes("FROM posts")) {
        return {
          rows: [{
            id: POSTING,
            user_id: USER,
            display_name: "Ada",
            is_employer: false,
            company_name: null,
            category: "work",
            title: "Hi",
            body: "There",
            image_keys: [],
            view_count: 1,
            comment_count: 0,
            created_at: NOW,
          }],
          rowCount: 1,
        };
      }
      return empty;
    })),
  );
  assert.equal(res.status, 200);
  const body = await readJson<{ data: { author: { employer: boolean; companyName: string | null } } }>(res);
  assert.equal(body.data.author.employer, false);
  assert.equal(body.data.author.companyName, null);
  assert.equal(seen.some((call) => call.sql.includes("FROM posts") && !call.sql.includes("company_members")), true);
});

test("settings still load before notify_application_stage exists", async () => {
  resetLimits();
  const res = await handle(
    new Request("https://core.example/api/v1/me/settings", { headers: { authorization: "Bearer secret-token" } }),
    env(),
    deps(authed([], false, async (sql) => {
      if (sql.includes("notify_application_stage")) {
        throw missingRelation("42703", "column \"notify_application_stage\" does not exist");
      }
      if (sql.includes("INSERT INTO user_settings")) {return empty;}
      if (sql.includes("user_settings")) {return { rows: [settingsRow(true, null)], rowCount: 1 };}
      return empty;
    })),
  );
  assert.equal(res.status, 200);
  const body = await readJson<{ data: { notifyApplicationStage: boolean } }>(res);
  assert.equal(body.data.notifyApplicationStage, true);
  assert.equal("chatRetentionDays" in body.data, false);
});

test("create DRAFT stores status and CLOSED on create is 400", async () => {
  resetLimits();
  const seen: Array<Call> = [];
  const res = await handle(
    post("/api/v1/postings", { ...postingBody, status: "DRAFT" }, "66666666-6666-4666-8666-666666666661"),
    env(),
    deps(authed(seen, true, companyQuery)),
  );
  assert.equal(res.status, 201);
  const body = await readJson<{ data: { status: string; closedAt: string | null } }>(res);
  assert.equal(body.data.status, "DRAFT");
  assert.equal(body.data.closedAt, null);
  const insert = seen.find((call) => call.sql.includes("INSERT INTO job_postings"));
  assert.ok(insert);
  assert.match(insert.sql, /status/);
  assert.equal(insert.params.includes("DRAFT"), true);
  assert.match(insert.sql, /NULL/);

  resetLimits();
  const closedSeen: Array<Call> = [];
  const closed = await handle(
    post("/api/v1/postings", { ...postingBody, status: "CLOSED" }, "66666666-6666-4666-8666-666666666662"),
    env(),
    deps(authed(closedSeen, true, companyQuery)),
  );
  assert.equal(closed.status, 400);
  assert.equal(await codeOf(closed), "VALIDATION_ERROR");
  assert.equal(closedSeen.some((call) => call.sql.includes("INSERT INTO job_postings")), false);
});

test("guest list requires open status and does not return a draft", async () => {
  resetLimits();
  const seen: Array<Call> = [];
  const draft = {
    id: POSTING,
    company: "Acme",
    title: "Secret draft",
    status: "DRAFT",
    closed_at: null,
    created_at: NOW,
    revision: 1,
  };
  const res = await handle(new Request("https://core.example/api/v1/postings"), env(), deps(async (sql, params = []) => {
    seen.push({ sql, params });
    if (sql.includes("rate_limits")) {return { rows: [{ hits: 1 }], rowCount: 1 };}
    if (sql.includes("ORDER BY") && sql.includes("job_postings")) {
      return { rows: asksOpen(sql) ? [] : [draft], rowCount: asksOpen(sql) ? 0 : 1 };
    }
    if (sql.includes("job_postings") && sql.includes("count(*)")) {
      return { rows: [{ total: asksOpen(sql) ? 0 : 1 }], rowCount: 1 };
    }
    return empty;
  }));
  assert.equal(res.status, 200);
  const body = await readJson<{ data: Array<{ title?: string }> }>(res);
  assert.equal(body.data.some((item) => item.title === "Secret draft"), false);
  const listSql = seen.find((call) => call.sql.includes("FROM job_postings") && call.sql.includes("ORDER BY"));
  assert.ok(listSql);
  assert.match(listSql.sql, /status = 'OPEN'/);
  assert.match(listSql.sql, /closed_at IS NULL/);
});

test("company applicant detail and stage update omit private notes", async () => {
  resetLimits();
  const noted = { ...applicationRow("APPLIED"), notes: "salary floor" };
  const detail = await handle(
    new Request(`https://core.example/api/v1/postings/${POSTING}/applicants/${APP}`, { headers: { authorization: "Bearer secret-token" } }),
    env(),
    deps(authed([], true, async (sql) => {
      const member = await memberPosting(sql);
      if (member) {return member;}
      if (sql.includes("application_snapshots")) {return empty;}
      if (sql.includes("applications")) {return { rows: [noted], rowCount: 1 };}
      return empty;
    })),
  );
  assert.equal(detail.status, 200);
  const detailBody = await readJson<{ data: { application: JsonObject } }>(detail);
  assert.equal(Object.hasOwn(detailBody.data.application, "notes"), false);
  assert.equal(detailBody.data.application.stage, "APPLIED");

  resetLimits();
  const moved = await handle(
    patch(`/api/v1/postings/${POSTING}/applicants/${APP}`, { stage: "SCREENING" }),
    env(),
    deps(authed([], true, async (sql) => {
      const member = await memberPosting(sql);
      if (member) {return member;}
      if (sql.includes("UPDATE") && sql.includes("applications")) {return { rows: [{ ...noted, stage: "SCREENING", revision: 2 }], rowCount: 1 };}
      if (sql.includes("applications")) {return { rows: [noted], rowCount: 1 };}
      if (sql.includes("user_settings")) {return empty;}
      return empty;
    })),
  );
  assert.equal(moved.status, 200);
  const movedBody = await readJson<{ data: JsonObject }>(moved);
  assert.equal(Object.hasOwn(movedBody.data, "notes"), false);
  assert.equal(movedBody.data.stage, "SCREENING");
});

const hubProfile = {
  user_id: OTHER,
  display_name: "Bea",
  avatar_key: null,
  headline: "Backend",
  job_category: "dev",
  tenure_years: 4,
  career_status: "seeking",
  open_to_offers: true,
  intro: "hi",
  careers: [{ company: "Acme", role: "Eng" }],
  skills: ["ts"],
  resume_source_id: null,
  updated_at: NOW,
  career_status_visibility: "everyone",
  profile_public: true,
  following: false,
  follower_count: 1,
  hide_from_current_company: true,
  email_domain: "acme.com",
  offered: false,
};

const profileQuery = (viewerEmail: string): Deps["query"] => async (sql) => {
  if (sql.includes("SELECT email FROM users")) {return { rows: [{ email: viewerEmail }], rowCount: 1 };}
  if (sql.includes("FROM profiles")) {return { rows: [hubProfile], rowCount: 1 };}
  return empty;
};

test("same-company viewers still see the profile but not career status", async () => {
  resetLimits();
  const listSeen: Array<Call> = [];
  const list = await handle(
    new Request("https://core.example/api/v1/profiles", { headers: { authorization: "Bearer secret-token" } }),
    env(),
    deps(authed(listSeen, false, profileQuery("ada@acme.com"))),
  );
  assert.equal(list.status, 200);
  const listBody = await readJson<{ data: Array<{ headline: string; careerStatus: string | null; careers: Array<unknown> }> }>(list);
  assert.equal(listBody.data.length, 1);
  assert.equal(listBody.data[0].headline, "Backend");
  assert.equal(listBody.data[0].careers.length, 1);
  assert.equal(listBody.data[0].careerStatus, null);
  const listSql = listSeen.find((call) => call.sql.includes("FROM profiles"));
  assert.ok(listSql);
  assert.doesNotMatch(listSql.sql, /NOT \(\s*COALESCE\(s\.hide_from_current_company/);

  resetLimits();
  const statusSeen: Array<Call> = [];
  const filtered = await handle(
    new Request("https://core.example/api/v1/profiles?status=seeking", { headers: { authorization: "Bearer secret-token" } }),
    env(),
    deps(authed(statusSeen, false, profileQuery("ada@acme.com"))),
  );
  assert.equal(filtered.status, 200);
  const statusSql = statusSeen.find((call) => call.sql.includes("FROM profiles") && call.sql.includes("career_status"));
  assert.ok(statusSql);
  assert.match(statusSql.sql, /NOT \(\s*COALESCE\(s\.hide_from_current_company/);

  resetLimits();
  const search = await handle(
    new Request("https://core.example/api/v1/search?type=people&q=bea", { headers: { authorization: "Bearer secret-token" } }),
    env(),
    deps(authed([], false, profileQuery("ada@acme.com"))),
  );
  assert.equal(search.status, 200);
  const searchBody = await readJson<{ data: Array<{ careerStatus: string | null; headline: string }> }>(search);
  assert.equal(searchBody.data[0].headline, "Backend");
  assert.equal(searchBody.data[0].careerStatus, null);

  resetLimits();
  const detail = await handle(
    new Request(`https://core.example/api/v1/profiles/${OTHER}`, { headers: { authorization: "Bearer secret-token" } }),
    env(),
    deps(authed([], false, profileQuery("ada@acme.com"))),
  );
  assert.equal(detail.status, 200);
  const detailBody = await readJson<{ data: { careerStatus: string | null; headline: string; skills: Array<string> } }>(detail);
  assert.equal(detailBody.data.headline, "Backend");
  assert.deepEqual(detailBody.data.skills, ["ts"]);
  assert.equal(detailBody.data.careerStatus, null);

  resetLimits();
  const otherCompany = await handle(
    new Request(`https://core.example/api/v1/profiles/${OTHER}`, { headers: { authorization: "Bearer secret-token" } }),
    env(),
    deps(authed([], false, profileQuery("ada@beta.com"))),
  );
  assert.equal(otherCompany.status, 200);
  const otherBody = await readJson<{ data: { careerStatus: string | null } }>(otherCompany);
  assert.equal(otherBody.data.careerStatus, "seeking");

  resetLimits();
  const gmail = await handle(
    new Request(`https://core.example/api/v1/profiles/${OTHER}`, { headers: { authorization: "Bearer secret-token" } }),
    env(),
    deps(authed([], false, async (sql) => {
      if (sql.includes("SELECT email FROM users")) {return { rows: [{ email: "ada@gmail.com" }], rowCount: 1 };}
      if (sql.includes("FROM profiles")) {return { rows: [{ ...hubProfile, email_domain: "gmail.com" }], rowCount: 1 };}
      return empty;
    })),
  );
  assert.equal(gmail.status, 200);
  const gmailBody = await readJson<{ data: { careerStatus: string | null } }>(gmail);
  assert.equal(gmailBody.data.careerStatus, "seeking");
});

test("company list status=DRAFT filters drafts and includes applicantCount", async () => {
  resetLimits();
  const seen: Array<Call> = [];
  const res = await handle(
    new Request("https://core.example/api/v1/companies/me/postings?status=DRAFT", { headers: { authorization: "Bearer secret-token" } }),
    env(),
    deps(authed(seen, true, async (sql) => {
      if (sql.includes("company_members") && !sql.includes("access_tokens")) {return { rows: [{ company_id: COMPANY }], rowCount: 1 };}
      if (sql.includes("ORDER BY") && sql.includes("job_postings")) {
        return {
          rows: [{
            id: POSTING,
            company: "Acme",
            title: "Secret draft",
            status: "DRAFT",
            applicant_count: 4,
            closed_at: null,
            created_at: NOW,
            revision: 1,
          }],
          rowCount: 1,
        };
      }
      if (sql.includes("count(*)")) {return { rows: [{ total: 1 }], rowCount: 1 };}
      return empty;
    })),
  );
  assert.equal(res.status, 200);
  const body = await readJson<{ data: Array<{ status: string; applicantCount: number }> }>(res);
  assert.equal(body.data[0].status, "DRAFT");
  assert.equal(body.data[0].applicantCount, 4);
  const listSql = seen.find((call) => call.sql.includes("FROM job_postings") && call.sql.includes("ORDER BY"));
  assert.ok(listSql);
  assert.match(listSql.sql, /status/);
  assert.equal(listSql.params.includes("DRAFT"), true);

  resetLimits();
  const bad = await handle(
    new Request("https://core.example/api/v1/companies/me/postings?status=NOPE", { headers: { authorization: "Bearer secret-token" } }),
    env(),
    deps(authed([], true, async (sql) => {
      if (sql.includes("company_members") && !sql.includes("access_tokens")) {return { rows: [{ company_id: COMPANY }], rowCount: 1 };}
      return empty;
    })),
  );
  assert.equal(bad.status, 422);
  assert.equal(await codeOf(bad), "VALIDATION_ERROR");
});

test("member detail includes applicantCount and a non-member detail does not", async () => {
  resetLimits();
  const member = await handle(
    new Request(`https://core.example/api/v1/postings/${POSTING}`, { headers: { authorization: "Bearer secret-token" } }),
    env(),
    deps(authed([], true, async (sql) => {
      if (sql.includes("company_members") && sql.includes("job_postings")) {return { rows: [{ id: POSTING }], rowCount: 1 };}
      if (/p\.status = 'OPEN'|status = 'OPEN'/.test(sql)) {return empty;}
      if (sql.includes("FROM job_postings")) {
        return {
          rows: [{
            id: POSTING,
            company: "Acme",
            title: "Secret draft",
            description: "Hidden",
            status: "DRAFT",
            applicant_count: 2,
            revision: 1,
            closed_at: null,
            created_at: NOW,
          }],
          rowCount: 1,
        };
      }
      return empty;
    })),
  );
  assert.equal(member.status, 200);
  const memberBody = await readJson<{ data: { status: string; applicantCount: number; description: string } }>(member);
  assert.equal(memberBody.data.status, "DRAFT");
  assert.equal(memberBody.data.applicantCount, 2);
  assert.equal(memberBody.data.description, "Hidden");

  resetLimits();
  const outsider = await handle(
    new Request(`https://core.example/api/v1/postings/${POSTING}`, { headers: { authorization: "Bearer secret-token" } }),
    env(),
    deps(authed([], false, async (sql) => {
      if (sql.includes("company_members") && !sql.includes("access_tokens")) {return empty;}
      if (sql.includes("FROM job_postings") && sql.includes("closed_at IS NULL")) {
        return {
          rows: [{
            id: POSTING,
            company: "Acme",
            title: "Backend",
            description: "Build APIs",
            status: "OPEN",
            applicant_count: 9,
            revision: 1,
            closed_at: null,
            created_at: NOW,
          }],
          rowCount: 1,
        };
      }
      return empty;
    })),
  );
  assert.equal(outsider.status, 200);
  const outsiderBody = await readJson<{ data: { applicantCount?: number; description: string } }>(outsider);
  assert.equal(outsiderBody.data.description, "Build APIs");
  assert.equal(outsiderBody.data.applicantCount, 9);

  resetLimits();
  const guest = await handle(new Request(`https://core.example/api/v1/postings/${POSTING}`), env(), deps(async (sql) => {
    if (sql.includes("rate_limits")) {return { rows: [{ hits: 1 }], rowCount: 1 };}
    if (/p\.status = 'OPEN'|status = 'OPEN'/.test(sql)) {return empty;}
    if (sql.includes("job_postings")) {
      return { rows: [{ id: POSTING, title: "Secret draft", status: "DRAFT", description: "Hidden", closed_at: null }], rowCount: 1 };
    }
    return empty;
  }));
  assert.equal(guest.status, 404);
});

test("patch may set DRAFT and must not set CLOSED", async () => {
  resetLimits();
  const seen: Array<Call> = [];
  const res = await handle(patch(`/api/v1/postings/${POSTING}`, {
    status: "DRAFT",
    expectedRevision: 1,
  }), env(), deps(authed(seen, true, async (sql, params = []) => {
    if (sql.includes("company_members") && !sql.includes("access_tokens")) {return { rows: [verified], rowCount: 1 };}
    if (sql.includes("UPDATE") && sql.includes("job_postings")) {
      assert.equal(params.includes("DRAFT"), true);
      return { rows: [{ id: POSTING, revision: 2, status: "DRAFT", company: "Acme", title: "Backend", closed_at: null }], rowCount: 1 };
    }
    if (sql.includes("job_postings")) {
      return {
        rows: [{
          id: POSTING,
          revision: 1,
          status: "OPEN",
          company_id: COMPANY,
          company: "Acme",
          title: "Backend",
          job_category: "dev",
          career_min: 1,
          career_max: 3,
          location: "서울 강남구",
          employment_type: "full_time",
          description: "Build APIs",
          closed_at: null,
        }],
        rowCount: 1,
      };
    }
    return empty;
  })));
  assert.equal(res.status, 200);
  const body = await readJson<{ data: { status: string; revision: number } }>(res);
  assert.equal(body.data.status, "DRAFT");
  assert.equal(body.data.revision, 2);
  const update = seen.find((call) => call.sql.includes("UPDATE") && call.sql.includes("job_postings"));
  assert.ok(update);
  assert.match(update.sql, /status/);

  resetLimits();
  const closedSeen: Array<Call> = [];
  const closed = await handle(patch(`/api/v1/postings/${POSTING}`, {
    status: "CLOSED",
    expectedRevision: 1,
  }), env(), deps(authed(closedSeen, true, async () => empty)));
  assert.equal(closed.status, 400);
  assert.equal(await codeOf(closed), "VALIDATION_ERROR");
  assert.equal(closedSeen.some((call) => call.sql.includes("UPDATE") && call.sql.includes("job_postings")), false);
});

test("applicant counts return the five stage keys", async () => {
  resetLimits();
  const res = await handle(
    new Request(`https://core.example/api/v1/postings/${POSTING}/applicant-counts`, { headers: { authorization: "Bearer secret-token" } }),
    env(),
    deps(authed([], true, async (sql) => {
      if (sql.includes("company_members") && sql.includes("job_postings")) {return { rows: [{ id: POSTING }], rowCount: 1 };}
      if (sql.includes("AS applied")) {
        return { rows: [{ applied: 1, screening: 2, interview: 3, offer: 4, rejected: 5 }], rowCount: 1 };
      }
      return empty;
    })),
  );
  assert.equal(res.status, 200);
  const body = await readJson<{ data: { total: number; applied: number; screening: number; interview: number; offer: number; rejected: number } }>(res);
  assert.deepEqual(body.data, { total: 15, applied: 1, screening: 2, interview: 3, offer: 4, rejected: 5 });

  resetLimits();
  const denied = await handle(
    new Request(`https://core.example/api/v1/postings/${POSTING}/applicant-counts`, { headers: { authorization: "Bearer secret-token" } }),
    env(),
    deps(authed([], false, async () => empty)),
  );
  assert.equal(denied.status, 404);
});

test("facets return every career id and category including zeros", async () => {
  resetLimits();
  const seen: Array<Call> = [];
  const res = await handle(new Request(
    "https://core.example/api/v1/postings/facets?q=kotlin&skills=Kotlin&careerYears=10%2B&category=dev&location="
      + encodeURIComponent("서울")
      + "&employmentType=full_time",
  ), env(), deps(async (sql, params = []) => {
    seen.push({ sql, params });
    if (sql.includes("rate_limits")) {return { rows: [{ hits: 1 }], rowCount: 1 };}
    if (sql.includes("career_0")) {return { rows: [{ career_0: 2, career_7_9: 1 }], rowCount: 1 };}
    if (sql.includes("GROUP BY p.job_category")) {return { rows: [{ id: "dev", count: 3 }], rowCount: 1 };}
    if (sql.includes("GROUP BY p.location")) {return { rows: [{ id: "서울 강남구", count: 1 }], rowCount: 1 };}
    return empty;
  }));
  assert.equal(res.status, 200);
  const body = await readJson<{
    data: {
      career: Array<{ id: string; count: number }>;
      category: Array<{ id: string; count: number }>;
      location: Array<{ id: string; count: number }>;
    };
  }>(res);
  assert.deepEqual(body.data.career, [
    { id: "0", count: 2 },
    { id: "1-3", count: 0 },
    { id: "4-6", count: 0 },
    { id: "7-9", count: 1 },
    { id: "10+", count: 0 },
  ]);
  assert.deepEqual(body.data.category.map((item) => item.id), ["dev", "data", "design", "plan", "marketing", "sales", "hr", "ops"]);
  assert.equal(body.data.category.find((item) => item.id === "dev")?.count, 3);
  assert.equal(body.data.category.find((item) => item.id === "data")?.count, 0);
  assert.deepEqual(body.data.location, [{ id: "서울 강남구", count: 1 }]);
  const careerSql = seen.find((call) => call.sql.includes("career_0"));
  const categorySql = seen.find((call) => call.sql.includes("GROUP BY p.job_category"));
  const locationSql = seen.find((call) => call.sql.includes("GROUP BY p.location"));
  assert.ok(careerSql);
  assert.ok(categorySql);
  assert.ok(locationSql);
  for (const call of [careerSql, categorySql, locationSql]) {
    assert.match(call.sql, /status = 'OPEN'/);
    assert.match(call.sql, /closed_at IS NULL/);
    assert.equal(call.params[0], "00000000-0000-0000-0000-000000000000");
    assert.equal(call.params.includes("Kotlin"), true);
    assert.equal(call.params.includes("full_time"), true);
    assert.equal(call.params.includes("kotlin"), true);
  }
  assert.equal(careerSql.params.includes("10+"), false);
  assert.equal(categorySql.params.includes("dev"), false);
  assert.equal(locationSql.params.includes("서울"), false);
  assert.match(careerSql.sql, /job_category = ANY/);
  assert.match(careerSql.sql, /p\.location = loc/);
  assert.doesNotMatch(categorySql.sql, /job_category = ANY/);
  assert.match(categorySql.sql, /'10\+' = ANY/);
  assert.match(locationSql.sql, /'10\+' = ANY/);
  assert.match(locationSql.sql, /job_category = ANY/);
  assert.doesNotMatch(locationSql.sql, /p\.location = loc/);
  assert.match(locationSql.sql, /ORDER BY count DESC, p\.location ASC/);
});

test("guest list returns 200 when the status column is missing", async () => {
  resetLimits();
  const seen: Array<Call> = [];
  const res = await handle(new Request("https://core.example/api/v1/postings"), env(), deps(async (sql, params = []) => {
    seen.push({ sql, params });
    if (sql.includes("rate_limits")) {return { rows: [{ hits: 1 }], rowCount: 1 };}
    if (sql.includes("status")) {throw missingRelation("42703", "column \"status\" of relation \"job_postings\" does not exist");}
    if (sql.includes("job_postings") && sql.includes("count(*)")) {return { rows: [{ total: 1 }], rowCount: 1 };}
    if (sql.includes("ORDER BY") && sql.includes("job_postings")) {
      return {
        rows: [{ id: POSTING, company: "Acme", title: "Backend", created_at: NOW, revision: 1, closed_at: null }],
        rowCount: 1,
      };
    }
    return empty;
  }));
  assert.equal(res.status, 200);
  const body = await readJson<{ data: Array<{ id: string; status?: string }> }>(res);
  assert.equal(body.data.length, 1);
  assert.equal(body.data[0].id, POSTING);
  assert.equal(Object.hasOwn(body.data[0], "status"), false);
  assert.equal(seen.some((call) => call.sql.includes("job_postings") && call.sql.includes("status")), true);
  assert.equal(seen.some((call) => call.sql.includes("job_postings") && call.sql.includes("ORDER BY") && !call.sql.includes("status")), true);
});

test("patch cannot publish a closed posting", async () => {
  resetLimits();
  const seen: Array<Call> = [];
  const res = await handle(patch(`/api/v1/postings/${POSTING}`, {
    status: "OPEN",
    expectedRevision: 1,
  }), env(), deps(authed(seen, true, async (sql) => {
    if (sql.includes("company_members") && !sql.includes("access_tokens")) {return { rows: [verified], rowCount: 1 };}
    if (sql.includes("job_postings")) {
      return {
        rows: [{
          id: POSTING,
          revision: 1,
          status: "CLOSED",
          company: "Acme",
          title: "Backend",
          job_category: "dev",
          career_min: 1,
          career_max: 3,
          location: "서울 강남구",
          employment_type: "full_time",
          description: "Build APIs",
          closed_at: NOW,
        }],
        rowCount: 1,
      };
    }
    return empty;
  })));
  assert.equal(res.status, 400);
  assert.equal(await codeOf(res), "VALIDATION_ERROR");
  assert.equal(seen.some((call) => call.sql.includes("UPDATE") && call.sql.includes("job_postings")), false);
});

test("member create patch and close include applicantCount", async () => {
  resetLimits();
  const created = await handle(
    post("/api/v1/postings", postingBody, "66666666-6666-4666-8666-666666666671"),
    env(),
    deps(authed([], true, companyQuery)),
  );
  assert.equal(created.status, 201);
  const createdBody = await readJson<{ data: { applicantCount: number; status: string } }>(created);
  assert.equal(createdBody.data.status, "OPEN");
  assert.equal(createdBody.data.applicantCount, 0);

  resetLimits();
  const patchSeen: Array<Call> = [];
  const patched = await handle(patch(`/api/v1/postings/${POSTING}`, {
    title: "Backend",
    expectedRevision: 1,
  }), env(), deps(authed(patchSeen, true, async (sql) => {
    if (sql.includes("company_members") && !sql.includes("access_tokens")) {return { rows: [verified], rowCount: 1 };}
    if (sql.includes("UPDATE") && sql.includes("job_postings")) {
      return {
        rows: [{
          id: POSTING,
          revision: 2,
          status: "OPEN",
          applicant_count: 6,
          company: "Acme",
          title: "Backend",
          closed_at: null,
        }],
        rowCount: 1,
      };
    }
    if (sql.includes("job_postings")) {
      return {
        rows: [{
          id: POSTING,
          revision: 1,
          status: "OPEN",
          company: "Acme",
          title: "Backend",
          job_category: "dev",
          career_min: 1,
          career_max: 3,
          location: "서울 강남구",
          employment_type: "full_time",
          description: "Build APIs",
          closed_at: null,
        }],
        rowCount: 1,
      };
    }
    return empty;
  })));
  assert.equal(patched.status, 200);
  const patchedBody = await readJson<{ data: { applicantCount: number } }>(patched);
  assert.equal(patchedBody.data.applicantCount, 6);
  const update = patchSeen.find((call) => call.sql.includes("UPDATE") && call.sql.includes("job_postings"));
  assert.ok(update);
  assert.match(update.sql, /AS applicant_count/);

  resetLimits();
  const closeSeen: Array<Call> = [];
  const closed = await handle(
    post(`/api/v1/postings/${POSTING}/close`, { expectedRevision: 1 }, "33333333-3333-4333-8333-33333333333a"),
    env(),
    deps(authed(closeSeen, true, async (sql) => {
      if (sql.includes("company_members") && !sql.includes("access_tokens")) {return { rows: [verified], rowCount: 1 };}
      if (sql.includes("UPDATE") && sql.includes("job_postings")) {
        return {
          rows: [{
            id: POSTING,
            revision: 2,
            status: "CLOSED",
            applicant_count: 6,
            company: "Acme",
            title: "Backend",
            closed_at: NOW,
          }],
          rowCount: 1,
        };
      }
      if (sql.includes("job_postings")) {
        return { rows: [{ id: POSTING, revision: 1, closed_at: null, company_id: COMPANY }], rowCount: 1 };
      }
      return empty;
    })),
  );
  assert.equal(closed.status, 200);
  const closedBody = await readJson<{ data: { applicantCount: number; status: string } }>(closed);
  assert.equal(closedBody.data.applicantCount, 6);
  assert.equal(closedBody.data.status, "CLOSED");
  const closeSql = closeSeen.find((call) => call.sql.includes("UPDATE") && call.sql.includes("job_postings"));
  assert.ok(closeSql);
  assert.match(closeSql.sql, /AS applicant_count/);
});

test("company list and closed detail derive status when the column is missing", async () => {
  resetLimits();
  const listed = await handle(
    new Request("https://core.example/api/v1/companies/me/postings", { headers: { authorization: "Bearer secret-token" } }),
    env(),
    deps(authed([], true, async (sql) => {
      if (sql.includes("company_members") && !sql.includes("access_tokens")) {return { rows: [{ company_id: COMPANY }], rowCount: 1 };}
      if (sql.includes("status")) {throw missingRelation("42703", "column \"status\" of relation \"job_postings\" does not exist");}
      if (sql.includes("AS total")) {return { rows: [{ total: 1 }], rowCount: 1 };}
      if (sql.includes("ORDER BY") && sql.includes("job_postings")) {
        return {
          rows: [{
            id: POSTING,
            company: "Acme",
            title: "Backend",
            closed_at: NOW,
            created_at: NOW,
            revision: 1,
            applicant_count: 3,
          }],
          rowCount: 1,
        };
      }
      return empty;
    })),
  );
  assert.equal(listed.status, 200);
  const listedBody = await readJson<{ data: Array<{ status: string; applicantCount: number }> }>(listed);
  assert.equal(listedBody.data[0].status, "CLOSED");
  assert.equal(listedBody.data[0].applicantCount, 3);

  resetLimits();
  const detail = await handle(
    new Request(`https://core.example/api/v1/postings/${POSTING}`, { headers: { authorization: "Bearer secret-token" } }),
    env(),
    deps(authed([], true, async (sql) => {
      if (sql.includes("company_members") && sql.includes("job_postings")) {return { rows: [{ id: POSTING }], rowCount: 1 };}
      if (sql.includes("status")) {throw missingRelation("42703", "column \"status\" of relation \"job_postings\" does not exist");}
      if (sql.includes("closed_at IS NULL")) {return empty;}
      if (sql.includes("FROM job_postings")) {
        return {
          rows: [{
            id: POSTING,
            company: "Acme",
            title: "Backend",
            description: "Hidden",
            closed_at: NOW,
            applicant_count: 1,
            revision: 1,
            created_at: NOW,
          }],
          rowCount: 1,
        };
      }
      return empty;
    })),
  );
  assert.equal(detail.status, 200);
  const detailBody = await readJson<{ data: { status: string; applicantCount: number } }>(detail);
  assert.equal(detailBody.data.status, "CLOSED");
  assert.equal(detailBody.data.applicantCount, 1);
});

test("guest applicant counts are 404", async () => {
  resetLimits();
  const res = await handle(
    new Request(`https://core.example/api/v1/postings/${POSTING}/applicant-counts`),
    env(),
    deps(async (sql) => {
      if (sql.includes("rate_limits")) {return { rows: [{ hits: 1 }], rowCount: 1 };}
      return empty;
    }),
  );
  assert.equal(res.status, 404);
});

{
const POSTING = "11111111-1111-4111-8111-111111111111";
const APP = "22222222-2222-4222-8222-222222222222";
const FILE = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2026-10-21T00:00:00Z");
const ENV = { APP_ENV: "production" };
const E1 = "e0000000-0000-4000-8000-000000000001";
const E2 = "e0000000-0000-4000-8000-000000000002";
const E3 = "e0000000-0000-4000-8000-000000000003";
const postingRow = { company: "Acme", title: "Backend", description: "Build", requirements: ["Go"], deadline: null };
const appRow = { id: APP, revision: 1, job_id: E3, company: "Acme", title: "Backend", stage: "APPLIED", notes: "", applied_at: "2026-10-21T00:00:00Z", next_action_at: null, imported: false, created_at: "2026-10-21T00:00:00Z", updated_at: "2026-10-21T00:00:00Z" };

test("an applicant file with a Korean name downloads with an RFC 5987 filename", async () => {
  const { handle } = await import("../src/handler.ts");
  const { query } = recorder((sql) => {
    if (sql.includes("JOIN company_members m")) {return [{ id: POSTING }];}
    if (sql.includes("FROM application_files f")) {return [{ file_name: "이력서 \"최종\".pdf", mime_type: "application/pdf", content: String.raw`\x255044` }];}
    return null;
  });
  const res = await handle(new Request(`https://core.example/api/v1/postings/${POSTING}/applicants/${APP}/files/${FILE}`, {
    headers: { authorization: "Bearer t" },
  }), ENV, { query, now: () => NOW });
  assert.equal(res.status, 200);
  const disposition = res.headers.get("content-disposition") ?? "";
  assert.match(disposition, /^attachment; filename="[\u0020-\u007e]*"; filename\*=UTF-8''/);
  assert.ok(disposition.includes(encodeURIComponent("이력서")));
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual([...new Uint8Array(await res.arrayBuffer())], [0x25, 0x50, 0x44]);
});

test("apply checks every document and source in one query each and writes in one statement", async () => {
  const { handle } = await import("../src/handler.ts");
  const S1 = "50000000-0000-4000-8000-000000000001";
  const S2 = "50000000-0000-4000-8000-000000000002";
  const { calls, query } = recorder((sql) => {
    if (sql.includes("FROM job_postings p WHERE p.id = $1")) {return [postingRow];}
    if (sql.includes("FROM documents d")) {return [E1, E2].map((id) => ({ id, title: "Doc", content: { id } }));}
    if (sql.startsWith("SELECT id FROM sources")) {return [{ id: S1 }, { id: S2 }];}
    if (sql.startsWith("WITH job AS")) {return [{ id: APP }];}
    if (sql.includes("INSERT INTO ai_jobs")) {return [{ id: "00000000-0000-4000-8000-000000000099", queue: "q:ingest" }];}
    return null;
  });
  const res = await handle(postJson(`/api/v1/postings/${POSTING}/apply`, { documentIds: [E1, E2], sourceIds: [S1, S2] }, "00000000-0000-4000-8000-000000000008"),
    ENV, { query, now: () => NOW });
  assert.equal(res.status, 201);
  const routeCalls = calls.filter((c) => !/rate_limits|access_tokens|idempotency_keys/.test(c.sql));
  assert.equal(routeCalls.length, 6);
  assert.equal(routeCalls.filter((c) => c.sql.startsWith("WITH job AS")).length, 1);
  assert.equal(routeCalls.filter((c) => c.sql.includes("INSERT INTO ai_jobs")).length, 1);
});

test("apply falls back when stage_entered_at is missing", async () => {
  const { handle } = await import("../src/handler.ts");
  const missing = Object.assign(new Error('column "stage_entered_at" of relation "applications" does not exist'), { code: "42703" });
  const { calls, query } = recorder((sql) => {
    if (sql.includes("FROM job_postings p WHERE p.id = $1")) {return [postingRow];}
    if (sql.startsWith("WITH job AS") && sql.includes("stage_entered_at")) {throw missing;}
    if (sql.startsWith("WITH job AS")) {return [{ id: APP }];}
    if (sql.includes("INSERT INTO ai_jobs")) {return [{ id: "00000000-0000-4000-8000-000000000099", queue: "q:ingest" }];}
    return null;
  });
  const res = await handle(postJson(`/api/v1/postings/${POSTING}/apply`, {}, "00000000-0000-4000-8000-00000000000a"),
    ENV, { query, now: () => NOW });
  assert.equal(res.status, 201);
  const writes = calls.filter((c) => c.sql.startsWith("WITH job AS"));
  assert.equal(writes.length, 2);
  assert.match(writes[0].sql, /stage_entered_at/);
  assert.equal(writes[1].sql.includes("stage_entered_at"), false);
  const body = await readJson<{ data: { stageEnteredAt: Record<string, string> } }>(res);
  assert.equal(body.data.stageEnteredAt.APPLIED, "2026-10-21T00:00:00Z");
});

test("apply keeps stage_entered_at when only applicant_snapshot is missing", async () => {
  const { handle } = await import("../src/handler.ts");
  const missing = Object.assign(new Error('column "applicant_snapshot" of relation "applications" does not exist'), { code: "42703" });
  const { calls, query } = recorder((sql) => {
    if (sql.includes("FROM job_postings p WHERE p.id = $1")) {return [postingRow];}
    if (sql.startsWith("WITH job AS") && sql.includes("applicant_snapshot")) {throw missing;}
    if (sql.startsWith("WITH job AS")) {return [{ id: APP }];}
    if (sql.includes("INSERT INTO ai_jobs")) {return [{ id: "00000000-0000-4000-8000-000000000099", queue: "q:ingest" }];}
    return null;
  });
  const res = await handle(postJson(`/api/v1/postings/${POSTING}/apply`, {}, "00000000-0000-4000-8000-00000000000b"),
    ENV, { query, now: () => NOW });
  assert.equal(res.status, 201);
  const writes = calls.filter((c) => c.sql.startsWith("WITH job AS"));
  assert.equal(writes.length, 2);
  assert.match(writes[0].sql, /applicant_snapshot/);
  assert.match(writes[1].sql, /stage_entered_at/);
  assert.equal(writes[1].sql.includes("applicant_snapshot"), false);
});

test("apply answers with the winning application when a simultaneous apply hits the unique index", async () => {
  const { handle } = await import("../src/handler.ts");
  let lookups = 0;
  const { query } = recorder((sql) => {
    if (sql.includes("FROM job_postings p WHERE p.id = $1")) {return [postingRow];}
    if (sql.startsWith("WITH job AS")) {throw Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" });}
    if (sql.includes("FROM applications a JOIN jobs j")) {return lookups++ === 0 ? [] : [appRow];}
    return null;
  });
  const res = await handle(postJson(`/api/v1/postings/${POSTING}/apply`, {}, "00000000-0000-4000-8000-000000000009"), ENV, { query, now: () => NOW });
  assert.equal(res.status, 201);
  assert.equal(((await readJson<{ data: { id: string } }>(res))).data.id, APP);
});

test("posting facets run their five counts in parallel", async () => {
  const { handle } = await import("../src/handler.ts");
  let inFlight = 0;
  let peak = 0;
  let started = 0;
  const { promise: gate, resolve: release } = deferred();
  const fallback = setTimeout(release, 200);
  const query: Deps["query"] = async (sql) => {
    if (sql.includes("rate_limits")) {return { rows: [{ hits: 1 }], rowCount: 1 };}
    inFlight += 1;
    started += 1;
    peak = Math.max(peak, inFlight);
    if (started === 5) {
      clearTimeout(fallback);
      release();
    }
    await gate;
    inFlight -= 1;
    return { rows: [], rowCount: 0 };
  };
  try {
    const res = await handle(new Request("https://core.example/api/v1/postings/facets"), ENV, { query, now: () => NOW });
    assert.equal(res.status, 200);
    assert.equal(peak, 5);
  } finally {
    clearTimeout(fallback);
    release();
  }
});
}


test("a viewer on a free-mail address is still hidden from a candidate who hides from the viewer's company", async () => {
  resetLimits();
  const seen: Array<Call> = [];
  const sameCompany = { ...hubProfile, email_domain: "other.com", same_company_as_viewer: true };
  const list = (row: Row, calls: Array<Call>) => handle(
    new Request("https://core.example/api/v1/profiles", { headers: { authorization: "Bearer secret-token" } }),
    env(),
    deps(authed(calls, false, async (sql) => {
      if (sql.includes("SELECT email FROM users")) {return { rows: [{ email: "ada@gmail.com" }], rowCount: 1 };}
      if (sql.includes("FROM profiles")) {return { rows: [row], rowCount: 1 };}
      return empty;
    })),
  );
  const hidden = await readJson<{ data: Array<{ careerStatus: string | null }> }>(await list(sameCompany, seen));
  assert.equal(hidden.data[0].careerStatus, null);
  const sql = seen.find((call) => call.sql.includes("same_company_as_viewer"))!.sql;
  assert.match(sql, /company_members vm JOIN companies vc/);
  assert.match(sql, /career ->> 'endedOn' IS NULL/);

  resetLimits();
  const shown = await readJson<{ data: Array<{ careerStatus: string | null }> }>(await list({ ...sameCompany, same_company_as_viewer: false }, []));
  assert.equal(shown.data[0].careerStatus, "seeking");
});

test("applicant detail carries the company's latest AI review and interview kit", async () => {
  resetLimits();
  const seen: Array<Call> = [];
  const review = {
    id: DOC, conversation_id: POSTING, created_at: "2026-11-26T00:00:00.000Z",
    report: { summary: "확인할 곳 1곳", matches: [{ requirement: "Java", status: "MET", evidence: "4년" }],
      flags: [{ title: "Kafka 운영", level: "CHECK", reason: "범위가 모호해요", quote: "운영" }] },
  };
  const kit = {
    id: DOC, conversation_id: POSTING, created_at: "2026-11-26T00:00:00.000Z",
    kit: { questions: [{ text: "Kafka 장애는?", verify: "본인 운영", good_signals: ["재현"], caution_signals: [], from_flag: "Kafka 운영" }] },
  };
  const res = await handle(
    new Request(`https://core.example/api/v1/postings/${POSTING}/applicants/${APP}`, { headers: { authorization: "Bearer secret-token" } }),
    env(),
    deps(authed(seen, true, async (sql) => {
      if (sql.includes("FROM employer_reviews")) {return { rows: [review], rowCount: 1 };}
      if (sql.includes("FROM employer_interview_kits")) {return { rows: [kit], rowCount: 1 };}
      const member = await memberPosting(sql);
      if (member) {return member;}
      if (sql.includes("applications")) {return { rows: [applicationRow("OFFER")], rowCount: 1 };}
      return empty;
    })),
  );
  assert.equal(res.status, 200);
  const body = await readJson<{ data: { aiReview: unknown; interviewKit: unknown } }>(res);
  assert.deepEqual(body.data.aiReview, {
    id: DOC, conversationId: POSTING, createdAt: "2026-11-26T00:00:00Z", summary: "확인할 곳 1곳",
    matches: [{ requirement: "Java", status: "MET", evidence: "4년" }],
    flags: [{ title: "Kafka 운영", level: "CHECK", reason: "범위가 모호해요", quote: "운영" }],
  });
  assert.deepEqual(body.data.interviewKit, {
    id: DOC, conversationId: POSTING, createdAt: "2026-11-26T00:00:00Z",
    questions: [{ text: "Kafka 장애는?", verify: "본인 운영", goodSignals: ["재현"], cautionSignals: [], fromFlag: "Kafka 운영" }],
  });
  const scoped = seen.filter((call) => call.sql.includes("FROM employer_"));
  assert.equal(scoped.length, 2);
  for (const call of scoped) {assert.match(call.sql, /company_id = \(SELECT company_id FROM job_postings WHERE id = \$2\)/);}
});
