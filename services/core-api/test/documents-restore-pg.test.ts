// Restore, the 30-day archived list, the source-delete reason, and the fit-cache cascade.
// Runs on a real Postgres (BILLING_PG_URL, a migrated schema including 0048). Skips elsewhere.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import type { Query } from "../src/db.ts";
import { handle, type CoreEnv } from "../src/handler.ts";
import { resetLimits } from "../src/ratelimit.ts";
import { livePg, type LivePg } from "./parity/pg.ts";

const URL_ = process.env.BILLING_PG_URL;
const env: CoreEnv = { APP_ENV: "production" };

let pg: LivePg | undefined;
before(async () => { if (URL_) pg = await livePg(URL_); });
after(async () => { await pg?.close(); });

const dbFor = (userId: string): Query => async (sql, params = []) => {
  if (sql.includes("rate_limits")) return { rows: [{ hits: 1 }], rowCount: 1 };
  if (sql.includes("idempotency_keys")) return sql.includes("INSERT") ? { rows: [{ id: "idem" }], rowCount: 1 } : { rows: [], rowCount: 0 };
  if (sql.includes("access_tokens")) {
    return { rows: [{
      id: userId, display_name: "이민아", locale: "ko", plan: "FREE", subscription_status: "NONE",
      stripe_customer_id: null, period_ends_at: null, created_at: "2026-11-01T00:00:00Z", token_expires_at: "2099-01-01T00:00:00Z",
      is_employer: false, company_id: null, company_role: null,
    }], rowCount: 1 };
  }
  return pg!.query(sql, params);
};

const call = async (userId: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
  resetLimits();
  const headers: Record<string, string> = { authorization: "Bearer restore-test", "idempotency-key": crypto.randomUUID() };
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await handle(new Request("https://core.example" + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }),
    env, { query: dbFor(userId), now: () => new Date("2026-11-10T00:00:00Z") });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

const seedUser = async (): Promise<string> => {
  const user = crypto.randomUUID();
  await pg!.query("INSERT INTO users (id, provider, provider_subject, display_name, plan, created_at) VALUES ($1::uuid, 'test', $1::uuid::text, 'restore fixture', 'FREE', now())", [user]);
  return user;
};

const seedDoc = async (user: string, status: string, opts: { finalized?: boolean; updated?: string; title?: string } = {}): Promise<string> => {
  const id = crypto.randomUUID();
  const version = crypto.randomUUID();
  await pg!.query(
    "INSERT INTO documents (id, user_id, revision, title, kind, template, language, status, created_at, updated_at) VALUES ($1,$2,1,$3,'RESUME','SIMPLE','ko',$4,now(), " + (opts.updated ?? "now()") + ")",
    [id, user, opts.title ?? "서류", status]);
  await pg!.query(
    "INSERT INTO document_versions (id, document_id, user_id, number, content, blocks, created_at) VALUES ($1,$2,$3,1,'{}'::jsonb,'[]'::jsonb,now())",
    [version, id, user]);
  await pg!.query(
    "UPDATE documents SET latest_version_id = $1, finalized_version_id = $2 WHERE id = $3",
    [version, opts.finalized ? version : null, id]);
  return id;
};

const seedNode = async (user: string, doc: string): Promise<void> => {
  await pg!.query(
    "INSERT INTO rag_nodes (id, user_id, source_type, source_id, document_id, seq, text, embedding, embedding_model) VALUES (gen_random_uuid(), $1, 'document', $2, $2, 0, 't', array_fill(0.1::real, ARRAY[1024])::vector, 'test')",
    [user, doc]);
};

test("restore returns a draft or a finalized document, bumps revision, and enqueues ingest", async (t) => {
  if (!pg) return t.skip("set BILLING_PG_URL to a migrated Postgres");
  const user = await seedUser();
  const other = await seedUser();
  const draft = await seedDoc(user, "DRAFT", { title: "초안" });
  const final = await seedDoc(user, "FINALIZED", { finalized: true, title: "확정" });
  await seedNode(user, draft);
  assert.equal((await call(user, "POST", `/api/v1/documents/${draft}/archive`, { expectedRevision: 1 })).status, 200);
  assert.equal((await call(user, "POST", `/api/v1/documents/${final}/archive`, { expectedRevision: 1 })).status, 200);
  assert.equal(Number((await pg.query("SELECT count(*) AS n FROM rag_nodes WHERE source_id = $1", [draft])).rows[0].n), 0);

  const mismatch = await call(user, "POST", `/api/v1/documents/${draft}/restore`, { expectedRevision: 1 });
  assert.equal(mismatch.status, 409);
  assert.equal(mismatch.body.error.code, "REVISION_CONFLICT");

  const restored = await call(user, "POST", `/api/v1/documents/${draft}/restore`, { expectedRevision: 2 });
  assert.equal(restored.status, 200);
  assert.equal(restored.body.data.status, "DRAFT");
  assert.equal(restored.body.data.revision, 3);
  assert.equal(restored.body.data.archivedAt, undefined);

  const back = await call(user, "POST", `/api/v1/documents/${final}/restore`, { expectedRevision: 2 });
  assert.equal(back.status, 200);
  assert.equal(back.body.data.status, "FINALIZED");
  assert.equal(back.body.data.revision, 3);

  const jobs = await pg.query("SELECT payload FROM ai_jobs WHERE user_id = $1 AND type = 'ingest'", [user]);
  const ids = jobs.rows.map((row) => {
    const payload = typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload;
    return payload.documentId;
  }).sort();
  assert.deepEqual(ids, [draft, final].sort());

  const live = (await call(user, "GET", "/api/v1/documents")).body.data.map((row: { id: string }) => row.id);
  assert.ok(live.includes(draft) && live.includes(final));

  const noop = await call(user, "POST", `/api/v1/documents/${draft}/restore`, { expectedRevision: 3 });
  assert.equal(noop.status, 200);
  assert.equal(noop.body.data.revision, 3);
  assert.equal(noop.body.data.status, "DRAFT");
  assert.equal(Number((await pg.query("SELECT count(*) AS n FROM ai_jobs WHERE user_id = $1 AND type = 'ingest'", [user])).rows[0].n), 2);

  const foreign = await seedDoc(other, "ARCHIVED");
  assert.equal((await call(user, "POST", `/api/v1/documents/${foreign}/restore`, { expectedRevision: 1 })).status, 404);
  await pg.query("DELETE FROM documents WHERE id = $1", [foreign]);
  assert.equal((await call(other, "POST", `/api/v1/documents/${foreign}/restore`, { expectedRevision: 1 })).status, 404);
});

test("archived=1 lists only the caller's documents from the last 30 days, newest first, with purgeAt", async (t) => {
  if (!pg) return t.skip("set BILLING_PG_URL to a migrated Postgres");
  const user = await seedUser();
  const other = await seedUser();
  const recent = await seedDoc(user, "ARCHIVED", { updated: "now() - interval '2 days'", title: "최근" });
  const older = await seedDoc(user, "ARCHIVED", { updated: "now() - interval '10 days'", title: "이전" });
  const expired = await seedDoc(user, "ARCHIVED", { updated: "now() - interval '31 days'", title: "만료" });
  const live = await seedDoc(user, "DRAFT", { title: "살아있음" });
  await seedDoc(other, "ARCHIVED", { updated: "now() - interval '1 day'", title: "남" });

  const page = await call(user, "GET", "/api/v1/documents?archived=1");
  assert.equal(page.status, 200);
  const items = page.body.data as { id: string; archivedAt: string; purgeAt: string; updatedAt: string }[];
  assert.deepEqual(items.map((row) => row.id), [recent, older]);
  for (const row of items) {
    assert.equal(row.archivedAt, row.updatedAt);
    assert.equal(Date.parse(row.purgeAt) - Date.parse(row.archivedAt), 30 * 24 * 60 * 60 * 1000);
  }
  assert.equal(items.some((row) => row.id === expired || row.id === live), false);

  const plain = (await call(user, "GET", "/api/v1/documents")).body.data as { id: string; archivedAt?: string }[];
  assert.deepEqual(plain.map((row) => row.id), [live]);
  assert.equal(plain[0].archivedAt, undefined);

  const brought = await call(user, "POST", `/api/v1/documents/${recent}/restore`, { expectedRevision: 1 });
  assert.equal(brought.status, 200);
  assert.equal(brought.body.data.status, "DRAFT");
  const after = (await call(user, "GET", "/api/v1/documents?archived=1")).body.data.map((row: { id: string }) => row.id);
  assert.deepEqual(after, [older]);
  const visible = (await call(user, "GET", "/api/v1/documents")).body.data.map((row: { id: string }) => row.id);
  assert.ok(visible.includes(recent) && visible.includes(live));
});

test("deleting a source that evidence cites returns REFERENCED_BY_EVIDENCE", async (t) => {
  if (!pg) return t.skip("set BILLING_PG_URL to a migrated Postgres");
  const user = await seedUser();
  const source = crypto.randomUUID();
  await pg.query(
    "INSERT INTO sources (id, user_id, file_name, mime_type, size, sha256, path) VALUES ($1,$2,'cv.pdf','application/pdf',1,'abc','db://x')",
    [source, user]);
  for (const id of [crypto.randomUUID(), crypto.randomUUID()]) {
    await pg.query(
      "INSERT INTO career_evidence (id, user_id, kind, title, source_text, provenance) VALUES ($1,$2,'PROJECT','t','s', jsonb_build_object('sourceId', $3::text))",
      [id, user, source]);
  }
  const blocked = await call(user, "DELETE", `/api/v1/sources/${source}`);
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error.code, "INVALID_TRANSITION");
  assert.deepEqual(blocked.body.error.details, { reason: "REFERENCED_BY_EVIDENCE", evidenceCount: 2 });
  assert.equal(Number((await pg.query("SELECT count(*) AS n FROM sources WHERE id = $1", [source])).rows[0].n), 1);
});

test("deleting a document deletes its posting_fit_cache rows", async (t) => {
  if (!pg) return t.skip("set BILLING_PG_URL to a migrated Postgres");
  const user = await seedUser();
  const company = crypto.randomUUID();
  const posting = crypto.randomUUID();
  const doc = await seedDoc(user, "DRAFT");
  await pg.query("INSERT INTO companies (id, name) VALUES ($1, 'fit cascade')", [company]);
  await pg.query(
    `INSERT INTO job_postings (id, company, title, job_category, career_min, location, employment_type, description, company_id)
     VALUES ($1, 'c', 't', 'dev', 0, 'Seoul', 'full_time', 'd', $2)`,
    [posting, company]);
  await pg.query(
    "INSERT INTO posting_fit_cache (user_id, posting_id, document_id, fit_score, parts, plan) VALUES ($1,$2,$3,7.5,'{}'::jsonb,'FREE')",
    [user, posting, doc]);
  await pg.query("DELETE FROM documents WHERE id = $1", [doc]);
  assert.equal(Number((await pg.query("SELECT count(*) AS n FROM posting_fit_cache WHERE document_id = $1", [doc])).rows[0].n), 0);
  const kept = await seedDoc(user, "DRAFT");
  await pg.query(
    "INSERT INTO posting_fit_cache (user_id, posting_id, document_id, fit_score, parts, plan) VALUES ($1,$2,$3,7.5,'{}'::jsonb,'FREE')",
    [user, posting, kept]);
  await pg.query("DELETE FROM job_postings WHERE id = $1", [posting]);
  assert.equal(Number((await pg.query("SELECT count(*) AS n FROM posting_fit_cache WHERE posting_id = $1", [posting])).rows[0].n), 0);
});
