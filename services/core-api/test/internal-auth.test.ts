import assert from "node:assert/strict";
import { test } from "node:test";

import { actAsAllowed } from "../src/internal-auth.ts";
import { handle } from '../src/handler.ts';
import type { CoreEnv, Deps } from '../src/handler.ts';
import { resetLimits } from "../src/ratelimit.ts";

const jsonOf = async <T>(res: Response): Promise<T> => {
  const value: T = await res.json();
  return value;
};

const USER = "12345678-1234-5678-1234-567812345678";
const COMPANY = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OTHER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const NOW = "2026-10-21T00:00:00.000Z";
const SECRET = "internal-secret";

const env = (): CoreEnv => ({ APP_ENV: "production", INTERNAL_API_SECRET: SECRET });
const deps = (query: Deps["query"]): Deps => ({ query, now: () => new Date(NOW) });
type Row = Awaited<ReturnType<Deps["query"]>>["rows"][number];

const code = async (res: Response) => (await jsonOf<{ error?: { code: string } }>(res)).error?.code;

const emptyRows: Array<Row> = [];
const empty = { rows: emptyRows, rowCount: 0 };

const userRow = () => ({
  id: USER, display_name: "Ada", locale: "ko", plan: "PRO", subscription_status: "NONE",
  stripe_customer_id: null, period_ends_at: null, created_at: NOW, is_employer: false,
  email: "ada@push.app", provider: "email", company_id: COMPANY, company_role: "member",
});

const queryFor = (memberOf: string | null) => async (sql: string, params: Array<unknown> = []) => {
  if (sql.includes("rate_limits")) {return { rows: [{ hits: 1 }], rowCount: 1 };}
  if (sql.includes("SELECT 1") && sql.includes("company_members")) {
    return (memberOf !== null && memberOf !== undefined) && params[0] === USER && params[1] === memberOf ? { rows: [{ ok: 1 }], rowCount: 1 } : empty;
  }
  if (sql.includes("FROM users") && sql.includes("display_name")) {return { rows: [userRow()], rowCount: 1 };}
  if (sql.includes("count(*)")) {return { rows: [{ total: 0 }], rowCount: 1 };}
  return empty;
};

const bookmarks = (headers: Record<string, string>): Request => new Request("https://core.example/api/v1/me/bookmarks", { headers });

test("act-as with the internal secret reads bookmarks", async () => {
  resetLimits();
  const res = await handle(bookmarks({
    "x-push-internal-secret": SECRET,
    "x-push-act-as": USER,
  }), env(), deps(queryFor(null)));
  assert.equal(res.status, 200);
  const body = await jsonOf<{ data: Array<unknown> }>(res);
  assert.deepEqual(body.data, []);
});

test("a wrong internal secret is 401 and a non-member company is 403", async () => {
  resetLimits();
  const wrong = await handle(bookmarks({
    "x-push-internal-secret": "nope",
    "x-push-act-as": USER,
  }), env(), deps(queryFor(COMPANY)));
  assert.equal(wrong.status, 401);
  assert.equal((await jsonOf<{ error: { code: string } }>(wrong)).error.code, "UNAUTHORIZED");

  resetLimits();
  const missing = await handle(bookmarks({ "x-push-act-as": USER }), env(), deps(queryFor(COMPANY)));
  assert.equal(missing.status, 401);

  resetLimits();
  const other = await handle(bookmarks({
    "x-push-internal-secret": SECRET,
    "x-push-act-as": USER,
    "x-push-company": OTHER,
  }), env(), deps(queryFor(COMPANY)));
  assert.equal(other.status, 403);
  assert.equal((await jsonOf<{ error: { code: string } }>(other)).error.code, "FORBIDDEN");

  resetLimits();
  const none = await handle(bookmarks({
    "x-push-internal-secret": SECRET,
    "x-push-act-as": USER,
    "x-push-company": COMPANY,
  }), env(), deps(queryFor(null)));
  assert.equal(none.status, 403);
});

test("an unknown act-as user is 401 and a secret without act-as still needs a bearer", async () => {
  resetLimits();
  const unknown = await handle(bookmarks({
    "x-push-internal-secret": SECRET,
    "x-push-act-as": OTHER,
  }), env(), deps(async (sql) => {
    if (sql.includes("FROM users") && sql.includes("display_name")) {return empty;}
    if (sql.includes("rate_limits")) {return { rows: [{ hits: 1 }], rowCount: 1 };}
    return empty;
  }));
  assert.equal(unknown.status, 401);

  resetLimits();
  const secretOnly = await handle(bookmarks({ "x-push-internal-secret": SECRET }), env(), deps(async () => empty));
  assert.equal(secretOnly.status, 401);
  assert.equal((await jsonOf<{ error: { code: string } }>(secretOnly)).error.code, "UNAUTHENTICATED");
});

test("act-as cannot reach routes the ai tools never use", async () => {
  for (const [method, path] of [
    ["DELETE", "/api/v1/me"],
    ["POST", "/api/v1/billing/checkout"],
    ["PUT", "/api/v1/ai/keys/OPENAI"],
    ["DELETE", `/api/v1/companies/me/members/${OTHER}`],
    ["PATCH", "/api/v1/companies/me"],
    ["GET", "/api/v1/me/bookmarks/../../ai/keys"],
  ] as const) {
    resetLimits();
    const res = await handle(new Request(`https://core.example${path}`, {
      method,
      headers: { "x-push-internal-secret": SECRET, "x-push-act-as": USER },
    }), env(), deps(queryFor(null)));
    assert.equal(res.status, 403, `${method} ${path}`);
  }
});

test("act-as may apply chat edits to a document but not touch its other writes", () => {
  const doc = "12121212-1212-4212-8212-121212121212";
  assert.equal(actAsAllowed("POST", `/api/v1/documents/${doc}/edits`), true);
  assert.equal(actAsAllowed("GET", `/api/v1/documents/${doc}/edits`), false);
  for (const sub of ["finalize", "archive", "versions", "exports"]) {
    assert.equal(actAsAllowed("POST", `/api/v1/documents/${doc}/${sub}`), false, sub);
  }
});

test("act-as apply, offer accept and stage change need the approved card for that target", async () => {
  const posting = "21212121-2121-4121-8121-212121212121";
  const offer = "31313131-3131-4131-8131-313131313131";
  const application = "41414141-4141-4141-8141-414141414141";
  const approval = "51515151-5151-4151-8151-515151515151";
  const cases = [
    ["POST", `/api/v1/postings/${posting}/apply`, "apply_to_posting", { posting_id: posting }],
    ["POST", `/api/v1/me/offers/${offer}/accept`, "accept_offer", { offer_id: offer }],
    ["PATCH", `/api/v1/postings/${posting}/applicants/${application}`, "change_applicant_stage",
      { posting_id: posting, application_id: application, stage: "REJECTED" }],
  ] as const;
  for (const [method, path, tool, target] of cases) {
    const asked: Array<Array<unknown>> = [];
    const query = (approved: boolean) => async (sql: string, params: Array<unknown> = []) => {
      if (sql.includes("UPDATE approvals")) {
        asked.push(params);
        return approved ? { rows: [{ ok: 1 }], rowCount: 1 } : empty;
      }
      return queryFor(COMPANY)(sql, params);
    };
    const call = (headers: Record<string, string>, approved: boolean) => {
      resetLimits();
      return handle(new Request(`https://core.example${path}`, {
        method,
        headers: {
          "content-type": "application/json", "idempotency-key": "61616161-6161-4161-8161-616161616161",
          "x-push-internal-secret": SECRET, "x-push-act-as": USER, ...headers,
        },
        body: JSON.stringify(method === "PATCH" ? { stage: "REJECTED" } : {}),
      }), env(), deps(query(approved)));
    };

    const bare = await call({}, true);
    assert.equal(bare.status, 403, `${tool} without a card`);
    assert.equal(await code(bare), "APPROVAL_REQUIRED");
    assert.equal(asked.length, 0);

    const unapproved = await call({ "x-push-approval": approval }, false);
    assert.equal(unapproved.status, 403, `${tool} with a card that is not approved for this target`);
    assert.equal(await code(unapproved), "APPROVAL_REQUIRED");
    assert.deepEqual(asked[0], [approval, USER, tool, JSON.stringify(target), "61616161-6161-4161-8161-616161616161"]);

    const approved = await call({ "x-push-approval": approval }, true);
    assert.notEqual(await code(approved), "APPROVAL_REQUIRED", `${tool} with the approved card`);
  }
});

test("act-as writes outside the approval list need no card", async () => {
  resetLimits();
  const posting = "21212121-2121-4121-8121-212121212121";
  const asked: Array<string> = [];
  const res = await handle(new Request(`https://core.example/api/v1/postings/${posting}/bookmark`, {
    method: "POST",
    headers: { "idempotency-key": "71717171-7171-4171-8171-717171717171", "x-push-internal-secret": SECRET, "x-push-act-as": USER },
  }), env(), deps(async (sql, params) => {
    if (sql.includes("approvals")) {asked.push(sql);}
    return queryFor(null)(sql, params);
  }));
  assert.notEqual((await jsonOf<{ error?: { code: string } }>(res)).error?.code, "APPROVAL_REQUIRED");
  assert.deepEqual(asked, []);
});

test("an approval card is consumed once, and only the same idempotency key may retry it", async () => {
  const posting = "21212121-2121-4121-8121-212121212121";
  const approval = "51515151-5151-4151-8151-515151515151";
  const sqls: Array<string> = [];
  let consumedKey: unknown;
  let consumed = false;
  const query = async (sql: string, params: Array<unknown> = []) => {
    if (!sql.includes("UPDATE approvals")) {return queryFor(COMPANY)(sql, params);}
    sqls.push(sql);
    if (consumed && consumedKey !== params[4]) {return empty;}
    consumed = true;
    consumedKey = params[4];
    return { rows: [{ id: approval }], rowCount: 1 };
  };
  const apply = (key: string) => {
    resetLimits();
    return handle(new Request(`https://core.example/api/v1/postings/${posting}/apply`, {
      method: "POST",
      headers: {
        "content-type": "application/json", "idempotency-key": key,
        "x-push-internal-secret": SECRET, "x-push-act-as": USER, "x-push-approval": approval,
      },
      body: "{}",
    }), env(), deps(query));
  };
  const first = "61616161-6161-4161-8161-616161616161";
  assert.notEqual(await code(await apply(first)), "APPROVAL_REQUIRED");
  assert.notEqual(await code(await apply(first)), "APPROVAL_REQUIRED", "same key retries");
  assert.equal(await code(await apply("62626262-6262-4262-8262-626262626262")), "APPROVAL_REQUIRED", "replay with a new key");
  assert.match(sqls[0], /consumed_at IS NULL OR consumed_key = \$5::uuid/);
});

test("company act-as writes that reach people outside the company need the approved card", async () => {
  const posting = "21212121-2121-4121-8121-212121212121";
  const profile = "81818181-8181-4181-8181-818181818181";
  const approval = "51515151-5151-4151-8151-515151515151";
  const key = "61616161-6161-4161-8161-616161616161";
  const post = { category: "work", title: "채용 소식", body: "함께해요" };
  const cases = [
    ["PATCH", `/api/v1/postings/${posting}`, { status: "OPEN" }, "DRAFT", "publish_posting", { posting_id: posting }],
    ["PATCH", `/api/v1/postings/${posting}`, { title: "새 제목", expectedRevision: 3 }, "OPEN", "update_published_posting", { posting_id: posting, title: "새 제목", description: "" }],
    ["POST", `/api/v1/postings/${posting}/close`, {}, "OPEN", "close_posting", { posting_id: posting }],
    ["POST", `/api/v1/profiles/${profile}/offer`, { message: "커피챗 해요" }, "OPEN", "send_offer", { profile_id: profile, message: "커피챗 해요" }],
    ["POST", "/api/v1/posts", post, "OPEN", "create_company_post", post],
  ] as const;
  for (const [method, path, body, status, tool, target] of cases) {
    const asked: Array<Array<unknown>> = [];
    const query = (approved: boolean) => async (sql: string, params: Array<unknown> = []) => {
      if (sql.includes("UPDATE approvals")) {
        asked.push(params);
        return approved ? { rows: [{ ok: 1 }], rowCount: 1 } : empty;
      }
      if (sql.includes("SELECT status FROM job_postings")) {return { rows: [{ status }], rowCount: 1 };}
      return queryFor(COMPANY)(sql, params);
    };
    const call = (headers: Record<string, string>, approved: boolean) => {
      resetLimits();
      return handle(new Request(`https://core.example${path}`, {
        method,
        headers: {
          "content-type": "application/json", "idempotency-key": key,
          "x-push-internal-secret": SECRET, "x-push-act-as": USER, "x-push-company": COMPANY, ...headers,
        },
        body: JSON.stringify(body),
      }), env(), deps(query(approved)));
    };

    const bare = await call({}, true);
    assert.equal(await code(bare), "APPROVAL_REQUIRED", `${tool} without a card`);
    assert.equal(asked.length, 0);

    await call({ "x-push-approval": approval }, false);
    assert.deepEqual(asked[0], [approval, USER, tool, JSON.stringify(target), key]);

    const approved = await call({ "x-push-approval": approval }, true);
    assert.notEqual(await code(approved), "APPROVAL_REQUIRED", `${tool} with the approved card`);
  }
});

test("a company draft edit and personal offers and posts need no card", async () => {
  const posting = "21212121-2121-4121-8121-212121212121";
  const profile = "81818181-8181-4181-8181-818181818181";
  const cases = [
    [`/api/v1/postings/${posting}`, "PATCH", { title: "초안" }, { "x-push-company": COMPANY }],
    [`/api/v1/profiles/${profile}/offer`, "POST", { message: "커피챗 해요" }, {}],
    ["/api/v1/posts", "POST", { category: "daily", title: "안녕", body: "반가워요" }, {}],
  ] as const;
  for (const [path, method, body, headers] of cases) {
    resetLimits();
    const asked: Array<string> = [];
    const res = await handle(new Request(`https://core.example${path}`, {
      method,
      headers: {
        "content-type": "application/json", "idempotency-key": "71717171-7171-4171-8171-717171717171",
        "x-push-internal-secret": SECRET, "x-push-act-as": USER, ...headers,
      },
      body: JSON.stringify(body),
    }), env(), deps(async (sql, params) => {
      if (sql.includes("approvals")) {asked.push(sql);}
      if (sql.includes("SELECT status FROM job_postings")) {return { rows: [{ status: "DRAFT" }], rowCount: 1 };}
      return queryFor(COMPANY)(sql, params);
    }));
    assert.notEqual(await code(res), "APPROVAL_REQUIRED", `${method} ${path}`);
    assert.deepEqual(asked, [], `${method} ${path}`);
  }
});

test("a company write needs its card without x-push-company too, and a card binds the change it approved", async () => {
  const posting = "21212121-2121-4121-8121-212121212121";
  const profile = "81818181-8181-4181-8181-818181818181";
  const approval = "51515151-5151-4151-8151-515151515151";
  const consumed: Array<Array<unknown>> = [];
  const query = async (sql: string, params: Array<unknown> = []) => {
    if (sql.includes("UPDATE approvals")) {consumed.push(params); return empty;}
    if (sql.includes("SELECT status FROM job_postings")) {return { rows: [{ status: "OPEN" }], rowCount: 1 };}
    if (sql.includes("SELECT company_id FROM company_members")) {return { rows: [{ company_id: COMPANY }], rowCount: 1 };}
    return queryFor(null)(sql, params);
  };
  const call = (method: string, path: string, body: unknown) => {
    resetLimits();
    return handle(new Request(`https://core.example${path}`, {
      method,
      headers: {
        "content-type": "application/json", "idempotency-key": "61616161-6161-4161-8161-616161616161",
        "x-push-internal-secret": SECRET, "x-push-act-as": USER, "x-push-approval": approval,
      },
      body: JSON.stringify(body),
    }), env(), deps(query));
  };

  assert.equal(await code(await call("POST", `/api/v1/postings/${posting}/close`, {})), "APPROVAL_REQUIRED", "close with no company header");
  assert.equal(consumed.at(-1)?.[2], "close_posting");
  assert.equal(await code(await call("POST", `/api/v1/profiles/${profile}/offer`, { message: "안녕하세요" })), "APPROVAL_REQUIRED", "offer by a member with no header");
  assert.equal(consumed.at(-1)?.[2], "send_offer");

  const before = consumed.length;
  assert.equal(await code(await call("PATCH", `/api/v1/postings/${posting}`, { status: "DRAFT", expectedRevision: 3 })), "APPROVAL_REQUIRED", "a status other than OPEN");
  assert.equal(await code(await call("PATCH", `/api/v1/postings/${posting}`, { status: "OPEN", title: "몰래 바꾼 제목" })), "APPROVAL_REQUIRED", "publish that also edits");
  assert.equal(await code(await call("PATCH", `/api/v1/postings/${posting}`, { title: "새 제목", requirements: ["x"] })), "APPROVAL_REQUIRED", "live edit beyond title and description");
  assert.equal(consumed.length, before, "refused before any card is consumed");
});

test("the card check reads a tool_args stored as a JSON string", async () => {
  const posting = "21212121-2121-4121-8121-212121212121";
  let sqlSeen = "";
  resetLimits();
  await handle(new Request(`https://core.example/api/v1/postings/${posting}/close`, {
    method: "POST",
    headers: {
      "content-type": "application/json", "idempotency-key": "61616161-6161-4161-8161-616161616161",
      "x-push-internal-secret": SECRET, "x-push-act-as": USER, "x-push-company": COMPANY,
      "x-push-approval": "51515151-5151-4151-8151-515151515151",
    },
    body: "{}",
  }), env(), deps(async (sql, params = []) => {
    if (sql.includes("UPDATE approvals SET consumed_at")) {sqlSeen = sql; return empty;}
    if (sql.includes("SELECT status FROM job_postings")) {return { rows: [{ status: "OPEN" }], rowCount: 1 };}
    return queryFor(COMPANY)(sql, params);
  }));
  assert.match(sqlSeen, /CASE WHEN jsonb_typeof\(tool_args\) = 'string' THEN \(tool_args #>> '\{\}'\)::jsonb ELSE tool_args END\) @> \$4::jsonb/);
});

test("a card goes back only when its write surely did not happen", async () => {
  const posting = "21212121-2121-4121-8121-212121212121";
  const approval = "51515151-5151-4151-8151-515151515151";
  const key = "61616161-6161-4161-8161-616161616161";
  type Case = { fresh?: boolean; posting?: "missing" | "crash"; limited?: boolean; noUser?: boolean };
  const run = async (c: Case) => {
    const released: Array<Array<unknown>> = [];
    resetLimits();
    const res = await handle(new Request(`https://core.example/api/v1/postings/${posting}/close`, {
      method: "POST",
      headers: {
        "content-type": "application/json", "idempotency-key": key,
        "x-push-internal-secret": SECRET, "x-push-act-as": USER, "x-push-company": COMPANY, "x-push-approval": approval,
      },
      body: JSON.stringify({ expectedRevision: 1 }),
    }), env(), deps(async (sql, params = []) => {
      if (sql.includes("SET consumed_at = NULL")) {released.push(params); return empty;}
      if (sql.includes("UPDATE approvals")) {return { rows: [{ id: approval, fresh: c.fresh ?? true }], rowCount: 1 };}
      if (sql.includes("SELECT status FROM job_postings")) {return { rows: [{ status: "OPEN" }], rowCount: 1 };}
      if (sql.includes("rate_limits") && c.limited) {return { rows: [{ hits: 100_000 }], rowCount: 1 };}
      if (sql.includes("INSERT INTO idempotency_keys")) {return { rows: [{ id: "idem" }], rowCount: 1 };}
      if (sql.includes("FROM users") && sql.includes("display_name") && c.noUser) {return empty;}
      if (sql.includes("JOIN companies c ON c.id = m.company_id")) {return { rows: [{ id: COMPANY, name: "모아페이" }], rowCount: 1 };}
      if (sql.includes("SELECT id, revision, closed_at FROM job_postings")) {
        return c.posting === "missing" ? empty : { rows: [{ id: posting, revision: 1, closed_at: null }], rowCount: 1 };
      }
      if (c.posting === "crash" && sql.includes("UPDATE job_postings")) {throw new Error("db down after the write");}
      return queryFor(COMPANY)(sql, params);
    }));
    return { status: res.status, released };
  };
  const given = [[approval, key]];

  const missing = await run({ posting: "missing" });
  assert.equal(missing.status, 404, "the route refused the close before writing");
  assert.deepEqual(missing.released, given, "a 4xx gives the card back");

  const crashed = await run({ posting: "crash" });
  assert.ok(crashed.status >= 500, "a crash may come after a commit");
  assert.deepEqual(crashed.released, [], "so the card stays spent");

  const limited = await run({ limited: true });
  assert.equal(limited.status, 429);
  assert.deepEqual(limited.released, given, "a rate-limited call never ran the route");

  const unknown = await run({ noUser: true });
  assert.equal(unknown.status, 401);
  assert.deepEqual(unknown.released, given, "an act-as user that does not exist never ran the route");

  const replay = await run({ fresh: false, posting: "missing" });
  assert.deepEqual(replay.released, [], "a retry of an already spent card gives nothing back");
});

