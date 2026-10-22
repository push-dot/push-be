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

test("source, image and career evidence routes go to core except file parsing", () => {
  assert.equal(ownerOf("GET", "/api/v1/sources"), "core");
  assert.equal(ownerOf("POST", "/api/v1/sources"), "core");
  assert.equal(ownerOf("GET", `/api/v1/sources/${ID}`), "core");
  assert.equal(ownerOf("DELETE", `/api/v1/sources/${ID}`), "core");
  assert.equal(ownerOf("GET", `/api/v1/sources/${ID}/content`), "core");
  assert.equal(ownerOf("GET", `/api/v1/sources/${ID}/profile-draft`), "python");
  assert.equal(ownerOf("POST", "/api/v1/uploads/images"), "core");
  assert.equal(ownerOf("GET", "/api/v1/uploads/images/0123456789abcdef0123456789abcdef.png"), "core");
  assert.equal(ownerOf("GET", "/api/v1/career-evidence"), "core");
  assert.equal(ownerOf("POST", "/api/v1/career-evidence"), "core");
  assert.equal(ownerOf("GET", `/api/v1/career-evidence/${ID}`), "core");
  assert.equal(ownerOf("POST", `/api/v1/career-evidence/${ID}/archive`), "core");
  assert.equal(ownerOf("POST", "/api/v1/career-evidence/import"), "python");
});

test("experiment routes go to core", () => {
  assert.equal(ownerOf("GET", "/api/v1/experiments/onboarding/assignment"), "core");
  assert.equal(ownerOf("POST", "/api/v1/experiments/onboarding/events"), "core");
  assert.equal(ownerOf("GET", "/api/v1/experiments/onboarding/stats"), "core");
  assert.equal(ownerOf("GET", "/api/v1/experiments/onboarding/results"), "core");
});

test("interview routes go to core except the AI prepare", () => {
  assert.equal(ownerOf("GET", "/api/v1/interviews"), "core");
  assert.equal(ownerOf("POST", "/api/v1/interviews"), "core");
  assert.equal(ownerOf("GET", `/api/v1/interviews/${ID}`), "core");
  assert.equal(ownerOf("PATCH", `/api/v1/interviews/${ID}`), "core");
  assert.equal(ownerOf("POST", `/api/v1/interviews/${ID}/prepare`), "python");
});

test("project routes go to core except AI blueprints and verification", () => {
  assert.equal(ownerOf("GET", "/api/v1/projects"), "core");
  assert.equal(ownerOf("GET", `/api/v1/projects/${ID}`), "core");
  assert.equal(ownerOf("POST", `/api/v1/projects/${ID}/select`), "core");
  assert.equal(ownerOf("GET", `/api/v1/projects/${ID}/runs`), "core");
  assert.equal(ownerOf("POST", `/api/v1/projects/${ID}/runs`), "core");
  for (const step of ["start", "launch", "recover", "result"]) {
    assert.equal(ownerOf("POST", `/api/v1/projects/${ID}/runs/${ID}/${step}`), "core");
  }
  assert.equal(ownerOf("GET", `/api/v1/projects/${ID}/evidence`), "core");
  assert.equal(ownerOf("POST", `/api/v1/projects/${ID}/evidence`), "core");
  assert.equal(ownerOf("POST", "/api/v1/projects/blueprints"), "python");
  assert.equal(ownerOf("POST", `/api/v1/projects/${ID}/evidence/${ID}/verify`), "python");
});
