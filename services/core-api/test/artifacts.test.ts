import assert from "node:assert/strict";
import { test } from "node:test";

import { handle, type CoreEnv, type Deps } from "../src/handler.ts";
import { resetLimits } from "../src/ratelimit.ts";

const OWNER = "12345678-1234-5678-1234-567812345678";
const OTHER = "87654321-4321-4321-8321-876543218765";
const CONV = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0x00, 0xff, 0xfe]);

const env = (): CoreEnv => ({ APP_ENV: "production" });

const files: Record<string, string> = {
  "05_final_resume.pdf": Buffer.from(PDF).toString("base64"),
  "05_final_resume.md": Buffer.from("# 이력서\n경력", "utf8").toString("base64"),
  "이력서 최종.md": Buffer.from("본문", "utf8").toString("base64"),
};

const query = (caller: string): Deps["query"] => async (sql, params = []) => {
  const rows = (list: Record<string, unknown>[]) => ({ rows: list, rowCount: list.length });
  if (sql.includes("access_tokens")) {
    return rows([{ id: caller, display_name: "Ada", locale: "ko", plan: "PRO", created_at: "2026-01-02T03:04:05Z", token_expires_at: "2099-01-01T00:00:00Z" }]);
  }
  if (sql.includes("rate_limits")) return rows([{ hits: 1 }]);
  if (sql.includes("FROM workspace_files")) {
    const visible = params[0] === CONV && params[1] === caller && caller === OWNER;
    const content = files[String(params[2])];
    return rows(visible && content ? [{ content }] : []);
  }
  return rows([]);
};

const get = (name: string, caller = OWNER): Promise<Response> => {
  resetLimits();
  return handle(new Request(`https://core.example/api/v1/conversations/${CONV}/artifacts/${name}`, {
    headers: { authorization: "Bearer t" },
  }), env(), { query: query(caller), now: () => new Date("2026-10-22T00:00:00Z") });
};

test("an artifact PDF comes back byte for byte with a download name", async () => {
  const res = await get("05_final_resume.pdf");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/pdf");
  assert.equal(res.headers.get("content-disposition"),
    "attachment; filename=\"05_final_resume.pdf\"; filename*=UTF-8''05_final_resume.pdf");
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), PDF);
});

test("markdown is utf-8 and a Korean name uses filename*", async () => {
  const md = await get("05_final_resume.md");
  assert.equal(md.headers.get("content-type"), "text/markdown; charset=utf-8");
  assert.equal(await md.text(), "# 이력서\n경력");
  const korean = await get(encodeURIComponent("이력서 최종.md"));
  assert.equal(korean.status, 200);
  assert.equal(korean.headers.get("content-disposition"),
    "attachment; filename=\"___ __.md\"; filename*=UTF-8''%EC%9D%B4%EB%A0%A5%EC%84%9C%20%EC%B5%9C%EC%A2%85.md");
});

test("another user's conversation and an unknown name are 404", async () => {
  assert.equal((await get("05_final_resume.pdf", OTHER)).status, 404);
  assert.equal((await get("06_missing.md")).status, 404);
});

test("traversal and hidden names are rejected before any read", async () => {
  for (const name of ["..%2F..%2Fetc%2Fpasswd", "x%2F..%2Fy.md", ".env", "a%5Cb.md", "a%00.md", "%E0%A4%A"]) {
    const res = await get(name);
    assert.equal(res.status, 400, name);
  }
  // A bare ".." segment is resolved away by URL parsing, so it never reaches the route.
});

test("artifacts are served with nosniff", async () => {
  const res = await get("05_final_resume.md");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
});
