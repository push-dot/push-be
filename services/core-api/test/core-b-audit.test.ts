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
