import assert from "node:assert/strict";
import { test } from "node:test";

import { ownerOf } from "../src/routes/owner.ts";

const ID = "12345678-1234-5678-1234-567812345678";

test("posting fit, document generate and ai job status go to core", () => {
  assert.equal(ownerOf("POST", `/api/v1/postings/${ID}/fit`), "core");
  assert.equal(ownerOf("POST", `/api/v1/documents/${ID}/generate`), "core");
  assert.equal(ownerOf("POST", `/api/v1/documents/${ID}/exports`), "python");
  assert.equal(ownerOf("GET", `/api/v1/ai/jobs/${ID}`), "core");
  assert.equal(ownerOf("POST", "/api/v1/sources"), "core");
  assert.equal(ownerOf("GET", `/api/v1/postings/${ID}/fit`), "core");
  assert.equal(ownerOf("POST", "/api/v1/postings"), "core");
  assert.equal(ownerOf("POST", `/api/v1/postings/${ID}/close`), "core");
});
