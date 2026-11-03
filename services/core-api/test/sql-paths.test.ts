// Runs the routes whose SQL is assembled at request time and no other test reached.
// CI captures the statements these requests send and PREPAREs them on the migrated
// schema (scripts/sql-check); scripts/sql-check/coverage.mjs fails when a dynamic SQL
// call site has no captured statement. Each test also covers the cursor branch.
import assert from "node:assert/strict";
import { test } from "node:test";
import { recorder } from "../test-support/recorder.ts";

import { handle, type CoreEnv, type Deps } from "../src/handler.ts";
import { resetLimits } from "../src/ratelimit.ts";
import { encodeCursor } from "../src/time.ts";

const NOW = "2026-10-21T00:00:00.000Z";
const CONV = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const POST = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CURSOR = encodeCursor(NOW, "cccccccc-cccc-4ccc-8ccc-cccccccccccc");

const env = (): CoreEnv => ({ APP_ENV: "production", MANAGED_AI: "1", MANAGED_GO: "0" });
const deps = (query: Deps["query"]): Deps => ({ query, now: () => new Date(NOW) });

const get = (path: string): Request => new Request("https://core.example" + path, {
  headers: { authorization: "Bearer t" },
});

const run = async (request: Request, answer?: (sql: string) => Record<string, unknown>[] | null) => {
  resetLimits();
  const { calls, query } = recorder(answer);
  const res = await handle(request, env(), deps(query));
  return { res, calls };
};

test("offer lists build both boxes with and without a cursor", async () => {
  for (const box of ["received", "sent"]) {
    for (const cursor of ["", "&cursor=" + encodeURIComponent(CURSOR)]) {
      const { res, calls } = await run(get(`/api/v1/me/offers?box=${box}${cursor}`));
      assert.equal(res.status, 200, box + cursor);
      assert.ok(calls.some((c) => c.sql.includes("FROM offers o") && c.sql.includes("ORDER BY o.created_at DESC")));
    }
  }
});

test("post search builds the relevance query with and without a cursor", async () => {
  for (const cursor of ["", "&cursor=" + encodeURIComponent(CURSOR)]) {
    const { res, calls } = await run(get("/api/v1/search?type=posts&q=" + encodeURIComponent("백엔드") + cursor));
    assert.equal(res.status, 200, cursor);
    assert.ok(calls.some((c) => c.sql.includes("p.search_jamo LIKE")), "search SQL ran");
  }
});

test("comment lists page with and without a cursor", async () => {
  for (const cursor of ["", "?cursor=" + encodeURIComponent(CURSOR)]) {
    const { res, calls } = await run(get(`/api/v1/posts/${POST}/comments${cursor}`), (sql) =>
      sql.includes("FROM posts") ? [{ id: POST }] : null);
    assert.equal(res.status, 200, cursor);
    assert.ok(calls.some((c) => c.sql.includes("ORDER BY c.created_at DESC, c.id DESC")));
  }
});

test("conversation patch sends the revision update", async () => {
  const row = {
    id: CONV, revision: 1, application_id: null, title: "t", pinned: false, archived: false,
    created_at: NOW, updated_at: NOW,
  };
  const { res, calls } = await run(new Request(`https://core.example/api/v1/conversations/${CONV}`, {
    method: "PATCH",
    headers: { authorization: "Bearer t", "content-type": "application/json" },
    body: JSON.stringify({ expectedRevision: 1, title: "새 제목", pinned: true }),
  }), (sql) => (sql.includes("conversations") ? [row] : null));
  assert.equal(res.status, 200);
  assert.ok(calls.some((c) => c.sql.startsWith("UPDATE conversations SET revision = revision + 1")));
});

test("follower and following lists build both joins with and without a cursor", async () => {
  for (const path of ["/api/v1/me/followers", "/api/v1/me/follows"]) {
    for (const cursor of ["", "?cursor=" + encodeURIComponent(CURSOR)]) {
      const { res, calls } = await run(get(path + cursor));
      assert.equal(res.status, 200, path + cursor);
      assert.ok(calls.some((c) => c.sql.includes("JOIN follows f ON") && c.sql.includes("ORDER BY f.created_at DESC")));
    }
  }
});

test("profile explore filters add the recommended and offers clauses", async () => {
  for (const explore of ["recommended", "offers"]) {
    const { res, calls } = await run(get("/api/v1/profiles?explore=" + explore));
    assert.equal(res.status, 200, explore);
    const clause = explore === "recommended" ? "p.job_category = (SELECT job_category" : "EXISTS (SELECT 1 FROM offers o";
    assert.ok(calls.some((c) => c.sql.includes(clause)), explore);
  }
});
