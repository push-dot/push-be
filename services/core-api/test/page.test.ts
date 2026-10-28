import assert from "node:assert/strict";
import { test } from "node:test";

import { HttpError } from "../src/http.ts";
import { pageOf } from "../src/page.ts";
import { encodeCursor } from "../src/time.ts";

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
