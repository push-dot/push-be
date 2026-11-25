import assert from "node:assert/strict";
import { test } from "node:test";
import { types } from "@neondatabase/serverless";

import "../src/index.ts";

test("date columns reach handlers as YYYY-MM-DD text", () => {
  const parseDate = types.getTypeParser(1082) as (value: string) => unknown;
  assert.equal(parseDate("2026-12-16"), "2026-12-16");
});
