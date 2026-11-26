// A card the AI service stored before it wrote tool_args as an object, on a migrated Postgres (BILLING_PG_URL).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import type { Row } from "../src/db.ts";
import { handle } from "../src/handler.ts";
import { botsPg } from '../test-support/bots-pg.ts';
import type { BotsPg } from '../test-support/bots-pg.ts';

const URL_ = process.env.BILLING_PG_URL;
const SKIP = "set BILLING_PG_URL to a migrated Postgres";
const SECRET = "string-args-secret";

let db: BotsPg | undefined;
before(async () => { if (URL_) {db = await botsPg(URL_);} });
after(async () => { await db?.close(); });

const rows = async (sql: string, params: Array<unknown>): Promise<Array<Row>> => (await db!.pg.query(sql, params)).rows;

test("an approved card whose tool_args is a JSON string still lets the approved close run", async (t) => {
  if (!db) {return t.skip(SKIP);}
  const admin = await db.person("PRO");
  const posting = await db.posting("모아페이");
  const [{ company_id: company }] = await rows("SELECT company_id FROM job_postings WHERE id = $1::uuid", [posting]);
  await rows("UPDATE companies SET verified_at = now() WHERE id = $1::uuid", [company]);
  await rows("INSERT INTO company_members (company_id, user_id, role) VALUES ($1::uuid, $2::uuid, 'ADMIN')", [company, admin.id]);
  const thread = crypto.randomUUID();
  await rows("INSERT INTO conversations (id, user_id, title, company_id) VALUES ($1::uuid, $2::uuid, '마감', $3::uuid)",
    [thread, admin.id, company]);
  const card = crypto.randomUUID();
  await rows(
    `INSERT INTO approvals (id, user_id, kind, target_id, payload_hash, status, option_id, decided_at, conversation_id, title, tool_name, tool_args, job_id)
     VALUES ($1::uuid, $2::uuid, 'TOOL_ACTION', $1::uuid, 'h', 'APPROVED', 'approve', now(), $3::uuid, '공고를 마감해요', 'close_posting', to_jsonb($4::text), gen_random_uuid())`,
    [card, admin.id, thread, JSON.stringify({ posting_id: posting })]);
  const [{ t: stored }] = await rows("SELECT jsonb_typeof(tool_args) AS t FROM approvals WHERE id = $1::uuid", [card]);
  assert.equal(stored, "string", "the row has the old double-encoded shape");

  const [{ revision }] = await rows("SELECT revision FROM job_postings WHERE id = $1::uuid", [posting]);
  const res = await handle(new Request(`https://core.example/api/v1/postings/${posting}/close`, {
    method: "POST",
    headers: {
      "content-type": "application/json", "idempotency-key": crypto.randomUUID(),
      "x-push-internal-secret": SECRET, "x-push-act-as": admin.id, "x-push-company": String(company), "x-push-approval": card,
    },
    body: JSON.stringify({ expectedRevision: Number(revision) }),
  }), { APP_ENV: "production", INTERNAL_API_SECRET: SECRET }, { query: db.pg.query, transaction: db.pg.transaction, now: () => new Date() });
  assert.equal(res.status, 200, "core matched the string tool_args to the close");
  const [after_] = await rows("SELECT a.consumed_at IS NOT NULL AS spent, p.status FROM approvals a, job_postings p WHERE a.id = $1::uuid AND p.id = $2::uuid", [card, posting]);
  assert.equal(after_.spent, true);
  assert.equal(after_.status, "CLOSED");
});
