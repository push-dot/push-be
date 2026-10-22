import assert from "node:assert/strict";
import { test } from "node:test";

import { ownerOf } from "../src/routes/owner.ts";

const ID = "12345678-1234-5678-1234-567812345678";

test("application routes go to core except the AI resume run", () => {
  assert.equal(ownerOf("GET", "/api/v1/applications"), "core");
  assert.equal(ownerOf("POST", "/api/v1/applications"), "core");
  assert.equal(ownerOf("POST", "/api/v1/applications/import"), "core");
  assert.equal(ownerOf("GET", `/api/v1/applications/${ID}`), "core");
  assert.equal(ownerOf("PATCH", `/api/v1/applications/${ID}`), "core");
  assert.equal(ownerOf("GET", `/api/v1/applications/${ID}/timeline`), "core");
  assert.equal(ownerOf("GET", `/api/v1/applications/${ID}/checklist`), "core");
  assert.equal(ownerOf("POST", `/api/v1/applications/${ID}/submission-drafts`), "core");
  assert.equal(ownerOf("POST", `/api/v1/applications/${ID}/submissions`), "core");
  assert.equal(ownerOf("GET", `/api/v1/applications/${ID}/submissions`), "core");
  assert.equal(ownerOf("POST", `/api/v1/applications/${ID}/resume-run`), "python");
});
