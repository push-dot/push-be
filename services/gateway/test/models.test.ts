import assert from "node:assert/strict";
import { test } from "node:test";

import { listModels } from "../src/models.ts";

test("listModels supportedEfforts includes MAX and the lower efforts", () => {
  const rows = listModels({
    provider: "",
    managedAi: true,
    managedGo: false,
  });
  assert.ok(rows.length > 0);
  for (const row of rows) {
    assert.ok(row.supportedEfforts.includes("LOW"));
    assert.ok(row.supportedEfforts.includes("MEDIUM"));
    assert.ok(row.supportedEfforts.includes("HIGH"));
    assert.ok(row.supportedEfforts.includes("MAX"));
  }
});
