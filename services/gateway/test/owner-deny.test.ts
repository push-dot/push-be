import assert from "node:assert/strict";
import { test } from "node:test";

import { handle, resetLimits, type Deps, type FrontEnv } from "../src/handler.ts";
import { ownerOf } from "../src/routes/owner.ts";

const ID = "12345678-1234-5678-1234-567812345678";

test("python gets only the routes its FastAPI app mounts", () => {
  const python: Array<[string, string]> = [
    ["POST", "/api/v1/ai/generate"],
    ["POST", `/api/v1/applications/${ID}/resume-run`],
    ["POST", `/api/v1/jobs/${ID}/analyze`],
    ["POST", `/api/v1/interviews/${ID}/prepare`],
    ["POST", `/api/v1/documents/${ID}/revisions`],
    ["GET", `/api/v1/documents/${ID}/versions/${ID}/export`],
    ["POST", "/api/v1/career-evidence/import"],
    ["GET", `/api/v1/sources/${ID}/profile-draft`],
    ["POST", "/api/v1/projects/blueprints"],
    ["POST", `/api/v1/projects/${ID}/evidence/${ID}/verify`],
    ["GET", `/api/v1/operations/${ID}`],
    ["GET", `/api/v1/operations/${ID}/events`],
    ["POST", `/api/v1/operations/${ID}/input`],
    ["POST", `/api/v1/operations/${ID}/cancel`],
    ["GET", "/api/v1/approvals"],
    ["POST", "/api/v1/approvals"],
    ["GET", `/api/v1/approvals/${ID}`],
    ["POST", `/api/v1/approvals/${ID}/decision`],
    ["POST", `/api/v1/conversations/${ID}/share`],
    ["GET", "/api/v1/conversations/shared/tok_abc"],
    ["GET", `/api/v1/conversations/${ID}/artifacts`],
  ];
  for (const [method, path] of python) assert.equal(ownerOf(method, path), "python", `${method} ${path}`);
});

test("paths no service mounts are denied instead of reaching python", () => {
  for (const [method, path] of [
    ["GET", "/openapi.json"],
    ["GET", "/docs"],
    ["GET", "/redoc"],
    ["GET", "/api/v1/approvals/"],
    ["DELETE", `/api/v1/operations/${ID}`],
    ["GET", "/api/v1/operations"],
    ["GET", "/api/v1/internal/notifications/run"],
    ["POST", "/api/v1/ai/models"],
    ["GET", "/api/v1/unknown"],
  ]) {
    assert.equal(ownerOf(method, path), "deny", `${method} ${path}`);
  }
});

test("encoded slashes, backslashes and empty segments are denied", () => {
  for (const path of [
    "//internal/chat/schedule",
    "/api/v1//approvals",
    `/api/v1/approvals/..%2F..%2Finternal%2Fchat%2Fschedule`,
    `/api/v1/approvals/${ID}%2fdecision`,
    `/api/v1/postings/a%5Cb`,
  ]) {
    assert.equal(ownerOf("GET", path), "deny", path);
    assert.equal(ownerOf("POST", path), "deny", path);
  }
});

test("a denied path is answered 404 without calling any worker", async () => {
  resetLimits();
  let calls = 0;
  const binding = { fetch: async () => { calls += 1; return new Response("{}"); } };
  const env = { CORE: binding, APP_ENV: "production" } as FrontEnv;
  const deps = { query: async () => [] } as Deps;
  for (const path of ["/openapi.json", "/docs", "//internal/chat/schedule"]) {
    const res = await handle(new Request("https://push-be.example" + path), env, deps);
    assert.equal(res.status, 404, path);
  }
  assert.equal(calls, 0);
});
