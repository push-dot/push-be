import assert from "node:assert/strict";
import { test } from "node:test";

import { handle, type CoreEnv, type Deps } from "../src/handler.ts";
import { sha256Hex } from "../src/http.ts";
import { hashPassword } from "../src/mail/password.ts";
import { resetLimits } from "../src/ratelimit.ts";

const USER = "12345678-1234-5678-1234-567812345678";
const OTHER = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const COMPANY = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const NOW = new Date("2026-10-21T00:00:00Z");
const WEEK = new Date(NOW.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
const BNO = "1234567890";
const VERIFY = { bNo: BNO, startDt: "20200101", pNm: "김대표", bNm: "푸시" };
const VALIDATE_URL = "https://api.odcloud.kr/api/nts-businessman/v1/validate?serviceKey=" + encodeURIComponent("nts-key");
const STATUS_URL = "https://api.odcloud.kr/api/nts-businessman/v1/status?serviceKey=" + encodeURIComponent("nts-key");
const PHRASE = "개업 직후라면 1–2일 뒤 다시 시도해 주세요";

type Call = { sql: string; params: unknown[] };
type Err = { error: { code: string; message: string; details: { reason?: string } | null } };
type Company = {
  id: string;
  bNo: string;
  name: string;
  plan: string | null;
  verifiedAt: string | null;
  role: string;
  seats: { used: number; limit: number };
};
type Hit = { url: string; method: string; body: string; contentType: string | null };
type Mail = { to: string; subject: string; text: string; html: string };

const env = (extra: Partial<CoreEnv> = {}): CoreEnv => ({
  APP_ENV: "development",
  DEV_AUTH_TOKEN: "dev",
  DEV_USER_ID: USER,
  NTS_SERVICE_KEY: "nts-key",
  STRIPE_SECRET_KEY: "sk_test",
  APP_WEB_ORIGIN: "http://localhost:5174",
  ...extra,
});

const employer = (extra: Record<string, unknown> = {}) => ({
  id: USER,
  display_name: "Ada",
  locale: "ko",
  plan: "FREE",
  subscription_status: "NONE",
  stripe_customer_id: null,
  period_ends_at: null,
  created_at: NOW.toISOString(),
  is_employer: true,
  company_id: null,
  company_role: null,
  email: "ada@push.app",
  ...extra,
});

const gate = (seen: Call[], user: Record<string, unknown>, extra?: Deps["query"]): Deps["query"] =>
  async (sql, params = []) => {
    seen.push({ sql, params });
    if (sql.includes("rate_limits")) return { rows: [{ hits: 1 }], rowCount: 1 };
    if (sql.includes("idempotency_keys") && sql.includes("INSERT")) {
      return { rows: [{ id: "22222222-2222-4222-8222-222222222222" }], rowCount: 1 };
    }
    if (sql.includes("idempotency_keys")) return { rows: [], rowCount: 1 };
    if (sql.includes("FROM users WHERE id")) return { rows: [{ ...user }], rowCount: 1 };
    if (extra) return extra(sql, params);
    return { rows: [], rowCount: 0 };
  };

const deps = (
  query: Deps["query"],
  fetchImpl?: typeof fetch,
  mailer?: { send(mail: Mail): Promise<void> },
): Deps => ({ query, now: () => NOW, fetch: fetchImpl, mailer });

const post = (path: string, body: unknown, key: string): Request => new Request("https://core.example" + path, {
  method: "POST",
  headers: {
    authorization: "Bearer dev",
    "content-type": "application/json",
    "idempotency-key": key,
  },
  body: JSON.stringify(body),
});

const get = (path: string): Request => new Request("https://core.example" + path, {
  headers: { authorization: "Bearer dev" },
});

const bare = (path: string): Request => new Request("https://core.example" + path);

const del = (path: string): Request => new Request("https://core.example" + path, {
  method: "DELETE",
  headers: { authorization: "Bearer dev" },
});

const patch = (path: string, body: unknown): Request => new Request("https://core.example" + path, {
  method: "PATCH",
  headers: { authorization: "Bearer dev", "content-type": "application/json" },
  body: JSON.stringify(body),
});

const empty = { rows: [], rowCount: 0 };

const ntsFetch = (valid: string, code: string, mode: "ok" | "http" | "text" = "ok") => {
  const hits: Hit[] = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    hits.push({
      url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : "",
      contentType: new Headers(init?.headers).get("content-type"),
    });
    if (mode === "http") return Response.json({ status_code: "ERROR" }, { status: 500 });
    if (mode === "text") return new Response("nope", { status: 200, headers: { "content-type": "text/plain" } });
    if (url.includes("/validate")) {
      return Response.json({
        status_code: "OK",
        request_cnt: 1,
        valid_cnt: valid === "01" ? 1 : 0,
        data: [{
          b_no: BNO,
          valid,
          valid_msg: valid === "01" ? "확인되었습니다." : "확인할 수 없습니다.",
          request_param: { b_no: BNO, start_dt: "20200101", p_nm: "김대표", p_nm2: "", b_nm: "푸시", corp_no: "", b_type: "", b_sector: "" },
        }],
      });
    }
    const label = code === "01" ? "계속사업자" : code === "02" ? "휴업자" : code === "03" ? "폐업자" : "";
    return Response.json({
      request_cnt: 1,
      match_cnt: 1,
      status_code: "OK",
      data: [{
        b_no: BNO,
        b_stt: label,
        b_stt_cd: code,
        tax_type: "부가가치세 일반과세자",
        tax_type_cd: "01",
        end_dt: "",
        utcc_yn: "N",
        tax_type_change_dt: "",
        invoice_apply_dt: "",
        rbf_tax_type: "해당없음",
        rbf_tax_type_cd: "99",
      }],
    });
  };
  return { hits, fetchImpl: fetchImpl as typeof fetch };
};

const assertBusiness = async (res: Response, reason: string) => {
  assert.equal(res.status, 422);
  const body = await res.json() as Err;
  assert.equal(body.error.code, "BUSINESS_NOT_VERIFIED");
  assert.equal(body.error.details?.reason, reason);
  assert.equal(body.error.message.includes(PHRASE), true);
};

const seat = (plan: string | null, role: string, members: number, invites: number) => ({
  id: COMPANY,
  b_no: BNO,
  name: "푸시",
  plan,
  verified_at: NOW.toISOString(),
  role,
  member_count: members,
  invite_count: invites,
});

const undefinedColumn = (column: string): Error => {
  const err = new Error(`column "${column}" does not exist`) as Error & { code: string };
  err.code = "42703";
  return err;
};

const PROFILE = {
  logoKey: "logo.png",
  industry: "소프트웨어",
  website: "https://push.app",
  intro: "소개",
  representativeName: "김대표",
};

const profileRow = () => ({
  ...seat("PRO", "ADMIN", 0, 0),
  logo_key: PROFILE.logoKey,
  industry: PROFILE.industry,
  website: PROFILE.website,
  intro: PROFILE.intro,
  representative_name: PROFILE.representativeName,
});

test("verified NTS response creates a company the caller admins", async () => {
  resetLimits();
  const seen: Call[] = [];
  const { hits, fetchImpl } = ntsFetch("01", "01");
  let company: Call | undefined;
  let member: Call | undefined;
  const query = gate(seen, employer(), async (sql, params = []) => {
    if (sql.startsWith("INSERT INTO companies")) {
      company = { sql, params };
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("INSERT INTO company_members")) {
      member = { sql, params };
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("FROM company_members")) return empty;
    return empty;
  });
  const res = await handle(post("/api/v1/companies/verify", VERIFY, "11111111-1111-4111-8111-111111111111"), env(), deps(query, fetchImpl));
  assert.equal(res.status, 201);
  const body = await res.json() as { data: Company };
  assert.deepEqual(Object.keys(body.data), ["id", "bNo", "name", "plan", "verifiedAt", "role", "seats"]);
  assert.deepEqual(Object.keys(body.data.seats), ["used", "limit"]);
  assert.equal(body.data.bNo, BNO);
  assert.equal(body.data.name, "푸시");
  assert.equal(body.data.plan, null);
  assert.equal(body.data.verifiedAt, "2026-10-21T00:00:00Z");
  assert.equal(body.data.role, "ADMIN");
  assert.deepEqual(body.data.seats, { used: 0, limit: 0 });
  assert.notEqual(body.data.id, USER);
  assert.match(body.data.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(hits.length, 2);
  assert.equal(hits[0].url, VALIDATE_URL);
  assert.equal(hits[0].method, "POST");
  assert.equal(hits[0].contentType, "application/json");
  assert.deepEqual(JSON.parse(hits[0].body), { businesses: [{ b_no: BNO, start_dt: "20200101", p_nm: "김대표", b_nm: "푸시" }] });
  assert.equal(hits[1].url, STATUS_URL);
  assert.equal(hits[1].method, "POST");
  assert.deepEqual(JSON.parse(hits[1].body), { b_no: [BNO] });
  assert.ok(company);
  assert.equal(company.params[0], body.data.id);
  assert.equal(company.params.includes(BNO), true);
  assert.equal(company.params.includes("푸시"), true);
  assert.equal(company.params.includes(NOW.toISOString()), true);
  assert.equal(company.params.includes("BASIC"), false);
  assert.equal(company.params.includes("PRO"), false);
  assert.ok(member);
  assert.equal(member.params.includes(body.data.id), true);
  assert.equal(member.params.includes(USER), true);
  assert.equal(member.params.includes("ADMIN"), true);
});

test("NTS mismatch, suspended, closed, and unknown status are 422", async () => {
  const cases = [
    ["02", "01", "MISMATCH"],
    ["01", "02", "SUSPENDED"],
    ["01", "03", "CLOSED"],
    ["01", "99", "MISMATCH"],
  ] as const;
  for (const [valid, code, reason] of cases) {
    resetLimits();
    const seen: Call[] = [];
    const { fetchImpl } = ntsFetch(valid, code);
    const query = gate(seen, employer(), async (sql) => {
      if (sql.startsWith("INSERT INTO companies")) return { rows: [], rowCount: 1 };
      if (sql.includes("FROM company_members")) return empty;
      return empty;
    });
    const res = await handle(post("/api/v1/companies/verify", VERIFY, "11111111-1111-4111-8111-111111111112"), env(), deps(query, fetchImpl));
    await assertBusiness(res, reason);
    assert.equal(seen.some((call) => call.sql.startsWith("INSERT INTO companies")), false);
  }
});

test("a duplicate business number is 409 COMPANY_EXISTS", async () => {
  resetLimits();
  const seen: Call[] = [];
  const { hits, fetchImpl } = ntsFetch("01", "01");
  const query = gate(seen, employer(), async (sql) => {
    if (sql.startsWith("INSERT INTO companies")) {
      throw Object.assign(new Error('duplicate key value violates unique constraint "companies_b_no_idx"'), { code: "23505" });
    }
    if (sql.includes("FROM company_members")) return empty;
    return empty;
  });
  const res = await handle(post("/api/v1/companies/verify", VERIFY, "11111111-1111-4111-8111-111111111113"), env(), deps(query, fetchImpl));
  assert.equal(res.status, 409);
  assert.equal((await res.json() as Err).error.code, "COMPANY_EXISTS");
  assert.equal(hits.length, 2);
  assert.equal(seen.some((call) => call.sql.startsWith("INSERT INTO company_members")), false);
});

test("verify fills an unverified admin shell instead of creating another company", async () => {
  resetLimits();
  const seen: Call[] = [];
  const { hits, fetchImpl } = ntsFetch("01", "01");
  const query = gate(seen, employer(), async (sql) => {
    if (sql.includes("FROM company_members")) {
      return { rows: [{ company_id: USER, role: "ADMIN", verified_at: null }], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE companies")) return { rows: [{ id: USER }], rowCount: 1 };
    return empty;
  });
  const res = await handle(post("/api/v1/companies/verify", VERIFY, "11111111-1111-4111-8111-11111111111b"), env(), deps(query, fetchImpl));
  assert.equal(res.status, 201);
  const body = await res.json() as { data: Company };
  assert.equal(body.data.id, USER);
  assert.equal(body.data.bNo, BNO);
  assert.equal(body.data.role, "ADMIN");
  assert.equal(hits.length, 2);
  const update = seen.find((call) => call.sql.startsWith("UPDATE companies"));
  assert.ok(update);
  assert.equal(update.params[0], USER);
  assert.equal(update.params.includes(BNO), true);
  assert.equal(seen.some((call) => call.sql.startsWith("INSERT INTO companies")), false);
  assert.equal(seen.some((call) => call.sql.startsWith("INSERT INTO company_members")), false);
});

test("a caller who already belongs to a company gets 409 before NTS", async () => {
  resetLimits();
  const seen: Call[] = [];
  let called = false;
  const fetchImpl = (async () => {
    called = true;
    return Response.json({});
  }) as typeof fetch;
  const query = gate(seen, employer(), async (sql) => {
    if (sql.includes("FROM company_members")) {
      return { rows: [{ company_id: COMPANY, role: "ADMIN", verified_at: NOW.toISOString() }], rowCount: 1 };
    }
    return empty;
  });
  const res = await handle(post("/api/v1/companies/verify", VERIFY, "11111111-1111-4111-8111-111111111114"), env(), deps(query, fetchImpl));
  assert.equal(res.status, 409);
  assert.equal((await res.json() as Err).error.code, "CONFLICT");
  assert.equal(called, false);
  assert.equal(seen.some((call) => call.sql.startsWith("INSERT INTO companies")), false);
});

test("a personal account cannot verify a business", async () => {
  resetLimits();
  const seen: Call[] = [];
  let called = false;
  const fetchImpl = (async () => {
    called = true;
    return Response.json({});
  }) as typeof fetch;
  const res = await handle(
    post("/api/v1/companies/verify", VERIFY, "11111111-1111-4111-8111-111111111115"),
    env(),
    deps(gate(seen, employer({ is_employer: false })), fetchImpl),
  );
  assert.equal(res.status, 403);
  assert.equal((await res.json() as Err).error.code, "FORBIDDEN");
  assert.equal(called, false);
});

test("missing NTS key is 503 and does not call NTS", async () => {
  resetLimits();
  const seen: Call[] = [];
  let called = false;
  const fetchImpl = (async () => {
    called = true;
    return Response.json({});
  }) as typeof fetch;
  const query = gate(seen, employer(), async () => empty);
  const res = await handle(
    post("/api/v1/companies/verify", VERIFY, "11111111-1111-4111-8111-111111111116"),
    env({ NTS_SERVICE_KEY: "" }),
    deps(query, fetchImpl),
  );
  assert.equal(res.status, 503);
  assert.equal((await res.json() as Err).error.code, "NOT_CONFIGURED");
  assert.equal(called, false);
});

test("NTS http failure and non-JSON are 502", async () => {
  for (const mode of ["http", "text"] as const) {
    resetLimits();
    const seen: Call[] = [];
    const { fetchImpl } = ntsFetch("01", "01", mode);
    const query = gate(seen, employer(), async (sql) => {
      if (sql.includes("FROM company_members")) return empty;
      return empty;
    });
    const res = await handle(post("/api/v1/companies/verify", VERIFY, "11111111-1111-4111-8111-111111111117"), env(), deps(query, fetchImpl));
    assert.equal(res.status, 502);
    assert.equal((await res.json() as Err).error.code, "PROVIDER_ERROR");
    assert.equal(seen.some((call) => call.sql.startsWith("INSERT INTO companies")), false);
  }
});

test("GET /companies/me returns the membership and empty bNo", async () => {
  resetLimits();
  const seen: Call[] = [];
  const query = gate(seen, employer(), async (sql) => {
    if (sql.includes("AS member_count")) {
      return {
        rows: [{
          id: COMPANY,
          b_no: null,
          name: "백필",
          plan: null,
          verified_at: null,
          role: "ADMIN",
          member_count: 0,
          invite_count: 0,
        }],
        rowCount: 1,
      };
    }
    return empty;
  });
  const res = await handle(get("/api/v1/companies/me"), env(), deps(query));
  assert.equal(res.status, 200);
  const body = await res.json() as { data: Company };
  assert.deepEqual(Object.keys(body.data), ["id", "bNo", "name", "plan", "verifiedAt", "role", "seats"]);
  assert.equal(body.data.id, COMPANY);
  assert.equal(body.data.bNo, "");
  assert.equal(body.data.name, "백필");
  assert.equal(body.data.plan, null);
  assert.equal(body.data.verifiedAt, null);
  assert.equal(body.data.role, "ADMIN");
  assert.deepEqual(body.data.seats, { used: 0, limit: 0 });
});

test("GET /companies/me without a membership is 404", async () => {
  resetLimits();
  const seen: Call[] = [];
  const query = gate(seen, employer(), async () => empty);
  const res = await handle(get("/api/v1/companies/me"), env(), deps(query));
  assert.equal(res.status, 404);
  assert.equal((await res.json() as Err).error.code, "NOT_FOUND");
  assert.equal(seen.some((call) => call.sql.includes("AS member_count")), true);
});

test("GET /companies/me/members returns data for any member", async () => {
  resetLimits();
  const query = gate([], employer(), async (sql) => {
    if (sql.includes("u.email")) {
      return {
        rows: [
          { user_id: USER, email: "ada@push.app", display_name: "Ada", role: "ADMIN", created_at: NOW.toISOString() },
          { user_id: OTHER, email: "m@push.app", display_name: "Min", role: "MEMBER", created_at: "2026-10-20T00:00:00.000Z" },
        ],
        rowCount: 2,
      };
    }
    if (sql.includes("AS member_count")) return { rows: [seat("PRO", "MEMBER", 1, 0)], rowCount: 1 };
    return empty;
  });
  const res = await handle(get("/api/v1/companies/me/members"), env(), deps(query));
  assert.equal(res.status, 200);
  const body = await res.json() as { data: { userId: string; email: string; role: string; joinedAt: string }[] };
  assert.deepEqual(Object.keys(body), ["data"]);
  assert.deepEqual(body.data, [
    { userId: USER, email: "ada@push.app", displayName: "Ada", role: "ADMIN", joinedAt: "2026-10-21T00:00:00Z" },
    { userId: OTHER, email: "m@push.app", displayName: "Min", role: "MEMBER", joinedAt: "2026-10-20T00:00:00Z" },
  ]);
  assert.deepEqual(Object.keys(body.data[0]), ["userId", "email", "displayName", "role", "joinedAt"]);
});

test("BASIC and null plans cannot invite", async () => {
  for (const plan of [null, "BASIC"] as const) {
    resetLimits();
    const seen: Call[] = [];
    const query = gate(seen, employer(), async (sql) => {
      if (sql.includes("AS member_count")) return { rows: [seat(plan, "ADMIN", 0, 0)], rowCount: 1 };
      return empty;
    });
    const res = await handle(post("/api/v1/companies/me/invites", { email: "m@push.app" }, "11111111-1111-4111-8111-111111111118"), env(), deps(query));
    assert.equal(res.status, 403);
    assert.equal((await res.json() as Err).error.code, "SEAT_LIMIT");
    assert.equal(seen.some((call) => call.sql.startsWith("INSERT INTO company_invites")), false);
  }
});

test("PRO invite stores a hash and mails the raw token", async () => {
  resetLimits();
  const seen: Call[] = [];
  const sent: Mail[] = [];
  const mailer = { send: async (mail: Mail) => { sent.push(mail); } };
  const query = gate(seen, employer(), async (sql, params = []) => {
    if (sql.startsWith("INSERT INTO company_invites")) return { rows: [], rowCount: 1 };
    if (sql.includes("lower(") && sql.includes("email")) {
      assert.equal(params[1], "m@push.app");
      return empty;
    }
    if (sql.includes("AS member_count")) return { rows: [seat("PRO", "ADMIN", 1, 0)], rowCount: 1 };
    return empty;
  });
  const res = await handle(
    post("/api/v1/companies/me/invites", { email: "M@Push.app" }, "11111111-1111-4111-8111-111111111119"),
    env({ APP_WEB_ORIGIN: undefined, }),
    deps(query, undefined, mailer),
  );
  assert.equal(res.status, 201);
  assert.deepEqual(await res.json(), { data: { email: "m@push.app" } });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "m@push.app");
  assert.match(sent[0].text, /^http:\/\/localhost:5174\/invites\/[^/]+$/);
  const token = sent[0].text.slice("http://localhost:5174/invites/".length);
  const hash = await sha256Hex(token);
  const insert = seen.find((call) => call.sql.startsWith("INSERT INTO company_invites"));
  assert.ok(insert);
  assert.equal(insert.params.includes(hash), true);
  assert.equal(insert.params.includes(token), false);
  assert.equal(insert.params.includes("m@push.app"), true);
  assert.equal(insert.params.includes(WEEK), true);
  assert.match(insert.sql, /role = 'MEMBER'/);
  assert.match(insert.sql, /company_invites/);
  assert.equal(sent[0].html.includes(sent[0].text), true);
});

test("an invite insert that loses the seat check is SEAT_LIMIT", async () => {
  resetLimits();
  const seen: Call[] = [];
  const sent: Mail[] = [];
  const mailer = { send: async (mail: Mail) => { sent.push(mail); } };
  const query = gate(seen, employer(), async (sql) => {
    if (sql.startsWith("INSERT INTO company_invites")) return { rows: [], rowCount: 0 };
    if (sql.includes("lower(") && sql.includes("email")) return empty;
    if (sql.includes("AS member_count")) return { rows: [seat("PRO", "ADMIN", 0, 0)], rowCount: 1 };
    return empty;
  });
  const res = await handle(post("/api/v1/companies/me/invites", { email: "m@push.app" }, "11111111-1111-4111-8111-11111111111c"), env(), deps(query, undefined, mailer));
  assert.equal(res.status, 403);
  assert.equal((await res.json() as Err).error.code, "SEAT_LIMIT");
  assert.equal(sent.length, 0);
});

test("PRO at one member plus one open invite is SEAT_LIMIT", async () => {
  resetLimits();
  const seen: Call[] = [];
  const query = gate(seen, employer(), async (sql) => {
    if (sql.includes("AS member_count")) return { rows: [seat("PRO", "ADMIN", 1, 1)], rowCount: 1 };
    return empty;
  });
  const res = await handle(post("/api/v1/companies/me/invites", { email: "m@push.app" }, "11111111-1111-4111-8111-11111111111a"), env(), deps(query));
  assert.equal(res.status, 403);
  assert.equal((await res.json() as Err).error.code, "SEAT_LIMIT");
  assert.equal(seen.some((call) => call.sql.startsWith("INSERT INTO company_invites")), false);
});

test("ULTRA allows four seats and blocks the fifth open seat", async () => {
  resetLimits();
  const allowedSeen: Call[] = [];
  const sent: Mail[] = [];
  const allowed = gate(allowedSeen, employer(), async (sql) => {
    if (sql.startsWith("INSERT INTO company_invites")) return { rows: [], rowCount: 1 };
    if (sql.includes("lower(") && sql.includes("email")) return empty;
    if (sql.includes("AS member_count")) return { rows: [seat("ULTRA", "ADMIN", 2, 0)], rowCount: 1 };
    return empty;
  });
  const ok = await handle(
    post("/api/v1/companies/me/invites", { email: "m@push.app" }, "11111111-1111-4111-8111-11111111111b"),
    env(),
    deps(allowed, undefined, { send: async (mail) => { sent.push(mail); } }),
  );
  assert.equal(ok.status, 201);
  assert.equal(sent.length, 1);

  resetLimits();
  const blockedSeen: Call[] = [];
  const blocked = gate(blockedSeen, employer(), async (sql) => {
    if (sql.includes("AS member_count")) return { rows: [seat("ULTRA", "ADMIN", 4, 1)], rowCount: 1 };
    return empty;
  });
  const res = await handle(post("/api/v1/companies/me/invites", { email: "n@push.app" }, "11111111-1111-4111-8111-11111111111c"), env(), deps(blocked));
  assert.equal(res.status, 403);
  assert.equal((await res.json() as Err).error.code, "SEAT_LIMIT");
  assert.equal(blockedSeen.some((call) => call.sql.startsWith("INSERT INTO company_invites")), false);
});

test("a non-admin cannot invite", async () => {
  resetLimits();
  const seen: Call[] = [];
  const query = gate(seen, employer(), async (sql) => {
    if (sql.includes("AS member_count")) return { rows: [seat("PRO", "MEMBER", 0, 0)], rowCount: 1 };
    return empty;
  });
  const res = await handle(post("/api/v1/companies/me/invites", { email: "m@push.app" }, "11111111-1111-4111-8111-11111111111d"), env(), deps(query));
  assert.equal(res.status, 403);
  assert.equal((await res.json() as Err).error.code, "FORBIDDEN");
  assert.equal(seen.some((call) => call.sql.startsWith("INSERT INTO company_invites")), false);
});

test("a failed invite mail deletes the invite", async () => {
  resetLimits();
  const seen: Call[] = [];
  const mailer = { send: async () => { throw new Error("smtp down"); } };
  const query = gate(seen, employer(), async (sql) => {
    if (sql.startsWith("INSERT INTO company_invites") || sql.startsWith("DELETE FROM company_invites")) return { rows: [], rowCount: 1 };
    if (sql.includes("lower(") && sql.includes("email")) return empty;
    if (sql.includes("AS member_count")) return { rows: [seat("PRO", "ADMIN", 0, 0)], rowCount: 1 };
    return empty;
  });
  const res = await handle(post("/api/v1/companies/me/invites", { email: "m@push.app" }, "11111111-1111-4111-8111-11111111111e"), env(), deps(query, undefined, mailer));
  assert.equal(res.status, 502);
  assert.equal((await res.json() as Err).error.code, "PROVIDER_ERROR");
  const insert = seen.find((call) => call.sql.startsWith("INSERT INTO company_invites"));
  const removed = seen.find((call) => call.sql.startsWith("DELETE FROM company_invites"));
  assert.ok(insert);
  assert.ok(removed);
  assert.equal(removed.params[0], insert.params[0]);
});

test("inviting an existing member is 409", async () => {
  resetLimits();
  const seen: Call[] = [];
  const query = gate(seen, employer(), async (sql) => {
    if (sql.includes("lower(") && sql.includes("email")) return { rows: [{ user_id: OTHER }], rowCount: 1 };
    if (sql.includes("AS member_count")) return { rows: [seat("PRO", "ADMIN", 0, 0)], rowCount: 1 };
    return empty;
  });
  const res = await handle(post("/api/v1/companies/me/invites", { email: "m@push.app" }, "11111111-1111-4111-8111-11111111111f"), env(), deps(query));
  assert.equal(res.status, 409);
  assert.equal((await res.json() as Err).error.code, "CONFLICT");
  assert.equal(seen.some((call) => call.sql.startsWith("INSERT INTO company_invites")), false);
});

test("accepting an unknown or expired token is 404", async () => {
  resetLimits();
  const seen: Call[] = [];
  const missing = gate(seen, employer(), async (sql) => {
    if (sql.includes("FROM company_invites")) return empty;
    return empty;
  });
  const unknown = await handle(post("/api/v1/companies/invites/missing-token/accept", {}, "33333333-3333-4333-8333-333333333331"), env(), deps(missing));
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json() as Err).error.code, "NOT_FOUND");
  assert.equal(seen.some((call) => call.sql.includes("FROM company_invites")), true);

  resetLimits();
  const staleSeen: Call[] = [];
  const stale = gate(staleSeen, employer(), async (sql) => {
    if (sql.includes("FROM company_invites")) {
      return { rows: [{ id: "inv", company_id: COMPANY, email: "ada@push.app", expires_at: "2020-01-01T00:00:00.000Z", accepted_at: null }], rowCount: 1 };
    }
    return empty;
  });
  const expired = await handle(post("/api/v1/companies/invites/old-token/accept", {}, "33333333-3333-4333-8333-333333333332"), env(), deps(stale));
  assert.equal(expired.status, 404);
  assert.equal((await expired.json() as Err).error.code, "NOT_FOUND");
  assert.equal(staleSeen.some((call) => call.sql.includes("FROM company_invites")), true);
  assert.equal(staleSeen.some((call) => call.sql.startsWith("INSERT INTO company_members")), false);
});

test("accept is 409 when the company is pending deletion", async () => {
  resetLimits();
  const seen: Call[] = [];
  const query = gate(seen, employer(), async (sql) => {
    if (sql.includes("FROM company_invites")) {
      return {
        rows: [{
          id: "inv", company_id: COMPANY, email: "ada@push.app",
          expires_at: "2099-01-01T00:00:00.000Z", accepted_at: null,
          deletion_requested_at: NOW.toISOString(),
        }],
        rowCount: 1,
      };
    }
    return empty;
  });
  const res = await handle(post("/api/v1/companies/invites/dying-token/accept", {}, "33333333-3333-4333-8333-33333333333a"), env(), deps(query));
  assert.equal(res.status, 409);
  assert.equal((await res.json() as Err).error.code, "CONFLICT");
  assert.equal(seen.some((call) => call.sql.startsWith("INSERT INTO company_members")), false);
});

test("accept is 409 when the caller is already in a company", async () => {
  resetLimits();
  const seen: Call[] = [];
  const token = "invite-token";
  const hash = await sha256Hex(token);
  const query = gate(seen, employer(), async (sql, params = []) => {
    if (sql.includes("FROM company_invites")) {
      assert.equal(params[0], hash);
      return { rows: [{ id: "inv", company_id: COMPANY, email: "ADA@push.app", expires_at: "2099-01-01T00:00:00.000Z", accepted_at: null }], rowCount: 1 };
    }
    if (sql.includes("FROM company_members")) return { rows: [{ company_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" }], rowCount: 1 };
    return empty;
  });
  const res = await handle(post(`/api/v1/companies/invites/${token}/accept`, {}, "33333333-3333-4333-8333-333333333333"), env(), deps(query));
  assert.equal(res.status, 409);
  assert.equal((await res.json() as Err).error.code, "CONFLICT");
  assert.equal(seen.some((call) => call.sql.startsWith("INSERT INTO company_members")), false);
});

test("accept joins as MEMBER when the email matches", async () => {
  resetLimits();
  const seen: Call[] = [];
  const query = gate(seen, employer(), async (sql) => {
    if (sql.includes("FROM company_invites") && sql.includes("token_hash")) {
      return { rows: [{ id: "inv", company_id: COMPANY, email: "ada@push.app", expires_at: "2099-01-01T00:00:00.000Z", accepted_at: null }], rowCount: 1 };
    }
    if (sql.startsWith("INSERT INTO company_members") || sql.includes("SET accepted_at")) return { rows: [], rowCount: 1 };
    if (sql.includes("FROM company_members")) return empty;
    return empty;
  });
  const res = await handle(post("/api/v1/companies/invites/fresh-token/accept", {}, "33333333-3333-4333-8333-333333333334"), env(), deps(query));
  assert.equal(res.status, 204);
  assert.equal(await res.text(), "");
  const insert = seen.find((call) => call.sql.startsWith("INSERT INTO company_members"));
  assert.ok(insert);
  assert.equal(insert.params.includes(COMPANY), true);
  assert.equal(insert.params.includes(USER), true);
  assert.equal(insert.params.includes("MEMBER"), true);
  const accepted = seen.find((call) => call.sql.includes("SET accepted_at"));
  assert.ok(accepted);
  assert.equal(accepted.params.includes("inv"), true);
  assert.equal(accepted.params.includes(NOW.toISOString()), true);
});

test("an already accepted invite is 409", async () => {
  resetLimits();
  const seen: Call[] = [];
  const query = gate(seen, employer(), async (sql) => {
    if (sql.includes("FROM company_invites")) {
      return { rows: [{ id: "inv", company_id: COMPANY, email: "ada@push.app", expires_at: "2020-01-01T00:00:00.000Z", accepted_at: NOW.toISOString() }], rowCount: 1 };
    }
    return empty;
  });
  const res = await handle(post("/api/v1/companies/invites/used-token/accept", {}, "33333333-3333-4333-8333-333333333336"), env(), deps(query));
  assert.equal(res.status, 409);
  assert.equal((await res.json() as Err).error.code, "CONFLICT");
  assert.equal(seen.some((call) => call.sql.startsWith("INSERT INTO company_members")), false);
});

test("accept rejects an invite sent to a different email", async () => {
  resetLimits();
  const seen: Call[] = [];
  const query = gate(seen, employer(), async (sql) => {
    if (sql.includes("FROM company_invites")) {
      return { rows: [{ id: "inv", company_id: COMPANY, email: "other@push.app", expires_at: "2099-01-01T00:00:00.000Z", accepted_at: null }], rowCount: 1 };
    }
    return empty;
  });
  const res = await handle(post("/api/v1/companies/invites/other-token/accept", {}, "33333333-3333-4333-8333-333333333337"), env(), deps(query));
  assert.equal(res.status, 403);
  assert.equal((await res.json() as Err).error.code, "FORBIDDEN");
  assert.equal(seen.some((call) => call.sql.startsWith("INSERT INTO company_members")), false);
});

test("a personal account cannot accept an invite", async () => {
  resetLimits();
  const seen: Call[] = [];
  const res = await handle(
    post("/api/v1/companies/invites/tok/accept", {}, "33333333-3333-4333-8333-333333333335"),
    env(),
    deps(gate(seen, employer({ is_employer: false }))),
  );
  assert.equal(res.status, 403);
  assert.equal((await res.json() as Err).error.code, "FORBIDDEN");
  assert.equal(seen.some((call) => call.sql.includes("company_invites")), false);
});

test("transfer promotes the member and demotes the previous admin", async () => {
  resetLimits();
  const seen: Call[] = [];
  const query = gate(seen, employer(), async (sql) => {
    if (sql.includes("AS member_count")) return { rows: [seat("PRO", "ADMIN", 1, 0)], rowCount: 1 };
    if (sql.includes("FROM company_members") && sql.includes("user_id = $2")) return { rows: [{ user_id: OTHER, role: "MEMBER" }], rowCount: 1 };
    if (sql.includes("SET role = 'ADMIN'") || sql.includes("SET role = 'MEMBER'")) return { rows: [], rowCount: 1 };
    return empty;
  });
  const res = await handle(patch(`/api/v1/companies/me/members/${OTHER}`, { role: "ADMIN" }), env(), deps(query));
  assert.equal(res.status, 204);
  const promote = seen.find((call) => call.sql.includes("SET role = 'ADMIN'"));
  const demote = seen.find((call) => call.sql.includes("SET role = 'MEMBER'"));
  assert.ok(promote);
  assert.ok(demote);
  assert.equal(promote.params[0], COMPANY);
  assert.equal(promote.params[1], OTHER);
  assert.equal(demote.params[0], COMPANY);
  assert.match(demote.sql, /user_id <> \$2/);
  assert.match(demote.sql, /role = 'ADMIN'/);
  assert.equal(demote.params[1], OTHER);
});

test("transfer rejects a non-admin role", async () => {
  resetLimits();
  const seen: Call[] = [];
  const query = gate(seen, employer(), async (sql) => {
    if (sql.includes("AS member_count")) return { rows: [seat("PRO", "ADMIN", 1, 0)], rowCount: 1 };
    return empty;
  });
  const res = await handle(patch(`/api/v1/companies/me/members/${OTHER}`, { role: "MEMBER" }), env(), deps(query));
  assert.equal(res.status, 400);
  assert.equal((await res.json() as Err).error.code, "VALIDATION_ERROR");
  assert.equal(seen.some((call) => call.sql.includes("SET role")), false);
});

test("removing the last admin is 409 and removing a member is 204", async () => {
  resetLimits();
  const blockedSeen: Call[] = [];
  const blocked = gate(blockedSeen, employer(), async (sql) => {
    if (sql.includes("AS admins")) return { rows: [{ admins: 1 }], rowCount: 1 };
    if (sql.includes("AS member_count")) return { rows: [seat("PRO", "ADMIN", 1, 0)], rowCount: 1 };
    if (sql.includes("user_id = $2")) return { rows: [{ role: "ADMIN" }], rowCount: 1 };
    return empty;
  });
  const denied = await handle(del(`/api/v1/companies/me/members/${USER}`), env(), deps(blocked));
  assert.equal(denied.status, 409);
  assert.equal((await denied.json() as Err).error.code, "CONFLICT");
  assert.equal(blockedSeen.some((call) => call.sql.startsWith("DELETE FROM company_members")), false);

  resetLimits();
  const seen: Call[] = [];
  const query = gate(seen, employer(), async (sql, params = []) => {
    if (sql.startsWith("DELETE FROM company_members")) {
      assert.deepEqual(params, [COMPANY, OTHER]);
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("AS member_count")) return { rows: [seat("PRO", "ADMIN", 1, 0)], rowCount: 1 };
    if (sql.includes("user_id = $2")) return { rows: [{ role: "MEMBER" }], rowCount: 1 };
    return empty;
  });
  const res = await handle(del(`/api/v1/companies/me/members/${OTHER}`), env(), deps(query));
  assert.equal(res.status, 204);
  assert.equal(seen.some((call) => call.sql.startsWith("DELETE FROM company_members")), true);
});

test("DELETE /me for an admin with other members does not mark deletion", async () => {
  resetLimits();
  const seen: Call[] = [];
  const stripe: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    stripe.push(`${init?.method ?? "GET"} ${String(input)}`);
    return Response.json({ data: [] });
  }) as typeof fetch;
  const query = gate(seen, employer({ stripe_customer_id: "cus_user" }), async (sql) => {
    if (sql.includes("AS others")) {
      return { rows: [{ role: "ADMIN", company_id: COMPANY, stripe_customer_id: "cus_co", others: 1 }], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  });
  const res = await handle(del("/api/v1/me"), env(), deps(query, fetchImpl));
  assert.equal(res.status, 409);
  assert.equal((await res.json() as Err).error.code, "ADMIN_TRANSFER_REQUIRED");
  assert.equal(seen.some((call) => call.sql.includes("deletion_requested_at")), false);
  assert.deepEqual(stripe, []);
});

test("sole admin delete cancels the company Stripe customer and marks the company", async () => {
  resetLimits();
  const seen: Call[] = [];
  const stripe: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    stripe.push(`${method} ${url}`);
    if (method === "GET") return Response.json({ data: [{ id: url.includes("cus_co") ? "sub_co" : "sub_user" }] });
    return Response.json({ id: "sub", status: "canceled" });
  }) as typeof fetch;
  const query = gate(seen, employer({ stripe_customer_id: "cus_user" }), async (sql) => {
    if (sql.includes("AS others")) {
      return { rows: [{ role: "ADMIN", company_id: COMPANY, stripe_customer_id: "cus_co", others: 0 }], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  });
  const res = await handle(del("/api/v1/me"), env(), deps(query, fetchImpl));
  assert.equal(res.status, 204);
  assert.deepEqual(stripe, [
    "GET https://api.stripe.com/v1/subscriptions?limit=100&customer=cus_user",
    "DELETE https://api.stripe.com/v1/subscriptions/sub_user",
    "GET https://api.stripe.com/v1/subscriptions?limit=100&customer=cus_co",
    "DELETE https://api.stripe.com/v1/subscriptions/sub_co",
  ]);
  assert.ok(seen.some((call) => call.sql.includes("UPDATE users SET deletion_requested_at = $2")));
  const company = seen.find((call) => call.sql.includes("UPDATE companies SET deletion_requested_at = $2"));
  assert.ok(company);
  assert.equal(company.params[0], COMPANY);
  assert.equal(company.params[1], NOW.toISOString());
  assert.ok(seen.some((call) => call.sql.includes("UPDATE refresh_tokens SET revoked_at")));
  assert.equal(seen.some((call) => call.sql.includes("FROM users WHERE id") && call.sql.includes("AS others")), false);
});

test("company Stripe failure undoes the user deletion mark", async () => {
  resetLimits();
  const seen: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("customer=cus_co")) return Response.json({ error: { message: "no" } }, { status: 500 });
    if ((init?.method ?? "GET") === "GET") return Response.json({ data: [{ id: "sub_user" }] });
    return Response.json({ id: "sub_user", status: "canceled" });
  }) as typeof fetch;
  const query = gate(seen, employer({ stripe_customer_id: "cus_user" }), async (sql) => {
    if (sql.includes("AS others")) {
      return { rows: [{ role: "ADMIN", company_id: COMPANY, stripe_customer_id: "cus_co", others: "0" }], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  });
  const res = await handle(del("/api/v1/me"), env(), deps(query, fetchImpl));
  assert.equal(res.status, 502);
  assert.equal((await res.json() as Err).error.code, "PROVIDER_ERROR");
  assert.ok(seen.some((call) => call.sql.includes("SET deletion_requested_at = NULL WHERE id = $1")));
  assert.equal(seen.some((call) => call.sql.includes("UPDATE companies SET deletion_requested_at")), false);
  assert.equal(seen.some((call) => call.sql.includes("UPDATE refresh_tokens SET revoked_at")), false);
});

test("email login clears the company deletion mark", async () => {
  resetLimits();
  const passwordHash = await hashPassword("secret123");
  const sqls: string[] = [];
  const query: Deps["query"] = async (sql) => {
    sqls.push(sql);
    if (sql.includes("rate_limits")) return { rows: [{ hits: 1 }], rowCount: 1 };
    if (sql.includes("deletion_requested_at")) return { rows: [], rowCount: 1 };
    if (sql.includes("FROM users") && sql.includes("lower(email)")) {
      return {
        rows: [{
          id: USER,
          password_hash: passwordHash,
          email_verified_at: NOW.toISOString(),
          is_employer: true,
          email: "ada@push.app",
        }],
        rowCount: 1,
      };
    }
    if (sql.includes("INSERT INTO refresh_tokens")) return { rows: [], rowCount: 1 };
    if (sql.includes("FROM users WHERE id")) return { rows: [employer()], rowCount: 1 };
    return empty;
  };
  const res = await handle(
    new Request("https://core.example/api/v1/auth/email/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "ada@push.app", password: "secret123" }),
    }),
    { APP_ENV: "production", MANAGED_AI: "1", MANAGED_GO: "0" },
    { query, now: () => NOW },
  );
  assert.equal(res.status, 200);
  assert.ok(sqls.some((sql) => sql.includes("UPDATE companies SET deletion_requested_at = NULL") && sql.includes("role = 'ADMIN'")));
});

test("admin PATCH sets company profile fields and GET returns logoUrl", async () => {
  resetLimits();
  const seen: Call[] = [];
  const query = gate(seen, employer(), async (sql) => {
    if (sql.startsWith("UPDATE companies")) return { rows: [], rowCount: 1 };
    if (sql.includes("AS member_count")) return { rows: [profileRow()], rowCount: 1 };
    return empty;
  });
  const res = await handle(patch("/api/v1/companies/me", PROFILE), env(), deps(query));
  assert.equal(res.status, 200);
  const expected = {
    id: COMPANY,
    bNo: BNO,
    name: "푸시",
    plan: "PRO",
    verifiedAt: "2026-10-21T00:00:00Z",
    role: "ADMIN",
    seats: { used: 0, limit: 2 },
    logoKey: PROFILE.logoKey,
    logoUrl: "/api/v1/uploads/images/" + encodeURIComponent(PROFILE.logoKey),
    industry: PROFILE.industry,
    website: PROFILE.website,
    intro: PROFILE.intro,
    representativeName: PROFILE.representativeName,
  };
  assert.deepEqual(await res.json(), { data: expected });
  const update = seen.find((call) => call.sql.startsWith("UPDATE companies"));
  assert.ok(update);
  assert.equal(update.params[0], COMPANY);
  for (const value of Object.values(PROFILE)) assert.equal(update.params.includes(value), true);
  assert.match(update.sql, /logo_key/);
  assert.match(update.sql, /representative_name/);
  assert.equal(update.sql.includes("b_no"), false);
  assert.equal(/\bname\s*=/.test(update.sql), false);
  assert.equal(update.sql.includes("verified_at"), false);
  const got = await handle(get("/api/v1/companies/me"), env(), deps(query));
  assert.equal(got.status, 200);
  assert.deepEqual(await got.json(), { data: expected });

  resetLimits();
  const memberSeen: Call[] = [];
  const member = gate(memberSeen, employer(), async (sql) => {
    if (sql.startsWith("UPDATE companies")) return { rows: [], rowCount: 1 };
    if (sql.includes("AS member_count")) return { rows: [seat("PRO", "MEMBER", 1, 0)], rowCount: 1 };
    return empty;
  });
  const denied = await handle(patch("/api/v1/companies/me", PROFILE), env(), deps(member));
  assert.equal(denied.status, 403);
  assert.equal((await denied.json() as Err).error.code, "FORBIDDEN");
  assert.equal(memberSeen.some((call) => call.sql.startsWith("UPDATE companies")), false);

  resetLimits();
  const badSeen: Call[] = [];
  const badQuery = gate(badSeen, employer(), async (sql) => {
    if (sql.startsWith("UPDATE companies")) return { rows: [], rowCount: 1 };
    if (sql.includes("AS member_count")) return { rows: [profileRow()], rowCount: 1 };
    return empty;
  });
  const bad = await handle(patch("/api/v1/companies/me", { bNo: BNO, name: "다른회사" }), env(), deps(badQuery));
  assert.equal(bad.status, 400);
  assert.equal((await bad.json() as Err).error.code, "VALIDATION_ERROR");
  assert.equal(badSeen.some((call) => call.sql.startsWith("UPDATE companies")), false);
});

test("GET /companies/me omits profile keys when the profile columns are missing", async () => {
  resetLimits();
  const seen: Call[] = [];
  let profileAttempts = 0;
  const query = gate(seen, employer(), async (sql) => {
    if (sql.includes("logo_key") || sql.includes("representative_name")) {
      profileAttempts += 1;
      throw undefinedColumn("logo_key");
    }
    if (sql.includes("AS member_count")) {
      return {
        rows: [{
          id: COMPANY,
          b_no: null,
          name: "백필",
          plan: null,
          verified_at: null,
          role: "ADMIN",
          member_count: 0,
          invite_count: 0,
        }],
        rowCount: 1,
      };
    }
    return empty;
  });
  const res = await handle(get("/api/v1/companies/me"), env(), deps(query));
  assert.equal(profileAttempts, 1);
  assert.equal(res.status, 200);
  const body = await res.json() as { data: Company };
  assert.deepEqual(Object.keys(body.data), ["id", "bNo", "name", "plan", "verifiedAt", "role", "seats"]);
  assert.equal(body.data.id, COMPANY);
  assert.equal(body.data.bNo, "");
  assert.equal(body.data.name, "백필");
  assert.equal(body.data.plan, null);
  assert.equal(body.data.verifiedAt, null);
  assert.equal(body.data.role, "ADMIN");
  assert.deepEqual(body.data.seats, { used: 0, limit: 0 });
  assert.equal(seen.some((call) => call.sql.includes("AS member_count") && !call.sql.includes("logo_key")), true);
});

test("GET /companies/me/invites returns pending invites for an admin only", async () => {
  resetLimits();
  const memberSeen: Call[] = [];
  const member = gate(memberSeen, employer(), async (sql) => {
    if (sql.includes("AS member_count")) return { rows: [seat("PRO", "MEMBER", 1, 0)], rowCount: 1 };
    return empty;
  });
  const denied = await handle(get("/api/v1/companies/me/invites"), env(), deps(member));
  assert.equal(denied.status, 403);
  assert.equal((await denied.json() as Err).error.code, "FORBIDDEN");
  assert.equal(memberSeen.some((call) => call.sql.includes("FROM company_invites") && !call.sql.includes("AS member_count")), false);

  resetLimits();
  const missing = await handle(get("/api/v1/companies/me/invites"), env(), deps(gate([], employer(), async () => empty)));
  assert.equal(missing.status, 404);
  assert.equal((await missing.json() as Err).error.code, "NOT_FOUND");

  resetLimits();
  const seen: Call[] = [];
  const query = gate(seen, employer(), async (sql) => {
    if (sql.includes("AS member_count")) return { rows: [seat("PRO", "ADMIN", 0, 1)], rowCount: 1 };
    if (sql.includes("FROM company_invites")) {
      return {
        rows: [
          { id: "i1", email: "a@push.app", expires_at: "2026-10-22T00:00:00.000Z", token: "raw-token", token_hash: "hash-1" },
          { id: "i2", email: "b@push.app", expires_at: "2026-10-28T00:00:00.000Z", token: "other-token", token_hash: "hash-2" },
        ],
        rowCount: 2,
      };
    }
    return empty;
  });
  const res = await handle(get("/api/v1/companies/me/invites"), env(), deps(query));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    data: [
      { id: "i1", email: "a@push.app", expiresAt: "2026-10-22T00:00:00Z" },
      { id: "i2", email: "b@push.app", expiresAt: "2026-10-28T00:00:00Z" },
    ],
  });
  const list = seen.find((call) => call.sql.includes("FROM company_invites") && !call.sql.includes("AS member_count"));
  assert.ok(list);
  assert.match(list.sql, /accepted_at IS NULL/);
  assert.match(list.sql, /expires_at > /);
  assert.match(list.sql, /ORDER BY expires_at ASC, id ASC/);
  assert.equal(list.sql.includes("token"), false);
  assert.equal(list.params[0], COMPANY);
  assert.equal(list.params[1], NOW.toISOString());
});

test("POST invite resends a pending invite and records the inviter on insert", async () => {
  resetLimits();
  const seen: Call[] = [];
  const sent: Mail[] = [];
  const pendingId = "iiiiiiii-iiii-4iii-8iii-iiiiiiiiiiii";
  const mailer = { send: async (mail: Mail) => { sent.push(mail); } };
  const query = gate(seen, employer(), async (sql) => {
    if (sql.startsWith("UPDATE company_invites")) {
      assert.equal(sent.length, 1);
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("INSERT INTO company_invites")) return { rows: [], rowCount: 1 };
    if (sql.includes("AS member_count")) return { rows: [seat("PRO", "ADMIN", 1, 1)], rowCount: 1 };
    if (sql.includes("FROM company_invites")) return { rows: [{ id: pendingId, email: "m@push.app" }], rowCount: 1 };
    if (sql.includes("lower(") && sql.includes("email")) return empty;
    return empty;
  });
  const res = await handle(
    post("/api/v1/companies/me/invites", { email: "M@Push.app" }, "11111111-1111-4111-8111-111111111201"),
    env(),
    deps(query, undefined, mailer),
  );
  assert.equal(res.status, 201);
  assert.deepEqual(await res.json(), { data: { email: "m@push.app" } });
  assert.equal(seen.some((call) => call.sql.startsWith("INSERT INTO company_invites")), false);
  assert.equal(sent.length, 1);
  const token = sent[0].text.slice("http://localhost:5174/invites/".length);
  const hash = await sha256Hex(token);
  const update = seen.find((call) => call.sql.startsWith("UPDATE company_invites"));
  assert.ok(update);
  assert.match(update.sql, /token_hash/);
  assert.match(update.sql, /inviter_user_id/);
  assert.equal(update.params.includes(pendingId), true);
  assert.equal(update.params.includes(hash), true);
  assert.equal(update.params.includes(token), false);
  assert.equal(update.params.includes(WEEK), true);
  assert.equal(update.params.includes(USER), true);

  resetLimits();
  const failSeen: Call[] = [];
  const failMail = { send: async () => { throw new Error("smtp down"); } };
  const failQuery = gate(failSeen, employer(), async (sql) => {
    if (sql.startsWith("UPDATE company_invites") || sql.startsWith("DELETE FROM company_invites")) return { rows: [], rowCount: 1 };
    if (sql.includes("AS member_count")) return { rows: [seat("PRO", "ADMIN", 1, 1)], rowCount: 1 };
    if (sql.includes("FROM company_invites")) return { rows: [{ id: pendingId }], rowCount: 1 };
    if (sql.includes("lower(") && sql.includes("email")) return empty;
    return empty;
  });
  const failed = await handle(
    post("/api/v1/companies/me/invites", { email: "m@push.app" }, "11111111-1111-4111-8111-111111111202"),
    env(),
    deps(failQuery, undefined, failMail),
  );
  assert.equal(failed.status, 502);
  assert.equal((await failed.json() as Err).error.code, "PROVIDER_ERROR");
  assert.equal(failSeen.some((call) => call.sql.startsWith("UPDATE company_invites") || call.sql.startsWith("DELETE FROM company_invites")), false);

  resetLimits();
  const insertSeen: Call[] = [];
  const insertSent: Mail[] = [];
  const insertQuery = gate(insertSeen, employer(), async (sql) => {
    if (sql.startsWith("INSERT INTO company_invites")) return { rows: [], rowCount: 1 };
    if (sql.includes("AS member_count")) return { rows: [seat("PRO", "ADMIN", 0, 0)], rowCount: 1 };
    if (sql.includes("FROM company_invites")) return empty;
    if (sql.includes("lower(") && sql.includes("email")) return empty;
    return empty;
  });
  const created = await handle(
    post("/api/v1/companies/me/invites", { email: "new@push.app" }, "11111111-1111-4111-8111-111111111203"),
    env(),
    deps(insertQuery, undefined, { send: async (mail) => { insertSent.push(mail); } }),
  );
  assert.equal(created.status, 201);
  assert.deepEqual(await created.json(), { data: { email: "new@push.app" } });
  const insert = insertSeen.find((call) => call.sql.startsWith("INSERT INTO company_invites"));
  assert.ok(insert);
  assert.match(insert.sql, /inviter_user_id/);
  assert.equal(insert.params.includes(USER), true);
  assert.equal(insert.params.includes("new@push.app"), true);
  assert.equal(insert.params.includes(WEEK), true);
  const raw = insertSent[0].text.slice("http://localhost:5174/invites/".length);
  assert.equal(insert.params.includes(raw), false);
  assert.equal(insert.params.includes(await sha256Hex(raw)), true);

  resetLimits();
  const legacySeen: Call[] = [];
  const legacySent: Mail[] = [];
  const legacy = gate(legacySeen, employer(), async (sql) => {
    if (sql.startsWith("INSERT INTO company_invites") && sql.includes("inviter_user_id")) {
      assert.equal(legacySent.length, 0);
      throw undefinedColumn("inviter_user_id");
    }
    if (sql.startsWith("INSERT INTO company_invites")) return { rows: [], rowCount: 1 };
    if (sql.includes("AS member_count")) return { rows: [seat("PRO", "ADMIN", 0, 0)], rowCount: 1 };
    if (sql.includes("FROM company_invites")) return empty;
    if (sql.includes("lower(") && sql.includes("email")) return empty;
    return empty;
  });
  const legacyRes = await handle(
    post("/api/v1/companies/me/invites", { email: "old@push.app" }, "11111111-1111-4111-8111-111111111204"),
    env(),
    deps(legacy, undefined, { send: async (mail) => { legacySent.push(mail); } }),
  );
  assert.equal(legacyRes.status, 201);
  const inserts = legacySeen.filter((call) => call.sql.startsWith("INSERT INTO company_invites"));
  assert.equal(inserts.length, 2);
  assert.match(inserts[0].sql, /inviter_user_id/);
  assert.equal(inserts[1].sql.includes("inviter_user_id"), false);
  assert.equal(inserts[1].params.includes(USER), false);
  assert.equal(legacySent.length, 1);
});

test("GET /companies/invites/{token} previews the invite without accepting it", async () => {
  const token = "preview-token";
  const hash = await sha256Hex(token);
  const inviteRow = {
    id: "inv",
    company_id: COMPANY,
    email: "m@push.app",
    expires_at: "2026-11-01T00:00:00.000Z",
    accepted_at: null,
    deletion_requested_at: null,
    company_name: "푸시",
  };
  const previewQuery = (
    seen: Call[],
    row: Record<string, unknown> | null,
    inviter: Record<string, unknown> | null,
    expectedHash = hash,
  ): Deps["query"] => gate(seen, employer(), async (sql, params = []) => {
    if (sql.includes("token_hash")) {
      assert.equal(params[0], expectedHash);
      return row ? { rows: [row], rowCount: 1 } : empty;
    }
    if (sql.includes("m.user_id = $2")) return inviter ? { rows: [inviter], rowCount: 1 } : empty;
    if (sql.includes("m.role = 'ADMIN'") && sql.includes("display_name")) {
      return { rows: [{ display_name: "Ada", role: "ADMIN" }], rowCount: 1 };
    }
    return empty;
  });

  resetLimits();
  const seen: Call[] = [];
  const res = await handle(bare(`/api/v1/companies/invites/${token}`), env(), deps(previewQuery(seen, {
    ...inviteRow,
    inviter_user_id: OTHER,
  }, { display_name: "민수", role: "MEMBER" })));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    data: {
      companyName: "푸시",
      inviterName: "민수",
      inviterRole: "MEMBER",
      email: "m@push.app",
      expiresAt: "2026-11-01T00:00:00Z",
    },
  });
  assert.equal(seen.some((call) => call.sql.includes("SET accepted_at")), false);
  assert.equal(seen.some((call) => call.sql.startsWith("UPDATE")), false);

  resetLimits();
  const nullSeen: Call[] = [];
  const nullRes = await handle(bare(`/api/v1/companies/invites/${token}`), env(), deps(previewQuery(nullSeen, {
    ...inviteRow,
    inviter_user_id: null,
  }, null)));
  assert.equal(nullRes.status, 200);
  assert.deepEqual(await nullRes.json(), {
    data: {
      companyName: "푸시",
      inviterName: "Ada",
      inviterRole: "ADMIN",
      email: "m@push.app",
      expiresAt: "2026-11-01T00:00:00Z",
    },
  });
  const adminSql = nullSeen.find((call) => call.sql.includes("m.role = 'ADMIN'") && call.sql.includes("display_name"));
  assert.ok(adminSql);
  assert.match(adminSql.sql, /ORDER BY m\.created_at ASC, m\.user_id ASC/);
  assert.equal(nullSeen.some((call) => call.sql.startsWith("UPDATE")), false);

  resetLimits();
  const unknown = await handle(
    bare("/api/v1/companies/invites/missing-token"),
    env(),
    deps(previewQuery([], null, null, await sha256Hex("missing-token"))),
  );
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json() as Err).error.code, "NOT_FOUND");
});

test("RESEND_API_KEY uses the invite token as the idempotency key", async () => {
  resetLimits();
  const seen: Call[] = [];
  const calls: { input: RequestInfo | URL; init?: RequestInit }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input, init });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const query = gate(seen, employer(), async (sql) => {
    if (sql.startsWith("INSERT INTO company_invites")) return { rows: [], rowCount: 1 };
    if (sql.includes("lower(") && sql.includes("email")) return empty;
    if (sql.includes("AS member_count")) return { rows: [seat("PRO", "ADMIN", 0, 0)], rowCount: 1 };
    return empty;
  });
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("live fetch");
  }) as typeof fetch;
  try {
    const res = await handle(
      post("/api/v1/companies/me/invites", { email: "m@push.app" }, "11111111-1111-4111-8111-111111111121"),
      env({ RESEND_API_KEY: "re_invite_secret", MAIL_FROM: "Push <no-reply@push.app>" }),
      deps(query, fetchImpl),
    );
    assert.equal(res.status, 201);
    assert.equal(calls.length, 1);
    const request = calls[0].input instanceof Request ? calls[0].input : new Request(calls[0].input, calls[0].init);
    const body = await request.json() as { from: string; to: string; text: string };
    assert.equal(request.url, "https://api.resend.com/emails");
    assert.equal(request.headers.get("authorization"), "Bearer re_invite_secret");
    assert.equal(body.from, "Push <no-reply@push.app>");
    assert.equal(body.to, "m@push.app");
    assert.match(body.text, /^http:\/\/localhost:5174\/invites\/[^/]+$/);
    assert.equal(request.headers.get("idempotency-key"), body.text.slice("http://localhost:5174/invites/".length));
  } finally {
    globalThis.fetch = original;
  }
});
