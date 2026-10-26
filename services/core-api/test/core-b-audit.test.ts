import assert from "node:assert/strict";
import { test } from "node:test";

import type { Deps } from "../src/handler.ts";
import { HttpError } from "../src/http.ts";
import { pageOf } from "../src/page.ts";
import { encodeCursor } from "../src/time.ts";

type Call = { sql: string; params: unknown[] };

export const USER = "12345678-1234-4678-9234-567812345678";

export const recorder = (answer: (sql: string, params: unknown[]) => Record<string, unknown>[] | null = () => null) => {
  const calls: Call[] = [];
  const query: Deps["query"] = async (sql, params = []) => {
    calls.push({ sql, params });
    if (sql.includes("rate_limits")) return { rows: [{ hits: 1 }], rowCount: 1 };
    if (sql.includes("access_tokens")) {
      return {
        rows: [{
          id: USER, display_name: "Ada", locale: "ko", plan: "FREE", subscription_status: "NONE",
          created_at: "2026-01-02T03:04:05Z", token_expires_at: "2099-01-01T00:00:00Z",
        }],
        rowCount: 1,
      };
    }
    if (sql.startsWith("INSERT INTO idempotency_keys")) return { rows: [{ id: "idem" }], rowCount: 1 };
    const rows = answer(sql, params) ?? [];
    return { rows, rowCount: rows.length };
  };
  return { calls, query };
};

const pageError = (url: string): HttpError => {
  try {
    pageOf(new URL(url));
  } catch (err) {
    if (err instanceof HttpError) return err;
    throw err;
  }
  throw new Error("expected a validation error");
};

test("a cursor whose id is not a UUID is a 400, not a database error", () => {
  const err = pageError("https://x/?cursor=" + encodeCursor("2026-10-01T00:00:00Z", "not-a-uuid"));
  assert.equal(err.status, 400);
  assert.deepEqual(err.details, { field: "cursor" });
});

test("a cursor id is normalized to the lowercase UUID", () => {
  const page = pageOf(new URL("https://x/?cursor=" + encodeCursor("2026-10-01T00:00:00Z", "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA")));
  assert.equal(page.cursor?.id, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
});

const NIL = "00000000-0000-0000-0000-000000000000";
const POSTING = "11111111-1111-4111-8111-111111111111";
const APP = "22222222-2222-4222-8222-222222222222";
const FILE = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2026-10-21T00:00:00Z");
const ENV = { APP_ENV: "production" };

const openPosting = { id: POSTING, company: "Acme", title: "BE", created_at: "2026-10-01T00:00:00Z", revision: 1, status: "OPEN" };

test("a guest can open a public posting without writing a view row for the nil user", async () => {
  const { handle } = await import("../src/handler.ts");
  const { calls, query } = recorder((sql) => {
    if (sql.includes("INSERT INTO posting_views")) throw Object.assign(new Error("insert or update on table \"posting_views\" violates foreign key constraint"), { code: "23503" });
    if (sql.includes("FROM job_postings p WHERE p.id = $1")) return [openPosting];
    return null;
  });
  const res = await handle(new Request(`https://core.example/api/v1/postings/${POSTING}`), ENV, { query, now: () => NOW });
  assert.equal(res.status, 200);
  assert.equal(calls.some((c) => c.sql.includes("posting_views") && c.params.includes(NIL)), false);
});

test("an applicant file with a Korean name downloads with an RFC 5987 filename", async () => {
  const { handle } = await import("../src/handler.ts");
  const { query } = recorder((sql) => {
    if (sql.includes("JOIN company_members m")) return [{ id: POSTING }];
    if (sql.includes("FROM application_files f")) return [{ file_name: "이력서 \"최종\".pdf", mime_type: "application/pdf", content: "\\x255044" }];
    return null;
  });
  const res = await handle(new Request(`https://core.example/api/v1/postings/${POSTING}/applicants/${APP}/files/${FILE}`, {
    headers: { authorization: "Bearer t" },
  }), ENV, { query, now: () => NOW });
  assert.equal(res.status, 200);
  const disposition = res.headers.get("content-disposition") ?? "";
  assert.match(disposition, /^attachment; filename="[\x20-\x7e]*"; filename\*=UTF-8''/);
  assert.ok(disposition.includes(encodeURIComponent("이력서")));
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual([...new Uint8Array(await res.arrayBuffer())], [0x25, 0x50, 0x44]);
});

test("the in-memory rate limit fallback drops buckets from past minutes", async () => {
  const { allow, memoryBuckets, resetLimits } = await import("../src/ratelimit.ts");
  resetLimits();
  const down: Deps["query"] = async () => { throw new Error("connection reset"); };
  const t0 = Date.parse("2026-10-22T00:00:30Z");
  for (let i = 0; i < 50; i += 1) await allow(down, "ip", "10.0.0." + i, 60, t0);
  assert.equal(memoryBuckets(), 50);
  await allow(down, "ip", "10.0.0.1", 60, t0 + 60_000);
  assert.equal(memoryBuckets(), 1);
});

for (const path of [
  "/api/v1/uploads/images/%E0%A4%A",
  "/api/v1/experiments/%E0%A4%A/assignment",
]) {
  test(`a malformed percent-encoding in ${path.split("/")[3]} is a 400, not a 500`, async () => {
    const { handle } = await import("../src/handler.ts");
    const { query } = recorder();
    const res = await handle(new Request("https://core.example" + path, { headers: { authorization: "Bearer t" } }), ENV, { query, now: () => NOW });
    assert.equal(res.status, 400);
  });
}

test("deleting a device with a malformed percent-encoding is a 400, not a 500", async () => {
  const { handle } = await import("../src/handler.ts");
  const { query } = recorder();
  const res = await handle(new Request("https://core.example/api/v1/me/devices/%E0%A4%A", {
    method: "DELETE", headers: { authorization: "Bearer t" },
  }), ENV, { query, now: () => NOW });
  assert.equal(res.status, 400);
});

for (const [path, limit] of [["/api/v1/uploads/images", 10 << 20], ["/api/v1/sources", 20 << 20]] as const) {
  test(`an upload to ${path} declaring more than the limit is refused with 413`, async () => {
    const { handle } = await import("../src/handler.ts");
    const { calls, query } = recorder();
    const request = new Request("https://core.example" + path, {
      method: "POST",
      headers: {
        authorization: "Bearer t", "idempotency-key": "00000000-0000-4000-8000-000000000001",
        "content-type": "multipart/form-data; boundary=x", "content-length": String(limit + (1 << 20)),
      },
      body: "--x--",
    });
    const res = await handle(request, ENV, { query, now: () => NOW });
    assert.equal(res.status, 413);
    assert.equal(calls.some((c) => c.sql.includes("INSERT INTO upload_images") || c.sql.includes("INSERT INTO sources")), false);
  });
}

test("google sync fetches gmail in parallel batches and writes every row in one statement", async () => {
  const { handle } = await import("../src/handler.ts");
  const { bytesToBase64, encryptAes, masterKey } = await import("../src/crypto.ts");
  const master = "parity-master-key";
  const sealed = await encryptAes(await masterKey(master), "access-token", USER, "google");
  const ids = Array.from({ length: 25 }, (_, i) => "m" + i);
  let inFlight = 0;
  let peak = 0;
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("/messages?")) return Response.json({ messages: ids.map((id) => ({ id })), historyId: "9" });
    if (url.includes("/messages/")) {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      const id = decodeURIComponent(url.split("/messages/")[1].split("?")[0]);
      return Response.json({ id, threadId: "t", snippet: "s", internalDate: "1761100000000", payload: { headers: [] } });
    }
    if (url.includes("/calendar/")) {
      return Response.json({ nextSyncToken: "s2", items: [
        { id: "e1", status: "confirmed", summary: "call", start: { dateTime: "2026-11-05T02:00:00Z" }, end: { dateTime: "2026-11-05T03:00:00Z" } },
        { id: "e2", status: "cancelled" },
      ] });
    }
    return new Response("{}", { status: 404 });
  };
  const { calls, query } = recorder((sql) => {
    if (sql.includes("FROM google_integrations")) {
      return [{
        user_id: USER, access_ciphertext: bytesToBase64(sealed.ciphertext), access_nonce: bytesToBase64(sealed.nonce),
        refresh_ciphertext: null, refresh_nonce: null, token_expires_at: null, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z",
        scopes: ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/calendar.events"],
      }];
    }
    return null;
  });
  const res = await handle(new Request("https://core.example/api/v1/integrations/google/sync", {
    method: "POST", headers: { authorization: "Bearer t", "idempotency-key": "00000000-0000-4000-8000-000000000002" },
  }), { ...ENV, GOOGLE_CLIENT_ID: "c", GOOGLE_CLIENT_SECRET: "s", BYOK_MASTER_KEY: master, GOOGLE_GMAIL_BETA_ENABLED: "true" }, { query, now: () => NOW, fetch: fetchImpl });
  assert.equal(res.status, 202);
  assert.ok(peak > 1 && peak <= 10, `peak concurrency ${peak}`);
  const writes = calls.filter((c) => c.sql.includes("INSERT INTO google_messages"));
  assert.equal(writes.length, 1);
  assert.deepEqual(JSON.parse(String(writes[0].params[2])).map((m: { external_id: string }) => m.external_id), ids);
  assert.deepEqual(JSON.parse(String(writes[0].params[3])), ["e2"]);
  assert.deepEqual(JSON.parse(String(writes[0].params[4])).map((e: { external_id: string }) => e.external_id), ["e1"]);
});

test("a run is not inserted when moving its selected blueprint loses the revision race", async () => {
  const { handle } = await import("../src/handler.ts");
  const BP = "44444444-4444-4444-8444-444444444444";
  let stored = 0;
  const { query } = recorder((sql) => {
    if (sql.startsWith("SELECT") && sql.includes("FROM project_blueprints WHERE id = $1")) {
      return [{ id: BP, revision: 2, application_id: APP, state: "SELECTED", title: "t", created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z" }];
    }
    if (sql.includes("INSERT INTO cli_runs")) {
      // Another request moved the blueprint first: no row passes a revision guard.
      const guarded = sql.includes("revision = $11") && sql.indexOf("revision = $11") < sql.indexOf("INSERT INTO cli_runs");
      if (!guarded) stored += 1;
      return [{ runs: guarded ? 0 : 1, moved: 0 }];
    }
    if (sql.startsWith("SELECT revision FROM project_blueprints")) return [{ revision: 3 }];
    return null;
  });
  const res = await handle(new Request(`https://core.example/api/v1/projects/${BP}/runs`, {
    method: "POST",
    headers: { authorization: "Bearer t", "idempotency-key": "00000000-0000-4000-8000-000000000003", "content-type": "application/json" },
    body: JSON.stringify({ provider: "CODEX", workingDirectory: "/w", prompt: "go" }),
  }), ENV, { query, now: () => NOW });
  assert.equal(res.status, 409);
  assert.equal(stored, 0);
});

const E1 = "e0000000-0000-4000-8000-000000000001";
const E2 = "e0000000-0000-4000-8000-000000000002";
const E3 = "e0000000-0000-4000-8000-000000000003";

const postJson = (path: string, body: unknown, key: string): Request => new Request("https://core.example" + path, {
  method: "POST",
  headers: { authorization: "Bearer t", "idempotency-key": key, "content-type": "application/json" },
  body: JSON.stringify(body),
});

test("interview evidence ids are checked in one query and the first missing id is reported", async () => {
  const { handle } = await import("../src/handler.ts");
  const { calls, query } = recorder((sql) => {
    if (sql.startsWith("SELECT id FROM applications")) return [{ id: APP }];
    if (sql.includes("FROM career_evidence")) return [{ id: E1 }, { id: E3 }];
    return null;
  });
  const res = await handle(postJson("/api/v1/interviews", {
    applicationId: APP, title: "t", scheduledAt: "2026-11-01T00:00:00Z", timeZone: "UTC", evidenceIds: [E1, E2, E3],
  }, "00000000-0000-4000-8000-000000000004"), ENV, { query, now: () => NOW });
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as { error: { message: string } }).error.message, new RegExp(E2));
  assert.equal(calls.filter((c) => c.sql.includes("FROM career_evidence")).length, 1);
});

test("a submission draft loads every document version in one query", async () => {
  const { handle } = await import("../src/handler.ts");
  const { calls, query } = recorder((sql) => {
    if (sql.includes("FROM applications WHERE id = $1")) return [{ id: APP, revision: 1, stage: "READY" }];
    if (sql.includes("FROM document_versions v")) {
      return [E1, E2, E3].map((id) => ({ id, application_id: APP, finalized_version_id: id }));
    }
    return null;
  });
  const res = await handle(postJson(`/api/v1/applications/${APP}/submission-drafts`, {
    expectedRevision: 1, mode: "MANUAL_RECORD", documentVersionIds: [E1, E2, E3],
  }, "00000000-0000-4000-8000-000000000005"), ENV, { query, now: () => NOW });
  assert.equal(res.status, 201);
  assert.equal(calls.filter((c) => c.sql.includes("FROM document_versions v")).length, 1);
});

test("an export result can be recorded only once even when two reports race", async () => {
  const { handle } = await import("../src/handler.ts");
  const DOC = "d0000000-0000-4000-8000-000000000001";
  const EXP = "d0000000-0000-4000-8000-000000000002";
  const { query } = recorder((sql) => {
    if (sql.startsWith("SELECT") && sql.includes("FROM document_exports")) {
      return [{ id: EXP, document_id: DOC, version_id: E1, format: "PDF", template: "SIMPLE", content: {}, blocks: [], content_hash: "h", status: "READY_TO_RENDER", renderer_version: "1", created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z" }];
    }
    // The other report already moved the row out of READY_TO_RENDER.
    if (sql.startsWith("UPDATE document_exports")) return sql.includes("status = 'READY_TO_RENDER'") ? [] : [{ id: EXP }];
    return null;
  });
  const res = await handle(postJson(`/api/v1/documents/${DOC}/exports/${EXP}/result`, {
    sha256: "x", byteLength: 1, status: "SUCCEEDED",
  }, "00000000-0000-4000-8000-000000000006"), ENV, { query, now: () => NOW });
  assert.equal(res.status, 409);
});

test("a new document version verifies all cited evidence in one query", async () => {
  const { handle } = await import("../src/handler.ts");
  const DOC = "d0000000-0000-4000-8000-000000000003";
  const { calls, query } = recorder((sql) => {
    if (sql.startsWith("SELECT") && sql.includes("FROM documents WHERE id = $1")) return [{ id: DOC, revision: 1, status: "DRAFT", title: "t", kind: "RESUME", template: "SIMPLE", created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z" }];
    if (sql.includes("FROM career_evidence")) return [E1, E2, E3].map((id) => ({ id, source_text: "Go and Postgres", archived: false }));
    if (sql.startsWith("WITH upd AS")) return [{ number: 2 }];
    return null;
  });
  const blocks = [E1, E2, E3].map((eid, i) => ({ id: "b" + i, text: "Go", evidenceRefs: [{ evidenceId: eid, start: 0, end: 2 }, { evidenceId: E1, start: 3, end: 6 }] }));
  const content = { type: "doc", content: blocks.map((b) => ({ type: "paragraph", attrs: { blockId: b.id }, content: [{ type: "text", text: b.text }] })) };
  const res = await handle(postJson(`/api/v1/documents/${DOC}/versions`, { expectedRevision: 1, content, blocks }, "00000000-0000-4000-8000-000000000007"),
    ENV, { query, now: () => NOW });
  assert.equal(res.status, 201);
  assert.equal(calls.filter((c) => c.sql.includes("FROM career_evidence")).length, 1);
});

test("deleting a source is one statement that unpins the profile resume instead of cascading the profile away", async () => {
  const { handle } = await import("../src/handler.ts");
  const SRC = "55555555-5555-4555-8555-555555555555";
  const { calls, query } = recorder((sql) => (sql.includes("DELETE FROM sources") ? [{ found: 1, used: 0, deleted: 1 }] : null));
  const res = await handle(new Request(`https://core.example/api/v1/sources/${SRC}`, { method: "DELETE", headers: { authorization: "Bearer t" } }),
    ENV, { query, now: () => NOW });
  assert.equal(res.status, 204);
  const writes = calls.filter((c) => !c.sql.includes("rate_limits") && !c.sql.includes("access_tokens"));
  assert.equal(writes.length, 1);
  assert.match(writes[0].sql, /UPDATE profiles SET resume_source_id = NULL/);
});

test("the source library reads one bounded page from each side and merges them", async () => {
  const { handle } = await import("../src/handler.ts");
  const { calls, query } = recorder((sql, params) => {
    const limit = Number(params.at(-1));
    if (sql.includes("FROM sources")) return [{ id: E1, file_name: "a", mime_type: "text/plain", size: 1, created_at: "2026-10-03T00:00:00Z" }].slice(0, limit);
    if (sql.includes("FROM documents")) return [{ id: E2, title: "d", created_at: "2026-10-04T00:00:00Z" }, { id: E3, title: "e", created_at: "2026-10-01T00:00:00Z" }].slice(0, limit);
    return null;
  });
  const res = await handle(new Request("https://core.example/api/v1/sources?limit=2", { headers: { authorization: "Bearer t" } }), ENV, { query, now: () => NOW });
  const body = await res.json() as { data: { id: string }[]; page: { hasMore: boolean } };
  assert.deepEqual(body.data.map((item) => item.id), [E2, E1]);
  assert.equal(body.page.hasMore, true);
  for (const c of calls.filter((x) => x.sql.includes("FROM sources") || x.sql.includes("FROM documents"))) assert.match(c.sql, /LIMIT \$2$/);
});

test("a first experiment assignment is written and read back in one statement", async () => {
  const { handle } = await import("../src/handler.ts");
  const { calls, query } = recorder((sql) => {
    if (sql.startsWith("SELECT key, variants")) return [{ key: "onboarding", variants: ["a", "b"], status: "active", exclusion_group: "" }];
    if (sql.startsWith("WITH ins AS")) return [{ experiment_key: "onboarding", variant: "b", created_at: "2026-10-21T00:00:00Z" }];
    return null;
  });
  const res = await handle(new Request("https://core.example/api/v1/experiments/onboarding/assignment", { headers: { authorization: "Bearer t" } }),
    ENV, { query, now: () => NOW });
  assert.equal(res.status, 200);
  assert.equal(calls.filter((c) => c.sql.includes("experiment_assignments")).length, 1);
});

const postingRow = { company: "Acme", title: "Backend", description: "Build", requirements: ["Go"], deadline: null };
const appRow = { id: APP, revision: 1, job_id: E3, company: "Acme", title: "Backend", stage: "APPLIED", notes: "", applied_at: "2026-10-21T00:00:00Z", next_action_at: null, imported: false, created_at: "2026-10-21T00:00:00Z", updated_at: "2026-10-21T00:00:00Z" };

test("apply checks every document and source in one query each and writes in one statement", async () => {
  const { handle } = await import("../src/handler.ts");
  const S1 = "50000000-0000-4000-8000-000000000001";
  const S2 = "50000000-0000-4000-8000-000000000002";
  const { calls, query } = recorder((sql) => {
    if (sql.includes("FROM job_postings p WHERE p.id = $1")) return [postingRow];
    if (sql.includes("FROM documents d")) return [E1, E2].map((id) => ({ id, title: "Doc", content: { id } }));
    if (sql.startsWith("SELECT id FROM sources")) return [{ id: S1 }, { id: S2 }];
    if (sql.startsWith("WITH job AS")) return [{ id: APP }];
    return null;
  });
  const res = await handle(postJson(`/api/v1/postings/${POSTING}/apply`, { documentIds: [E1, E2], sourceIds: [S1, S2] }, "00000000-0000-4000-8000-000000000008"),
    ENV, { query, now: () => NOW });
  assert.equal(res.status, 201);
  const routeCalls = calls.filter((c) => !/rate_limits|access_tokens|idempotency_keys/.test(c.sql));
  assert.equal(routeCalls.length, 5);
  assert.equal(routeCalls.filter((c) => c.sql.includes("INSERT")).length, 1);
});

test("apply answers with the winning application when a simultaneous apply hits the unique index", async () => {
  const { handle } = await import("../src/handler.ts");
  let lookups = 0;
  const { query } = recorder((sql) => {
    if (sql.includes("FROM job_postings p WHERE p.id = $1")) return [postingRow];
    if (sql.startsWith("WITH job AS")) throw Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" });
    if (sql.includes("FROM applications a JOIN jobs j")) return lookups++ === 0 ? [] : [appRow];
    return null;
  });
  const res = await handle(postJson(`/api/v1/postings/${POSTING}/apply`, {}, "00000000-0000-4000-8000-000000000009"), ENV, { query, now: () => NOW });
  assert.equal(res.status, 201);
  assert.equal(((await res.json()) as { data: { id: string } }).data.id, APP);
});
