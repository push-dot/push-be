import assert from "node:assert/strict";
import { test } from "node:test";
import { types } from "@neondatabase/serverless";

import "../src/index.ts";

test("date columns reach handlers as YYYY-MM-DD text", () => {
  assert.equal(types.getTypeParser(1082)("2026-12-16"), "2026-12-16");
});
