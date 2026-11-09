// An archived document is a deleted one: it leaves every list, the library, the apply picker and shared links.
// Runs on a real Postgres (BILLING_PG_URL, a migrated schema; CI test-db sets it), where a mock DB cannot see the WHERE clause.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { sha256Hex } from "../src/http.ts";
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
  const headers: Record<string, string> = { authorization: "Bearer archived-test", "idempotency-key": crypto.randomUUID() };
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await handle(new Request("https://core.example" + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }),
    env, { query: dbFor(userId), now: () => new Date("2026-11-10T00:00:00Z") });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

test("archiving a document removes it from the document list, the library, the apply picker and its share link", async (t) => {
  if (!pg) return t.skip("set BILLING_PG_URL to a migrated Postgres");
  const user = crypto.randomUUID();
  const companyId = crypto.randomUUID();
  const postingId = crypto.randomUUID();
  const [kept, gone] = [crypto.randomUUID(), crypto.randomUUID()];
  await pg.query("INSERT INTO users (id, provider, provider_subject, display_name, plan, created_at) VALUES ($1::uuid, 'test', $1::uuid::text, 'archived fixture', 'FREE', now())", [user]);
  await pg.query("INSERT INTO companies (id, name) VALUES ($1, 'archived fixture company')", [companyId]);
  await pg.query(
    `INSERT INTO job_postings (id, company, title, job_category, career_min, location, employment_type, description, company_id)
     VALUES ($1, 'fixture', 'fixture role', 'dev', 0, 'Seoul', 'full_time', 'fixture', $2)`, [postingId, companyId]);
  for (const [id, title] of [[kept, "kept"], [gone, "gone"]]) {
    await pg.query(
      "INSERT INTO documents (id, user_id, revision, title, kind, template, language, status, created_at, updated_at) VALUES ($1,$2,1,$3,'RESUME','SIMPLE','ko','DRAFT',now(),now())",
      [id, user, title]);
    await pg.query(
      "INSERT INTO document_versions (id, document_id, user_id, number, content, blocks, created_at) VALUES (gen_random_uuid(),$1::uuid,$2::uuid,1,'{}'::jsonb,'[]'::jsonb,now())",
      [id, user]);
  }

  const token = "archived-share-" + crypto.randomUUID();
  await pg.query(
    "INSERT INTO document_shares (id, document_id, version_id, token_hash, created_by) SELECT gen_random_uuid(), $1::uuid, id, $2::text, $3::uuid FROM document_versions WHERE document_id = $1::uuid",
    [gone, await sha256Hex(token), user]);
  assert.equal((await call(user, "GET", `/api/v1/documents/shared/${token}`)).status, 200);

  const ids = async (path: string): Promise<string[]> => (await call(user, "GET", path)).body.data.map((row: { id: string }) => row.id).sort();
  assert.deepEqual(await ids("/api/v1/documents"), [gone, kept].sort());
  assert.deepEqual(await ids("/api/v1/sources?kind=AI"), [gone, kept].sort());

  const archived = await call(user, "POST", `/api/v1/documents/${gone}/archive`, { expectedRevision: 1 });
  assert.equal(archived.status, 200);

  assert.deepEqual(await ids("/api/v1/documents"), [kept]);
  assert.deepEqual(await ids("/api/v1/sources?kind=AI"), [kept]);
  assert.equal((await call(user, "GET", `/api/v1/documents/shared/${token}`)).status, 404);
  assert.equal((await call(user, "POST", `/api/v1/postings/${postingId}/apply`, { documentIds: [gone] })).status, 404);
  assert.equal((await call(user, "POST", `/api/v1/postings/${postingId}/apply`, { documentIds: [kept] })).status, 201);
});
