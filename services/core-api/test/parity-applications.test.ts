import assert from "node:assert/strict";
import { test } from "node:test";

import { parityGroup } from "./parity/harness.ts";

test("applications routes answer like the python routes", async (t) => {
  const out = await parityGroup("applications");
  if (!out.ran) return t.skip("no recorded queries; run with PARITY_PG_URL");
  assert.deepEqual(out.mismatches, []);
});
