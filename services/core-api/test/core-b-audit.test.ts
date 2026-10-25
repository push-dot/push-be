import assert from "node:assert/strict";
import { test } from "node:test";

import type { Deps } from "../src/handler.ts";
import { HttpError } from "../src/http.ts";
import { pageOf } from "../src/page.ts";
import { encodeCursor } from "../src/time.ts";

type Call = { sql: string; params: unknown[] };

export const USER = "12345678-1234-4678-9234-567812345678";

export const recorder = (answer: (sql: string, params: unknown[]) => Record<string, unknown>[] | null = () => null) => {
  const calls: Call[] = [];
  const query: Deps["query"] = async (sql, params = []) => {
    calls.push({ sql, params });
    if (sql.includes("rate_limits")) return { rows: [{ hits: 1 }], rowCount: 1 };
    if (sql.includes("access_tokens")) {
      return {
        rows: [{
          id: USER, display_name: "Ada", locale: "ko", plan: "FREE", subscription_status: "NONE",
          created_at: "2026-01-02T03:04:05Z", token_expires_at: "2099-01-01T00:00:00Z",
        }],
        rowCount: 1,
      };
    }
    const rows = answer(sql, params) ?? [];
    return { rows, rowCount: rows.length };
  };
  return { calls, query };
};

const pageError = (url: string): HttpError => {
  try {
    pageOf(new URL(url));
  } catch (err) {
    if (err instanceof HttpError) return err;
    throw err;
  }
  throw new Error("expected a validation error");
};

test("a cursor whose id is not a UUID is a 400, not a database error", () => {
  const err = pageError("https://x/?cursor=" + encodeCursor("2026-10-01T00:00:00Z", "not-a-uuid"));
  assert.equal(err.status, 400);
  assert.deepEqual(err.details, { field: "cursor" });
});

test("a cursor id is normalized to the lowercase UUID", () => {
  const page = pageOf(new URL("https://x/?cursor=" + encodeCursor("2026-10-01T00:00:00Z", "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA")));
  assert.equal(page.cursor?.id, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
});

const NIL = "00000000-0000-0000-0000-000000000000";
const POSTING = "11111111-1111-4111-8111-111111111111";
const APP = "22222222-2222-4222-8222-222222222222";
const FILE = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2026-10-21T00:00:00Z");
const ENV = { APP_ENV: "production" };

const openPosting = { id: POSTING, company: "Acme", title: "BE", created_at: "2026-10-01T00:00:00Z", revision: 1, status: "OPEN" };

test("a guest can open a public posting without writing a view row for the nil user", async () => {
  const { handle } = await import("../src/handler.ts");
  const { calls, query } = recorder((sql) => {
    if (sql.includes("INSERT INTO posting_views")) throw Object.assign(new Error("insert or update on table \"posting_views\" violates foreign key constraint"), { code: "23503" });
    if (sql.includes("FROM job_postings p WHERE p.id = $1")) return [openPosting];
    return null;
  });
  const res = await handle(new Request(`https://core.example/api/v1/postings/${POSTING}`), ENV, { query, now: () => NOW });
  assert.equal(res.status, 200);
  assert.equal(calls.some((c) => c.sql.includes("posting_views") && c.params.includes(NIL)), false);
});

test("an applicant file with a Korean name downloads with an RFC 5987 filename", async () => {
  const { handle } = await import("../src/handler.ts");
  const { query } = recorder((sql) => {
    if (sql.includes("JOIN company_members m")) return [{ id: POSTING }];
    if (sql.includes("FROM application_files f")) return [{ file_name: "이력서 \"최종\".pdf", mime_type: "application/pdf", content: "\\x255044" }];
    return null;
  });
  const res = await handle(new Request(`https://core.example/api/v1/postings/${POSTING}/applicants/${APP}/files/${FILE}`, {
    headers: { authorization: "Bearer t" },
  }), ENV, { query, now: () => NOW });
  assert.equal(res.status, 200);
  const disposition = res.headers.get("content-disposition") ?? "";
  assert.match(disposition, /^attachment; filename="[\x20-\x7e]*"; filename\*=UTF-8''/);
  assert.ok(disposition.includes(encodeURIComponent("이력서")));
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual([...new Uint8Array(await res.arrayBuffer())], [0x25, 0x50, 0x44]);
});

test("the in-memory rate limit fallback drops buckets from past minutes", async () => {
  const { allow, memoryBuckets, resetLimits } = await import("../src/ratelimit.ts");
  resetLimits();
  const down: Deps["query"] = async () => { throw new Error("connection reset"); };
  const t0 = Date.parse("2026-10-22T00:00:30Z");
  for (let i = 0; i < 50; i += 1) await allow(down, "ip", "10.0.0." + i, 60, t0);
  assert.equal(memoryBuckets(), 50);
  await allow(down, "ip", "10.0.0.1", 60, t0 + 60_000);
  assert.equal(memoryBuckets(), 1);
});
