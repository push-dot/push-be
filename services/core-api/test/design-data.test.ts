import assert from "node:assert/strict";
import { test } from "node:test";

import { handle, type CoreEnv, type Deps } from "../src/handler.ts";
import { resetLimits } from "../src/ratelimit.ts";
import { encodeCursor } from "../src/time.ts";

const USER = "12345678-1234-5678-1234-567812345678";
const OTHER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const POSTING_A = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const POSTING_B = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const APP_A = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const APP_B = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const DOC_A = "11111111-1111-4111-8111-111111111111";
const DOC_B = "22222222-2222-4222-8222-222222222222";
const ANALYSIS_NEW = "33333333-3333-4333-8333-333333333333";
const ANALYSIS_OLD = "44444444-4444-4444-8444-444444444444";
const NOW = "2026-10-21T00:00:00.000Z";

type Call = { sql: string; params: unknown[] };
type Err = { error: { code: string; details: { field?: string } | null } };
type Page = { data: { id: string }[]; page: { nextCursor: string | null; hasMore: boolean; total: number } };

const env = (): CoreEnv => ({ APP_ENV: "production", MANAGED_AI: "1" });
const deps = (query: Deps["query"]): Deps => ({ query, now: () => new Date(NOW) });
const empty = { rows: [] as Record<string, unknown>[], rowCount: 0 };

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
  if (sql.includes("idempotency_keys")) return { rows: [], rowCount: 0 };
  return extra(sql, params);
};

const get = (path: string, bearer = true): Request => new Request("https://core.example" + path, {
  headers: bearer ? { authorization: "Bearer secret-token" } : {},
});

const card = (id: string, viewedOn: string) => ({
  id, company: "Acme", title: id === POSTING_A ? "Backend" : "Data", job_category: "dev",
  viewed_on: viewedOn, created_at: NOW, revision: 1, closed_at: null,
});

const codeOf = async (res: Response): Promise<Err> => await res.json() as Err;

test("lists a posting once, newest viewed day first", async () => {
  resetLimits();
  const seen: Call[] = [];
  const res = await handle(get("/api/v1/me/posting-views"), env(), deps(authed(seen, async (sql) => {
    if (sql.includes("count(*)") && sql.includes("posting_views")) return { rows: [{ total: 2 }], rowCount: 1 };
    if (sql.includes("posting_views")) return { rows: [card(POSTING_A, "2026-10-21"), card(POSTING_B, "2026-10-19")], rowCount: 2 };
    return empty;
  })));
  assert.equal(res.status, 200);
  const body = await res.json() as Page;
  assert.deepEqual(body.data.map((row) => row.id), [POSTING_A, POSTING_B]);
  assert.equal(body.page.total, 2);
  const listed = seen.find((call) => call.sql.includes("ORDER BY") && call.sql.includes("posting_views"));
  assert.ok(listed);
  assert.match(listed.sql, /max\(pv\.viewed_on\)/);
  assert.match(listed.sql, /GROUP BY pv\.posting_id/);
  assert.match(listed.sql, /ORDER BY v\.viewed_on DESC, p\.id DESC/);
  assert.equal(seen.some((call) => call.sql.includes("view_count")), false);
});

test("hides another user's views", async () => {
  resetLimits();
  const seen: Call[] = [];
  const res = await handle(get("/api/v1/me/posting-views"), env(), deps(authed(seen, async (sql) => {
    if (sql.includes("count(*)") && sql.includes("posting_views")) return { rows: [{ total: 1 }], rowCount: 1 };
    if (sql.includes("pv.user_id = $1") && sql.includes("posting_views")) return { rows: [card(POSTING_A, "2026-10-21")], rowCount: 1 };
    if (sql.includes("posting_views")) return { rows: [card(POSTING_A, "2026-10-21"), card(POSTING_B, "2026-10-20")], rowCount: 2 };
    return empty;
  })));
  assert.equal(res.status, 200);
  const body = await res.json() as Page;
  assert.deepEqual(body.data.map((row) => row.id), [POSTING_A]);
  const listed = seen.find((call) => call.sql.includes("posting_views") && call.sql.includes("ORDER BY"));
  assert.ok(listed);
  assert.match(listed.sql, /pv\.user_id = \$1/);
  assert.equal(listed.params[0], USER);
  assert.equal(listed.params.includes(OTHER), false);
});

test("returns an empty page when posting_views is missing", async () => {
  resetLimits();
  const missing = Object.assign(new Error('relation "posting_views" does not exist'), { code: "42P01" });
  const res = await handle(get("/api/v1/me/posting-views"), env(), deps(authed([], async (sql) => {
    if (sql.includes("posting_views")) throw missing;
    return empty;
  })));
  assert.equal(res.status, 200);
  const body = await res.json() as Page;
  assert.deepEqual(body.data, []);
  assert.deepEqual(body.page, { nextCursor: null, hasMore: false, total: 0 });
});

test("rejects a guest", async () => {
  resetLimits();
  const res = await handle(get("/api/v1/me/posting-views", false), env(), deps(async () => empty));
  assert.equal(res.status, 401);
  assert.equal((await codeOf(res)).error.code, "UNAUTHENTICATED");
});

const apps = (rows: Record<string, unknown>[]) => async (sql: string) => {
  if (sql.includes("FROM applications")) return { rows, rowCount: rows.length };
  return empty;
};

test("finalized document is READY and a draft is DRAFT", async () => {
  resetLimits();
  const res = await handle(get(`/api/v1/me/posting-document-status?postingIds=${POSTING_A},${POSTING_B}`), env(), deps(authed([], async (sql) => {
    if (sql.includes("FROM applications")) {
      return { rows: [
        { application_id: APP_A, posting_id: POSTING_A },
        { application_id: APP_B, posting_id: POSTING_B },
      ], rowCount: 2 };
    }
    if (sql.includes("FROM documents")) {
      return { rows: [
        { application_id: APP_A, status: "FINALIZED", updated_at: "2026-10-01T00:00:00.000Z", id: DOC_A, user_id: USER },
        { application_id: APP_A, status: "DRAFT", updated_at: "2026-10-02T00:00:00.000Z", id: DOC_B, user_id: USER },
        { application_id: APP_B, status: "FINALIZED", updated_at: "2026-10-03T00:00:00.000Z", id: DOC_A, user_id: USER },
      ], rowCount: 3 };
    }
    return empty;
  })));
  assert.equal(res.status, 200);
  const body = await res.json() as { data: { items: { postingId: string; status: string; label: string }[] } };
  assert.deepEqual(body.data.items, [
    { postingId: POSTING_A, status: "DRAFT", label: "초안 있음" },
    { postingId: POSTING_B, status: "READY", label: "서류 준비됨" },
  ]);
});

test("snapshot without a document is READY", async () => {
  resetLimits();
  const res = await handle(get(`/api/v1/me/posting-document-status?postingIds=${POSTING_A}`), env(), deps(authed([], async (sql) => {
    if (sql.includes("FROM applications")) return { rows: [{ application_id: APP_A, posting_id: POSTING_A }], rowCount: 1 };
    if (sql.includes("application_snapshots")) return { rows: [{ application_id: APP_A }], rowCount: 1 };
    return empty;
  })));
  assert.equal(res.status, 200);
  const body = await res.json() as { data: { items: { status: string; label: string }[] } };
  assert.equal(body.data.items[0].status, "READY");
  assert.equal(body.data.items[0].label, "서류 준비됨");
});

test("discovered application with no snapshot is NONE", async () => {
  resetLimits();
  const res = await handle(get(`/api/v1/me/posting-document-status?postingIds=${POSTING_A}`), env(), deps(authed([], apps([{ application_id: APP_A, posting_id: POSTING_A }]))));
  assert.equal(res.status, 200);
  const body = await res.json() as { data: { items: { status: string; label: string }[] } };
  assert.equal(body.data.items[0].status, "NONE");
  assert.equal(body.data.items[0].label, "서류 없음");
});

test("unknown id is NONE and does not 404", async () => {
  resetLimits();
  const res = await handle(get(`/api/v1/me/posting-document-status?postingIds=${POSTING_B}`), env(), deps(authed([], async () => empty)));
  assert.equal(res.status, 200);
  const body = await res.json() as { data: { items: { postingId: string; status: string }[] } };
  assert.deepEqual(body.data.items, [{ postingId: POSTING_B, status: "NONE", label: "서류 없음" }]);
});

test("archived document is ignored", async () => {
  resetLimits();
  const res = await handle(get(`/api/v1/me/posting-document-status?postingIds=${POSTING_A}`), env(), deps(authed([], async (sql) => {
    if (sql.includes("FROM applications")) return { rows: [{ application_id: APP_A, posting_id: POSTING_A }], rowCount: 1 };
    if (sql.includes("FROM documents")) return { rows: [{ application_id: APP_A, status: "ARCHIVED", updated_at: NOW, id: DOC_A, user_id: USER }], rowCount: 1 };
    if (sql.includes("application_snapshots")) return { rows: [{ application_id: APP_A }], rowCount: 1 };
    return empty;
  })));
  assert.equal(res.status, 200);
  const body = await res.json() as { data: { items: { status: string }[] } };
  assert.equal(body.data.items[0].status, "READY");
});

test("empty postingIds is 400", async () => {
  resetLimits();
  const res = await handle(get("/api/v1/me/posting-document-status?postingIds="), env(), deps(authed([], async () => empty)));
  assert.equal(res.status, 400);
  assert.equal((await codeOf(res)).error.details?.field, "postingIds");
});

test("51 ids is 400", async () => {
  resetLimits();
  const ids = Array.from({ length: 51 }, (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`);
  const res = await handle(get("/api/v1/me/posting-document-status?postingIds=" + ids.join(",")), env(), deps(authed([], async () => empty)));
  assert.equal(res.status, 400);
  assert.equal((await codeOf(res)).error.details?.field, "postingIds");
});

test("other user's document stays NONE", async () => {
  resetLimits();
  const res = await handle(get(`/api/v1/me/posting-document-status?postingIds=${POSTING_A}`), env(), deps(authed([], async (sql) => {
    if (sql.includes("FROM applications")) return { rows: [{ application_id: APP_A, posting_id: POSTING_A }], rowCount: 1 };
    if (sql.includes("FROM documents")) return { rows: [{ application_id: APP_A, status: "FINALIZED", updated_at: NOW, id: DOC_A, user_id: OTHER }], rowCount: 1 };
    return empty;
  })));
  assert.equal(res.status, 200);
  const body = await res.json() as { data: { items: { status: string }[] } };
  assert.equal(body.data.items[0].status, "NONE");
});

const gapRow = (id: string, preferred: string[], missing: string[], posting: string | null = POSTING_A) => ({
  id, preferred_missing: preferred, missing, application_id: APP_A, company: "Acme", title: "Backend", source_posting_id: posting,
});

test("preferred_missing comes before missing, newest analysis first, cap 5", async () => {
  resetLimits();
  const seen: Call[] = [];
  const res = await handle(get("/api/v1/me/suggested-experiences"), env(), deps(authed(seen, async (sql) => {
    if (sql.includes("gap_analyses")) return { rows: [
      gapRow(ANALYSIS_NEW, ["p0", "p1", "p2"], ["m0", "m1", "m2"]),
      gapRow(ANALYSIS_OLD, ["old-pref"], ["old-miss"]),
    ], rowCount: 2 };
    return empty;
  })));
  assert.equal(res.status, 200);
  const body = await res.json() as { data: { items: { id: string; sub: string }[] } };
  assert.deepEqual(body.data.items.map((item) => item.id), [
    `${ANALYSIS_NEW}:preferred:0`,
    `${ANALYSIS_NEW}:preferred:1`,
    `${ANALYSIS_NEW}:preferred:2`,
    `${ANALYSIS_NEW}:missing:0`,
    `${ANALYSIS_NEW}:missing:1`,
  ]);
  assert.equal(body.data.items[0].sub, "우대 사항");
  assert.equal(body.data.items[3].sub, "자격 요건");
  assert.match(seen.find((call) => call.sql.includes("gap_analyses"))?.sql ?? "", /ORDER BY g\.created_at DESC, g\.id DESC/);
});

test("blank and duplicate strings are skipped", async () => {
  resetLimits();
  const res = await handle(get("/api/v1/me/suggested-experiences"), env(), deps(authed([], async (sql) => {
    if (sql.includes("gap_analyses")) return { rows: [gapRow(ANALYSIS_NEW, ["", "  ", "Kafka", "Kafka", "Go"], [])], rowCount: 1 };
    return empty;
  })));
  const body = await res.json() as { data: { items: { id: string; title: string }[] } };
  assert.deepEqual(body.data.items.map((item) => item.id), [`${ANALYSIS_NEW}:preferred:2`, `${ANALYSIS_NEW}:preferred:4`]);
  assert.deepEqual(body.data.items.map((item) => item.title), ["Kafka", "Go"]);
});

test("title is clipped to 80 code points and is not split", async () => {
  resetLimits();
  const title = "가".repeat(90);
  const res = await handle(get("/api/v1/me/suggested-experiences"), env(), deps(authed([], async (sql) => {
    if (sql.includes("gap_analyses")) return { rows: [gapRow(ANALYSIS_NEW, [title], [], null)], rowCount: 1 };
    return empty;
  })));
  const body = await res.json() as { data: { items: { title: string; meta: string; postingId: string | null }[] } };
  assert.equal([...body.data.items[0].title].length, 80);
  assert.equal(body.data.items[0].title.includes("\n"), false);
  assert.equal(body.data.items[0].meta, "Acme · Backend");
  assert.equal(body.data.items[0].postingId, null);
});

test("no analyses returns items empty", async () => {
  resetLimits();
  const res = await handle(get("/api/v1/me/suggested-experiences"), env(), deps(authed([], async () => empty)));
  assert.equal(res.status, 200);
  const body = await res.json() as { data: { items: unknown[] } };
  assert.deepEqual(body.data.items, []);
});

test("missing gap_analyses table returns items empty", async () => {
  resetLimits();
  const missing = Object.assign(new Error('relation "gap_analyses" does not exist'), { code: "42P01" });
  const res = await handle(get("/api/v1/me/suggested-experiences"), env(), deps(authed([], async (sql) => {
    if (sql.includes("gap_analyses")) throw missing;
    return empty;
  })));
  assert.equal(res.status, 200);
  const body = await res.json() as { data: { items: unknown[] } };
  assert.deepEqual(body.data.items, []);
});

test("guest is 401", async () => {
  resetLimits();
  for (const path of ["/api/v1/me/suggested-experiences", "/api/v1/me/career-topics", "/api/v1/me/match-chips"]) {
    const res = await handle(get(path, false), env(), deps(async () => empty));
    assert.equal(res.status, 401, path);
    assert.equal((await codeOf(res)).error.code, "UNAUTHENTICATED");
  }
});

test("recommended is empty when the caller has no job_category", async () => {
  resetLimits();
  const seen: Call[] = [];
  const res = await handle(get("/api/v1/profiles?explore=recommended"), env(), deps(authed(seen, async (sql) => {
    if (sql.includes("SELECT email FROM users")) return { rows: [{ email: "ada@acme.com" }], rowCount: 1 };
    if (sql.startsWith("SELECT count(*)")) return { rows: [{ total: 0 }], rowCount: 1 };
    return empty;
  })));
  assert.equal(res.status, 200);
  const body = await res.json() as { data: unknown[] };
  assert.deepEqual(body.data, []);
  const listed = seen.find((call) => call.sql.includes("explore") || call.sql.includes("job_category = (SELECT job_category"));
  const sql = seen.map((call) => call.sql).join("\n");
  assert.match(sql, /p\.job_category = \(SELECT job_category FROM profiles WHERE user_id = \$1\)/);
  assert.doesNotMatch(sql, /OR p\.job_category/);
  assert.equal(listed == null || !String(listed.sql).includes("popular"), true);
});

const profile = (extra: Record<string, unknown>) => async (sql: string) => {
  if (sql.includes("FROM profiles")) return { rows: [extra], rowCount: 1 };
  if (sql.includes("FROM applications")) return { rows: [{ title: "백엔드", stage: "APPLIED" }], rowCount: 1 };
  if (sql.includes("gap_analyses")) return { rows: [{ missing: ["Kafka 운영"] }], rowCount: 1 };
  return empty;
};

test("returns career, then application, then gap when all three exist", async () => {
  resetLimits();
  const res = await handle(get("/api/v1/me/career-topics"), env(), deps(authed([], profile({
    job_category: "dev",
    careers: [{ role: "백엔드", description: "api" }],
  }))));
  assert.equal(res.status, 200);
  const body = await res.json() as { data: { items: { id: string; title: string; sub: string; source: string }[] } };
  assert.deepEqual(body.data.items.map((item) => item.id), ["career", "application", "gap"]);
  assert.equal(body.data.items[0].title, "백엔드");
  assert.equal(body.data.items[0].sub, "개발 · 이력서 경력에서");
  assert.equal(body.data.items[0].source, "career");
  assert.equal(body.data.items[1].title, "백엔드 준비");
  assert.equal(body.data.items[1].sub, "커리어 · 지원 현황에서");
  assert.equal(body.data.items[2].title, "Kafka 운영");
});

test("skips a rejected application and a blank career", async () => {
  resetLimits();
  const res = await handle(get("/api/v1/me/career-topics"), env(), deps(authed([], async (sql) => {
    if (sql.includes("FROM profiles")) return { rows: [{ job_category: "dev", careers: [{ role: "  ", description: "" }] }], rowCount: 1 };
    if (sql.includes("FROM applications")) {
      if (!sql.includes("REJECTED")) return { rows: [{ title: "거절된 공고" }], rowCount: 1 };
      return { rows: [{ title: "백엔드" }], rowCount: 1 };
    }
    return empty;
  })));
  const body = await res.json() as { data: { items: { id: string; title: string }[] } };
  assert.deepEqual(body.data.items.map((item) => item.id), ["application"]);
  assert.equal(body.data.items[0].title, "백엔드 준비");
});

test("dev gap sub is 개발 · 역량 보완에서", async () => {
  resetLimits();
  const res = await handle(get("/api/v1/me/career-topics"), env(), deps(authed([], async (sql) => {
    if (sql.includes("FROM profiles")) return { rows: [{ job_category: "dev", careers: [] }], rowCount: 1 };
    if (sql.includes("gap_analyses")) return { rows: [{ missing: ["스트리밍"] }], rowCount: 1 };
    return empty;
  })));
  const body = await res.json() as { data: { items: { sub: string }[] } };
  assert.equal(body.data.items[0].sub, "개발 · 역량 보완에서");
});

test("null category uses 커리어", async () => {
  resetLimits();
  const res = await handle(get("/api/v1/me/career-topics"), env(), deps(authed([], async (sql) => {
    if (sql.includes("FROM profiles")) return { rows: [{ job_category: null, careers: [{ description: "설명만 있는 경력 문장입니다" }] }], rowCount: 1 };
    if (sql.includes("gap_analyses")) return { rows: [{ missing: ["운영"] }], rowCount: 1 };
    return empty;
  })));
  const body = await res.json() as { data: { items: { id: string; sub: string }[] } };
  assert.equal(body.data.items.find((item) => item.id === "career")?.sub, "커리어 · 이력서 경력에서");
  assert.equal(body.data.items.find((item) => item.id === "gap")?.sub, "커리어 · 역량 보완에서");
});

test("no profile and no applications returns items empty", async () => {
  resetLimits();
  const res = await handle(get("/api/v1/me/career-topics"), env(), deps(authed([], async () => empty)));
  assert.equal(res.status, 200);
  const body = await res.json() as { data: { items: unknown[] } };
  assert.deepEqual(body.data.items, []);
});

const chipsOf = async (row: Record<string, unknown> | null): Promise<string[]> => {
  resetLimits();
  const res = await handle(get("/api/v1/me/match-chips"), env(), deps(authed([], async (sql) => {
    if (sql.includes("FROM profiles") && row) return { rows: [row], rowCount: 1 };
    return empty;
  })));
  assert.equal(res.status, 200);
  const body = await res.json() as { data: { chips: string[] } };
  return body.data.chips;
};

test("category and role make the first chip, then tenure, then skills, cap 8", async () => {
  const chips = await chipsOf({
    job_category: "dev",
    tenure_years: "3-5",
    careers: [{ role: "백엔드" }],
    skills: ["개발 · 백엔드", "Kotlin", "Go", "Rust", "Java", "Python", "SQL", "Redis"],
    location: "서울",
  });
  assert.equal(chips[0], "개발 · 백엔드");
  assert.equal(chips[1], "경력 3–5년");
  assert.equal(chips.length, 8);
  assert.equal(chips.includes("Redis"), false);
  assert.equal(chips.filter((chip) => chip === "개발 · 백엔드").length, 1);
  assert.equal(chips.includes("서울"), false);
});

test("does not emit a location chip", async () => {
  const chips = await chipsOf({ job_category: "design", tenure_years: null, careers: [], skills: [], location: "서울" });
  assert.deepEqual(chips, ["디자인"]);
  assert.equal(chips.includes("서울"), false);
});

test("null tenure omits the tenure chip", async () => {
  const chips = await chipsOf({ job_category: "dev", tenure_years: null, careers: [{ role: "백엔드" }], skills: ["Kotlin"] });
  assert.deepEqual(chips, ["개발 · 백엔드", "Kotlin"]);
});

test("unknown tenure key omits the tenure chip", async () => {
  const chips = await chipsOf({ job_category: "dev", tenure_years: "4-6", careers: [], skills: [] });
  assert.deepEqual(chips, ["개발"]);
});

test("no profile returns chips empty", async () => {
  assert.deepEqual(await chipsOf(null), []);
});

test("omitted sort matches relevance order", async () => {
  resetLimits();
  const seen: Call[] = [];
  const res = await handle(get("/api/v1/search?type=postings&q=backend"), env(), deps(authed(seen, async (sql) => {
    if (sql.includes("count(*)")) return { rows: [{ total: 2 }], rowCount: 1 };
    if (sql.includes("job_postings")) return { rows: [
      { id: POSTING_A, company: "Acme", title: "backend", created_at: "2026-10-01T00:00:00.000Z", revision: 1 },
      { id: POSTING_B, company: "Acme", title: "newer", created_at: "2026-10-20T00:00:00.000Z", revision: 1 },
    ], rowCount: 2 };
    return empty;
  })));
  assert.equal(res.status, 200);
  const body = await res.json() as Page;
  assert.deepEqual(body.data.map((row) => row.id), [POSTING_A, POSTING_B]);
  const ordered = seen.find((call) => call.sql.includes("ORDER BY") && call.sql.includes("job_postings"));
  assert.ok(ordered);
  assert.match(ordered.sql, /ORDER BY CASE/);
  assert.match(ordered.sql, /p\.created_at DESC, p\.id DESC/);
});

test("latest postings ignore relevance", async () => {
  resetLimits();
  const seen: Call[] = [];
  const res = await handle(get("/api/v1/search?type=postings&q=backend&sort=latest"), env(), deps(authed(seen, async (sql) => {
    if (sql.includes("count(*)")) return { rows: [{ total: 1 }], rowCount: 1 };
    if (sql.includes("job_postings")) return { rows: [{ id: POSTING_B, company: "Acme", title: "newer", created_at: NOW, revision: 1 }], rowCount: 1 };
    return empty;
  })));
  assert.equal(res.status, 200);
  const ordered = seen.find((call) => call.sql.includes("ORDER BY") && call.sql.includes("job_postings"));
  assert.ok(ordered);
  assert.match(ordered.sql, /ORDER BY p\.created_at DESC, p\.id DESC/);
  assert.doesNotMatch(ordered.sql, /ORDER BY CASE/);
});

test("latest posts order by created_at", async () => {
  resetLimits();
  const seen: Call[] = [];
  const res = await handle(get("/api/v1/search?type=posts&q=backend&sort=latest"), env(), deps(authed(seen, async () => empty)));
  assert.equal(res.status, 200);
  const ordered = seen.find((call) => call.sql.includes("ORDER BY") && call.sql.includes("FROM posts"));
  assert.ok(ordered);
  assert.match(ordered.sql, /ORDER BY p\.created_at DESC, p\.id DESC/);
  assert.doesNotMatch(ordered.sql, /ORDER BY CASE/);
});

test("latest people order by updated_at", async () => {
  resetLimits();
  const seen: Call[] = [];
  const res = await handle(get("/api/v1/search?type=people&q=ada&sort=latest"), env(), deps(authed(seen, async (sql) => {
    if (sql.includes("SELECT email FROM users")) return { rows: [{ email: "ada@acme.com" }], rowCount: 1 };
    if (sql.includes("count(*)")) return { rows: [{ total: 0 }], rowCount: 1 };
    return empty;
  })));
  assert.equal(res.status, 200);
  const ordered = seen.find((call) => call.sql.includes("ORDER BY") && call.sql.includes("FROM profiles"));
  assert.ok(ordered);
  assert.match(ordered.sql, /ORDER BY p\.updated_at DESC, p\.user_id DESC/);
  assert.doesNotMatch(ordered.sql, /CASE/);
});

test("sort=deadline is 422 field sort", async () => {
  resetLimits();
  const res = await handle(get("/api/v1/search?type=postings&q=backend&sort=deadline"), env(), deps(authed([], async () => empty)));
  assert.equal(res.status, 422);
  const body = await codeOf(res);
  assert.equal(body.error.code, "VALIDATION_ERROR");
  assert.equal(body.error.details?.field, "sort");
});

test("relevance cursor with sort=latest is 400 field cursor", async () => {
  resetLimits();
  const cursor = encodeCursor(NOW, POSTING_A, "relevance");
  const res = await handle(get("/api/v1/search?type=postings&q=backend&sort=latest&cursor=" + encodeURIComponent(cursor)), env(), deps(authed([], async () => empty)));
  assert.equal(res.status, 400);
  assert.equal((await codeOf(res)).error.details?.field, "cursor");
  resetLimits();
  const unmarked = encodeCursor(NOW, POSTING_A);
  const again = await handle(get("/api/v1/search?type=postings&q=backend&sort=latest&cursor=" + encodeURIComponent(unmarked)), env(), deps(authed([], async () => empty)));
  assert.equal(again.status, 400);
  assert.equal((await codeOf(again)).error.details?.field, "cursor");
  resetLimits();
  const latest = encodeCursor(NOW, POSTING_A, "latest");
  const back = await handle(get("/api/v1/search?type=postings&q=backend&cursor=" + encodeURIComponent(latest)), env(), deps(authed([], async () => empty)));
  assert.equal(back.status, 400);
  assert.equal((await codeOf(back)).error.details?.field, "cursor");
});

test("GET /api/v1/postings?sort=deadline still orders by deadline", async () => {
  resetLimits();
  const seen: Call[] = [];
  const res = await handle(get("/api/v1/postings?sort=deadline"), env(), deps(authed(seen, async () => empty)));
  assert.equal(res.status, 200);
  const ordered = seen.find((call) => call.sql.includes("ORDER BY") && call.sql.includes("job_postings"));
  assert.ok(ordered);
  assert.match(ordered.sql, /p\.deadline ASC NULLS LAST/);
});

test("guest people search stays 401", async () => {
  resetLimits();
  const res = await handle(get("/api/v1/search?type=people&q=ada&sort=latest", false), env(), deps(async (sql) => {
    if (sql.includes("rate_limits")) return { rows: [{ hits: 1 }], rowCount: 1 };
    return empty;
  }));
  assert.equal(res.status, 401);
  assert.equal((await codeOf(res)).error.code, "UNAUTHENTICATED");
});
