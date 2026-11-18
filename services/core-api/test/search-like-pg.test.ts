// A search term is text, not a LIKE pattern: `%` and `_` match only themselves.
// Runs on a real Postgres (BILLING_PG_URL, a migrated schema; CI test-db sets it), where a mock DB cannot see the LIKE.
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
      id: userId, display_name: "like fixture", locale: "ko", plan: "FREE", subscription_status: "NONE",
      stripe_customer_id: null, period_ends_at: null, created_at: "2026-11-01T00:00:00Z", token_expires_at: "2099-01-01T00:00:00Z",
      is_employer: false, company_id: null, company_role: null,
    }], rowCount: 1 };
  }
  return pg!.query(sql, params);
};

const find = async (userId: string, path: string, term: string): Promise<string> => {
  resetLimits();
  const res = await handle(new Request("https://core.example" + path + encodeURIComponent(term), { headers: { authorization: "Bearer like-test" } }),
    env, { query: dbFor(userId), now: () => new Date("2026-11-10T00:00:00Z") });
  assert.equal(res.status, 200, path + term);
  return res.text();
};

test("a percent or underscore in a search term matches only itself", async (t) => {
  if (!pg) return t.skip("set BILLING_PG_URL to a migrated Postgres");
  const user = crypto.randomUUID();
  const ids = { literal: crypto.randomUUID(), plain: crypto.randomUUID() };
  const tag = "like" + ids.literal.slice(0, 8);
  const people = new Map<string, string>();
  const rows = [[ids.literal, `100% ${tag}`], [ids.plain, `Backend ${tag}`]] as const;
  await pg.query("INSERT INTO users (id, provider, provider_subject, display_name, plan, created_at) VALUES ($1::uuid, 'test', $1::uuid::text, 'like fixture', 'FREE', now())", [user]);
  const company = crypto.randomUUID();
  await pg.query("INSERT INTO companies (id, name) VALUES ($1, 'like fixture company')", [company]);
  for (const [id, title] of rows) {
    await pg.query(
      `INSERT INTO job_postings (id, company, title, job_category, career_min, location, employment_type, description, company_id)
       VALUES ($1, 'fixture', $2, 'dev', 0, 'Seoul', 'full_time', 'fixture', $3)`, [id, title, company]);
    await pg.query("INSERT INTO jobs (id, user_id, company, title, source_kind, source_text) VALUES ($1, $2, 'fixture', $3, 'TEXT', '')", [id, user, title]);
    await pg.query("INSERT INTO career_evidence (id, user_id, kind, title, source_text) VALUES ($1, $2, 'PROJECT', $3, '')", [id, user, title]);
    await pg.query("INSERT INTO applications (id, user_id, job_id, company, title) VALUES ($1, $2, $1, 'fixture', $3)", [id, user, title]);
    await pg.query("INSERT INTO posts (id, user_id, category, title, body) VALUES ($1, $2, 'dev', $3, '')", [id, user, title]);
  }
  for (const [id, title] of rows) {
    const person = crypto.randomUUID();
    people.set(id, person);
    await pg.query("INSERT INTO users (id, provider, provider_subject, display_name, plan, created_at) VALUES ($1::uuid, 'test', $1::uuid::text, $2, 'FREE', now())", [person, title]);
    await pg.query("INSERT INTO profiles (user_id, headline) VALUES ($1, $2)", [person, title]);
  }
  const surfaces: Array<[string, string]> = [
    ["postings list", "/api/v1/postings?q="],
    ["postings search", "/api/v1/search?type=postings&q="],
    ["posts search", "/api/v1/search?type=posts&q="],
    ["jobs", "/api/v1/jobs?query="],
    ["career evidence", "/api/v1/career-evidence?query="],
    ["applications", "/api/v1/applications?query="],
    ["people search", "/api/v1/search?type=people&q="],
  ];
  for (const [name, path] of surfaces) {
    const [literal, plain] = name === "people search" ? [people.get(ids.literal)!, people.get(ids.plain)!] : [ids.literal, ids.plain];
    const percent = await find(user, path, "%");
    assert.ok(percent.includes(literal), `${name}: "%" finds the title that has one`);
    assert.equal(percent.includes(plain), false, `${name}: "%" is not a wildcard`);
    const underscore = await find(user, path, "_");
    assert.equal(underscore.includes(literal) || underscore.includes(plain), false, `${name}: "_" is not a wildcard`);
    assert.ok((await find(user, path, "backend " + tag)).includes(plain), `${name}: a plain term still matches`);
  }
});
