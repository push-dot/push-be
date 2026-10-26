import assert from "node:assert/strict";
import { test } from "node:test";

import { handle, type CoreEnv, type Deps } from "../src/handler.ts";
import { resetLimits } from "../src/ratelimit.ts";

const USER = "12345678-1234-5678-1234-567812345678";
const POSTING = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const APP = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const SOURCE = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const FILE = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const NOW = "2026-10-21T00:00:00.000Z";
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46]);

type Call = { sql: string; params: unknown[] };

const env = (): CoreEnv => ({ APP_ENV: "production", MANAGED_AI: "1", MANAGED_GO: "0" });
const deps = (query: Deps["query"]): Deps => ({ query, now: () => new Date(NOW) });

const authed = (seen: Call[], employer: boolean, extra: Deps["query"]): Deps["query"] => async (sql, params = []) => {
  seen.push({ sql, params });
  if (sql.includes("rate_limits")) return { rows: [{ hits: 1 }], rowCount: 1 };
  if (sql.includes("access_tokens")) {
    return {
      rows: [{
        id: USER, display_name: "Ada", locale: "ko", plan: "FREE", subscription_status: "NONE",
        created_at: NOW, token_expires_at: "2099-01-01T00:00:00Z", is_employer: employer,
      }],
      rowCount: 1,
    };
  }
  if (sql.includes("idempotency_keys") && sql.includes("INSERT")) {
    return { rows: [{ id: "11111111-1111-4111-8111-111111111111" }], rowCount: 1 };
  }
  if (sql.includes("idempotency_keys")) return { rows: [], rowCount: 0 };
  if (sql.includes("is_employer") && sql.includes("FROM users") && !sql.includes("access_tokens")) {
    return { rows: [{ is_employer: employer, display_name: "Ada" }], rowCount: 1 };
  }
  return extra(sql, params);
};

const empty = { rows: [] as Record<string, unknown>[], rowCount: 0 };

const post = (path: string, body: unknown, key: string): Request => new Request("https://core.example" + path, {
  method: "POST",
  headers: {
    authorization: "Bearer secret-token",
    "content-type": "application/json",
    "idempotency-key": key,
  },
  body: JSON.stringify(body),
});

test("apply snapshots an owned source and a member can stream that file", async () => {
  resetLimits();
  const seen: Call[] = [];
  const res = await handle(
    post(`/api/v1/postings/${POSTING}/apply`, { documentIds: [], sourceIds: [SOURCE] }, "44444444-4444-4444-8444-444444444446"),
    env(),
    deps(authed(seen, false, async (sql) => {
      if (sql.includes("job_postings") && sql.includes("closed_at IS NULL") && !sql.includes("INSERT")) {
        return { rows: [{ company: "Acme", title: "Backend", description: "Build", requirements: [], deadline: null }], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO application_files")) return { rows: [{ id: APP }], rowCount: 1 };
      if (sql.startsWith("SELECT id FROM sources")) return { rows: [{ id: SOURCE }], rowCount: 1 };
      if (sql.includes("applications") && sql.includes("source_posting_id") && !sql.includes("INSERT")) return empty;
      if (sql.includes("FROM job_postings")) {
        return { rows: [{ company: "Acme", title: "Backend", description: "Build", requirements: [], deadline: null }], rowCount: 1 };
      }
      return empty;
    })),
  );
  assert.equal(res.status, 201);
  // The file is copied from sources inside Postgres; its bytes never pass through the Worker.
  const copied = seen.find((call) => call.sql.includes("INSERT INTO application_files"));
  assert.ok(copied);
  assert.match(copied.sql, /JOIN sources s ON s\.id = r\.id::uuid AND s\.user_id = \$2/);
  assert.match(copied.sql, /s\.file_name.*s\.mime_type.*s\.size.*s\.page_count.*s\.path.*s\.content/s);
  assert.equal(copied.params.includes(JSON.stringify([SOURCE])), true);
  assert.equal(copied.params.includes(PDF), false);

  resetLimits();
  const streamSeen: Call[] = [];
  const stream = await handle(
    new Request(`https://core.example/api/v1/postings/${POSTING}/applicants/${APP}/files/${FILE}`, {
      headers: { authorization: "Bearer secret-token" },
    }),
    env(),
    deps(authed(streamSeen, true, async (sql) => {
      if (sql.includes("company_members")) return { rows: [{ id: POSTING }], rowCount: 1 };
      if (sql.includes("application_files")) {
        return { rows: [{ file_name: "resume.pdf", mime_type: "application/pdf", size: 4, content: PDF }], rowCount: 1 };
      }
      return empty;
    })),
  );
  assert.equal(stream.status, 200);
  assert.equal(stream.headers.get("content-type"), "application/pdf");
  assert.match(stream.headers.get("content-disposition") ?? "", /resume\.pdf/);
  assert.deepEqual(new Uint8Array(await stream.arrayBuffer()), PDF);

  resetLimits();
  const outsider = await handle(
    new Request(`https://core.example/api/v1/postings/${POSTING}/applicants/${APP}/files/${FILE}`, {
      headers: { authorization: "Bearer secret-token" },
    }),
    env(),
    deps(authed([], true, async () => empty)),
  );
  assert.equal(outsider.status, 404);
});

test("applicant list and detail add profile fields and document pages", async () => {
  resetLimits();
  const listed = await handle(
    new Request(`https://core.example/api/v1/postings/${POSTING}/applicants`, {
      headers: { authorization: "Bearer secret-token" },
    }),
    env(),
    deps(authed([], true, async (sql) => {
      if (sql.includes("company_members")) return { rows: [{ id: POSTING }], rowCount: 1 };
      if (sql.includes("FROM applications")) {
        return {
          rows: [{
            id: APP, stage: "APPLIED", applied_at: NOW, display_name: "Bea", headline: "Backend",
            job_category: "dev", tenure_years: 4, avatar_key: "avatars/bea.png",
            documents: [{ title: "resume.pdf", pages: 2 }],
          }],
          rowCount: 1,
        };
      }
      return empty;
    })),
  );
  assert.equal(listed.status, 200);
  const listBody = await listed.json() as { data: { applicant: { jobCategory: string; tenureYears: number; avatarUrl: string | null }; documents: { title: string; pages: number }[] }[] };
  assert.equal(listBody.data[0].applicant.jobCategory, "dev");
  assert.equal(listBody.data[0].applicant.tenureYears, 4);
  assert.equal(listBody.data[0].applicant.avatarUrl, "/api/v1/uploads/images/avatars%2Fbea.png");
  assert.deepEqual(listBody.data[0].documents, [{ title: "resume.pdf", pages: 2 }]);

  resetLimits();
  const detail = await handle(
    new Request(`https://core.example/api/v1/postings/${POSTING}/applicants/${APP}`, {
      headers: { authorization: "Bearer secret-token" },
    }),
    env(),
    deps(authed([], true, async (sql) => {
      if (sql.includes("company_members")) return { rows: [{ id: POSTING }], rowCount: 1 };
      if (sql.includes("application_snapshots")) return { rows: [], rowCount: 0 };
      if (sql.includes("FROM applications")) {
        return { rows: [{ id: APP, user_id: USER, revision: 1, job_id: "abababab-abab-4bab-8bab-abababababab", company: "Acme", title: "Backend", stage: "APPLIED", notes: "secret", applied_at: NOW, created_at: NOW, updated_at: NOW }], rowCount: 1 };
      }
      if (sql.includes("FROM users") && sql.includes("profiles")) {
        return {
          rows: [{
            display_name: "Bea", email: "bea@acme.com", headline: "Backend",
            careers: [{ company: "Acme" }], skills: ["Go"],
          }],
          rowCount: 1,
        };
      }
      return empty;
    })),
  );
  assert.equal(detail.status, 200);
  const detailBody = await detail.json() as { data: { applicant: { displayName: string; email: string; headline: string; careers: unknown[]; skills: string[] }; application: Record<string, unknown> } };
  assert.equal(Object.hasOwn(detailBody.data.application, "notes"), false);
  assert.deepEqual(detailBody.data.applicant, {
    displayName: "Bea",
    email: "bea@acme.com",
    headline: "Backend",
    careers: [{ company: "Acme" }],
    skills: ["Go"],
  });
});
