import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { recorder } from "../test-support/recorder.ts";

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
  const job = seen.find((call) => call.sql.includes("INSERT INTO ai_jobs"));
  assert.ok(job);
  assert.equal(job.params[0], body.data.jobId);
  assert.equal(job.params[1], "ingest");
  assert.equal(job.params[2], "q:ingest");
  assert.deepEqual(JSON.parse(String(job.params[7])), { sourceId: body.data.id });
  assert.equal(seen.some((call) => call.sql.includes("INSERT INTO credit_reservations")), false);
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
    if (sql.includes("FROM sources")) return [{ id: E1, file_name: "a", mime_type: "text/plain", size: 1, created_at: "2026-10-03T00:00:00Z" }].slice(0, limit);
    if (sql.includes("FROM documents")) return [{ id: E2, title: "d", created_at: "2026-10-04T00:00:00Z" }, { id: E3, title: "e", created_at: "2026-10-01T00:00:00Z" }].slice(0, limit);
    return null;
  });
  const res = await handle(new Request("https://core.example/api/v1/sources?limit=2", { headers: { authorization: "Bearer t" } }), ENV, { query, now: () => NOW });
  const body = await res.json() as { data: { id: string }[]; page: { hasMore: boolean } };
  assert.deepEqual(body.data.map((item) => item.id), [E2, E1]);
  assert.equal(body.page.hasMore, true);
  for (const c of calls.filter((x) => x.sql.includes("FROM sources") || x.sql.includes("FROM documents"))) assert.match(c.sql, /LIMIT \$2$/);
});
}

