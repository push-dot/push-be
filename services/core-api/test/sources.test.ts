import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { recorder, USER as RECORDER_USER } from "../test-support/recorder.ts";

import { handle, type CoreEnv, type Deps } from "../src/handler.ts";
import { resetLimits } from "../src/ratelimit.ts";

const USER = "12345678-1234-5678-1234-567812345678";
const KEY = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const NOW = new Date("2026-10-22T00:00:00Z");

type Call = { sql: string; params: unknown[] };

const env: CoreEnv = { APP_ENV: "production" };

const authRow = {
  id: USER, display_name: "Ada", locale: "ko", plan: "FREE",
  created_at: "2026-01-02T03:04:05Z", token_expires_at: "2099-01-01T00:00:00Z",
};

const deps = (seen: Call[]): Deps => ({
  now: () => NOW,
  query: async (sql, params = []) => {
    seen.push({ sql, params });
    if (sql.includes("access_tokens")) return { rows: [authRow], rowCount: 1 };
    if (sql.includes("rate_limits")) return { rows: [{ hits: 1 }], rowCount: 1 };
    if (sql.includes("idempotency_keys") && sql.includes("INSERT")) return { rows: [{ id: "idem" }], rowCount: 1 };
    if (sql.includes("count(*)")) return { rows: [{ n: 0 }], rowCount: 1 };
    if (sql.includes("INSERT INTO ai_jobs")) return { rows: [{ id: params[0], queue: params[2] }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  },
});

const upload = (file: File | null, kind: string | null = "RESUME") => {
  const form = new FormData();
  if (kind != null) form.set("kind", kind);
  if (file) form.set("file", file);
  return new Request("https://core.example/api/v1/sources", {
    method: "POST",
    headers: { authorization: "Bearer t", "idempotency-key": KEY },
    body: form,
  });
};

test("source upload stores the bytes in postgres and enqueues an ingest job", async () => {
  resetLimits();
  const seen: Call[] = [];
  const bytes = new TextEncoder().encode("hello resume");
  const res = await handle(upload(new File([bytes], "cv.txt", { type: "text/plain" })), env, deps(seen));
  assert.equal(res.status, 201);
  const body = await res.json() as { data: Record<string, unknown> };
  const sha = createHash("sha256").update(bytes).digest("hex");
  assert.deepEqual(Object.keys(body.data), ["id", "fileName", "mimeType", "size", "sha256", "status", "jobId"]);
  assert.equal(body.data.fileName, "cv.txt");
  assert.equal(body.data.mimeType, "text/plain");
  assert.equal(body.data.size, bytes.length);
  assert.equal(body.data.sha256, sha);
  assert.equal(body.data.status, "STORED");
  const insert = seen.find((call) => call.sql.includes("INSERT INTO sources"));
  assert.ok(insert);
  assert.equal(insert.params[0], body.data.id);
  assert.equal(insert.params[6], `db://sources/${body.data.id}`);
  assert.equal(insert.params[9], Buffer.from(bytes).toString("base64"));
  assert.equal(insert.params[10], "RESUME");
  assert.match(insert.sql, /doc_kind/);
  const job = seen.find((call) => call.sql.includes("INSERT INTO ai_jobs"));
  assert.ok(job);
  assert.equal(job.params[0], body.data.jobId);
  assert.equal(job.params[1], "ingest");
  assert.equal(job.params[2], "q:ingest");
  assert.deepEqual(JSON.parse(String(job.params[7])), { sourceId: body.data.id });
  assert.equal(seen.some((call) => call.sql.includes("INSERT INTO credit_reservations")), false);
});

test("source upload retries without doc_kind when the column is missing", async () => {
  resetLimits();
  const seen: Call[] = [];
  const missing = Object.assign(new Error('column "doc_kind" of relation "sources" does not exist'), { code: "42703" });
  const res = await handle(upload(new File(["hello"], "cv.txt", { type: "text/plain" }), "PORTFOLIO"), env, {
    now: () => NOW,
    query: async (sql, params = []) => {
      seen.push({ sql, params });
      if (sql.includes("access_tokens")) return { rows: [authRow], rowCount: 1 };
      if (sql.includes("rate_limits")) return { rows: [{ hits: 1 }], rowCount: 1 };
      if (sql.includes("idempotency_keys") && sql.includes("INSERT")) return { rows: [{ id: "idem" }], rowCount: 1 };
      if (sql.includes("INSERT INTO sources") && sql.includes("doc_kind")) throw missing;
      if (sql.includes("INSERT INTO ai_jobs")) return { rows: [{ id: params[0], queue: params[2] }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    },
  });
  assert.equal(res.status, 201);
  const inserts = seen.filter((call) => call.sql.includes("INSERT INTO sources"));
  assert.equal(inserts.length, 2);
  assert.equal(inserts[0].params[10], "PORTFOLIO");
  assert.equal(inserts[1].sql.includes("doc_kind"), false);
  assert.equal(inserts[1].params.length, 10);
});

test("source upload keeps the python validation errors", async () => {
  resetLimits();
  const noKind = await handle(upload(new File(["x"], "a.txt", { type: "text/plain" }), null), env, deps([]));
  assert.equal(noKind.status, 400);
  assert.deepEqual((await noKind.json() as { error: { details: unknown } }).error.details, { field: "kind" });
  resetLimits();
  const noFile = await handle(upload(null), env, deps([]));
  assert.deepEqual((await noFile.json() as { error: { details: unknown } }).error.details, { field: "file" });
  resetLimits();
  const image = await handle(upload(new File(["x"], "a.png", { type: "image/png" })), env, deps([]));
  const err = (await image.json() as { error: { code: string; message: string } }).error;
  assert.equal(image.status, 400);
  assert.equal(err.message, "unsupported file type image/png");
  resetLimits();
  const big = await handle(upload(new File([new Uint8Array((20 << 20) + 1)], "big.pdf", { type: "application/pdf" })), env, deps([]));
  assert.equal(big.status, 413);
  assert.equal((await big.json() as { error: { code: string } }).error.code, "PAYLOAD_TOO_LARGE");
});

{
const NOW = new Date("2026-10-21T00:00:00Z");
const ENV = { APP_ENV: "production" };
const E1 = "e0000000-0000-4000-8000-000000000001";
const E2 = "e0000000-0000-4000-8000-000000000002";
const E3 = "e0000000-0000-4000-8000-000000000003";
const E4 = "e0000000-0000-4000-8000-000000000004";

const path = "/api/v1/sources";
const limit = 20 << 20;
  test(`an upload to ${path} declaring more than the limit is refused with 413`, async () => {
    const { handle } = await import("../src/handler.ts");
    const { calls, query } = recorder();
    const request = new Request("https://core.example" + path, {
      method: "POST",
      headers: {
        authorization: "Bearer t", "idempotency-key": "00000000-0000-4000-8000-000000000001",
        "content-type": "multipart/form-data; boundary=x", "content-length": String(limit + (1 << 20)),
      },
      body: "--x--",
    });
    const res = await handle(request, ENV, { query, now: () => NOW });
    assert.equal(res.status, 413);
    assert.equal(calls.some((c) => c.sql.includes("INSERT INTO upload_images") || c.sql.includes("INSERT INTO sources")), false);
  });

test("deleting a source is one statement that unpins the profile resume instead of cascading the profile away", async () => {
  const { handle } = await import("../src/handler.ts");
  const SRC = "55555555-5555-4555-8555-555555555555";
  const { calls, query } = recorder((sql) => (sql.includes("DELETE FROM sources") ? [{ found: 1, used: 0, deleted: 1 }] : null));
  const res = await handle(new Request(`https://core.example/api/v1/sources/${SRC}`, { method: "DELETE", headers: { authorization: "Bearer t" } }),
    ENV, { query, now: () => NOW });
  assert.equal(res.status, 204);
  const writes = calls.filter((c) => !c.sql.includes("rate_limits") && !c.sql.includes("access_tokens"));
  assert.equal(writes.length, 1);
  assert.match(writes[0].sql, /UPDATE profiles SET resume_source_id = NULL/);
});

test("the source library reads one bounded page from each side and merges them", async () => {
  const { handle } = await import("../src/handler.ts");
  const { calls, query } = recorder((sql, params) => {
    const limit = Number(params.at(-1));
    if (sql.includes("FROM sources")) return [{ id: E1, file_name: "a", mime_type: "text/plain", size: 1, created_at: "2026-10-03T00:00:00Z", doc_kind: "PORTFOLIO" }].slice(0, limit);
    if (sql.includes("FROM documents")) return [{ id: E2, title: "d", created_at: "2026-10-04T00:00:00Z", kind: "HUB_PROFILE" }, { id: E3, title: "e", created_at: "2026-10-01T00:00:00Z" }].slice(0, limit);
    return null;
  });
  const res = await handle(new Request("https://core.example/api/v1/sources?limit=2", { headers: { authorization: "Bearer t" } }), ENV, { query, now: () => NOW });
  const body = await res.json() as { data: { id: string; kind: string | null }[]; page: { hasMore: boolean } };
  assert.deepEqual(body.data.map((item) => item.id), [E2, E1]);
  assert.deepEqual(body.data.map((item) => item.kind), ["HUB_PROFILE", "PORTFOLIO"]);
  assert.equal(body.page.hasMore, true);
  for (const c of calls.filter((x) => x.sql.includes("FROM sources") || x.sql.includes("FROM documents"))) assert.match(c.sql, /LIMIT \$2$/);
});

test("the source library hides markdown files", async () => {
  const { handle } = await import("../src/handler.ts");
  const { query } = recorder((sql) => {
    if (sql.includes("FROM sources")) return [
      { id: E1, file_name: "05_final_resume.md", mime_type: "text/markdown", size: 1, created_at: "2026-10-05T00:00:00Z" },
      { id: E2, file_name: "김서준_모아페이_백엔드.pdf", mime_type: "application/pdf", size: 2, created_at: "2026-10-04T00:00:00Z" },
      { id: E4, file_name: "notes.txt", mime_type: "text/markdown", size: 4, created_at: "2026-10-02T00:00:00Z" },
    ];
    if (sql.includes("FROM documents")) return [
      { id: E3, title: "notes.md", created_at: "2026-10-06T00:00:00Z" },
    ];
    return null;
  });
  const res = await handle(new Request("https://core.example/api/v1/sources?limit=10", { headers: { authorization: "Bearer t" } }), ENV, { query, now: () => NOW });
  const body = await res.json() as { data: { fileName: string }[] };
  assert.equal(res.status, 200);
  assert.deepEqual(body.data.map((item) => item.fileName), ["notes.md", "김서준_모아페이_백엔드.pdf"]);
});

test("the source library keeps a Push document with no mime type and drops a markdown source", async () => {
  const { handle } = await import("../src/handler.ts");
  const { query } = recorder((sql) => {
    if (sql.includes("FROM sources")) return [
      { id: E1, file_name: "05_final_resume.md", mime_type: "text/plain", size: 1, created_at: "2026-10-05T00:00:00Z" },
      { id: E2, file_name: null, mime_type: null, size: 2, created_at: "2026-10-04T00:00:00Z" },
    ];
    if (sql.includes("FROM documents")) return [
      { id: E3, title: "Push 이력서", created_at: "2026-10-06T00:00:00Z" },
    ];
    return null;
  });
  const res = await handle(new Request("https://core.example/api/v1/sources?limit=10", { headers: { authorization: "Bearer t" } }), ENV, { query, now: () => NOW });
  const body = await res.json() as { data: { id: string }[] };
  assert.equal(res.status, 200);
  assert.deepEqual(body.data.map((item) => item.id), [E3, E2]);
});


test("AI library rows carry the application's company and posting title from one joined query; uploads carry null", async () => {
  const { handle } = await import("../src/handler.ts");
  const { calls, query } = recorder((sql) => {
    if (sql.includes("FROM sources")) return [{ id: E1, file_name: "cv.pdf", mime_type: "application/pdf", size: 2, created_at: "2026-10-04T00:00:00Z" }];
    if (sql.includes("FROM documents")) return [
      { id: E2, title: "이력서", created_at: "2026-10-06T00:00:00Z", kind: "RESUME", company: "모아페이", posting_title: "백엔드 엔지니어 (Kotlin·Spring)" },
      { id: E3, title: "자소서", created_at: "2026-10-05T00:00:00Z", kind: "COVER_LETTER" },
    ];
    return null;
  });
  const res = await handle(new Request("https://core.example/api/v1/sources?limit=10", { headers: { authorization: "Bearer t" } }), ENV, { query, now: () => NOW });
  const body = await res.json() as { data: { id: string; company: string | null; postingTitle: string | null }[] };
  assert.deepEqual(body.data.map((i) => [i.id, i.company, i.postingTitle]),
    [[E2, "모아페이", "백엔드 엔지니어 (Kotlin·Spring)"], [E3, null, null], [E1, null, null]]);
  const docs = calls.filter((c) => c.sql.includes("FROM documents"));
  assert.equal(docs.length, 1);
  assert.match(docs[0].sql, /FROM documents d LEFT JOIN applications a ON a\.id = d\.application_id WHERE d\.user_id = \$1 ORDER BY d\.created_at DESC, d\.id DESC LIMIT \$2$/);
});

const patchSource = (id: string, body: unknown) => new Request(`https://core.example/api/v1/sources/${id}`, {
  method: "PATCH",
  headers: { authorization: "Bearer t", "content-type": "application/json", "idempotency-key": "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee" },
  body: JSON.stringify(body),
});

test("renaming a source trims the name, updates only the caller's upload and returns the library item", async () => {
  resetLimits();
  const { handle } = await import("../src/handler.ts");
  const { calls, query } = recorder((sql) => sql.startsWith("UPDATE sources SET file_name") ? [
    { id: E1, file_name: "김서준_이력서.pdf", mime_type: "application/pdf", size: 9, page_count: 2, origin: "UPLOAD", created_at: "2026-10-04T00:00:00Z", doc_kind: "RESUME" },
  ] : null);
  const res = await handle(patchSource(E1, { fileName: "  김서준_이력서.pdf  " }), ENV, { query, now: () => NOW });
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json() as { data: unknown }).data, {
    id: E1, fileName: "김서준_이력서.pdf", mimeType: "application/pdf", size: 9, pageCount: 2, createdAt: "2026-10-04T00:00:00Z",
    origin: "UPLOAD", kind: "RESUME", company: null, postingTitle: null,
  });
  const update = calls.find((c) => c.sql.startsWith("UPDATE sources SET file_name"))!;
  assert.match(update.sql, /WHERE id = \$1::uuid AND user_id = \$2 RETURNING/);
  assert.deepEqual(update.params, [E1, RECORDER_USER, "김서준_이력서.pdf"]);
});

test("renaming is 404 for an id that is not the caller's upload, including an AI document", async () => {
  resetLimits();
  const { handle } = await import("../src/handler.ts");
  const { calls, query } = recorder();
  const res = await handle(patchSource(E2, { fileName: "x.pdf" }), ENV, { query, now: () => NOW });
  assert.equal(res.status, 404);
  assert.equal(((await res.json()) as { error: { code: string } }).error.code, "NOT_FOUND");
  assert.equal(calls.some((c) => c.sql.includes("documents")), false);
});

test("renaming rejects a missing, blank, non-string or over-200-character name and writes nothing", async () => {
  const { handle } = await import("../src/handler.ts");
  for (const body of [{}, { fileName: "   " }, { fileName: 7 }, { fileName: "a".repeat(201) }]) {
    resetLimits();
    const { calls, query } = recorder();
    const res = await handle(patchSource(E1, body), ENV, { query, now: () => NOW });
    assert.equal(res.status, 400, JSON.stringify(body).slice(0, 30));
    const err = (await res.json() as { error: { code: string; details: unknown } }).error;
    assert.equal(err.code, "VALIDATION_ERROR");
    assert.deepEqual(err.details, { field: "fileName" });
    assert.equal(calls.some((c) => c.sql.startsWith("UPDATE sources")), false);
  }
});
}
