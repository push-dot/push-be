import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

const sql = readFileSync(resolve(
  import.meta.dirname,
  "../../../db/migrations/0075_reset_posting_fit_cache.sql",
), "utf8");

const statements = sql.replaceAll(/--.*$/gm, "").split(";").map((part) => part.trim()).filter(Boolean);

test("migration 0075 empties the fit cache and touches nothing else", () => {
  assert.deepEqual(statements, ["DELETE FROM posting_fit_cache"]);
  assert.doesNotMatch(sql, /^\s*BEGIN\b/m);
  assert.doesNotMatch(sql, /^\s*COMMIT\b/m);
});
