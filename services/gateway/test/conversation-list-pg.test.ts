// Parity of list enrichment SQL on a migrated Postgres (BILLING_PG_URL; CI test-db sets it).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import {
  CONVERSATION_ENRICHMENT_JOINS,
  conversationListAuxCtesForLive,
  conversationRowSelect,
  employerOwnerPc,
  LAST_LINE,
  LAST_MSG_LATERAL,
  personalOwnerPc,
} from "../src/middleware/ratelimit.ts";
import { legacyConversationListSelect } from "./conversation-list-legacy.ts";

const URL_ = process.env.BILLING_PG_URL;
type Pg = { query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> };

let pg: Pg | undefined;
let rollback: (() => Promise<void>) | undefined;

before(async () => {
  if (!URL_) return;
  const { livePg } = await import("../../core-api/test/parity/pg.ts");
  const live = await livePg(URL_, 3);
  pg = live;
  rollback = async () => {
    await live.close();
    pg = undefined;
  };
});
after(async () => { await rollback?.(); });

type Row = {
  id: string;
  status: string;
  last_line: string | null;
  queue_position: number | null;
  last_message_preview: string;
};

const pick = (rows: Record<string, unknown>[]): Row[] =>
  rows.map((r) => ({
    id: String(r.id),
    status: String(r.status ?? "DONE"),
    last_line: r.last_line == null || r.last_line === "" ? null : String(r.last_line),
    queue_position: r.queue_position == null ? null : Number(r.queue_position),
    last_message_preview: String(r.last_message_preview ?? ""),
  }));

const assertParity = (legacy: Row[], next: Row[]): void => {
  assert.equal(legacy.length, next.length);
  assert.deepEqual(
    legacy.map((r) => ({ ...r, id: "[order]" })),
    next.map((r) => ({ ...r, id: "[order]" })),
  );
  assert.deepEqual(legacy.map((r) => r.id), next.map((r) => r.id));
};

const enrichedSelect = (fromSql: string): string => "SELECT c.id, "
  + "CASE WHEN na.conversation_id IS NOT NULL THEN 'NEEDS_APPROVAL' "
  + "WHEN ac.conversation_id IS NOT NULL THEN 'RUNNING' ELSE 'DONE' END AS status, "
  + LAST_LINE + ", qr.queue_position, "
  + "COALESCE(left(last_msg.text, 140), '') AS last_message_preview "
  + fromSql + LAST_MSG_LATERAL + CONVERSATION_ENRICHMENT_JOINS;

const listSqlPageForLive = (): string => "WITH live AS (SELECT $1::uuid AS id), "
  + conversationListAuxCtesForLive() + " "
  + enrichedSelect("FROM conversations c JOIN live ON live.id = c.user_id ")
  + "WHERE c.archived = false AND c.company_id IS NULL "
  + "ORDER BY c.updated_at DESC, c.id DESC";

const legacyListSqlPageForLive = (): string => "WITH live AS (SELECT $1::uuid AS id) "
  + legacyConversationListSelect(
    "c.archived = false AND c.company_id IS NULL",
    "JOIN live ON live.id = c.user_id ",
  );

test("list enrichment matches legacy on Postgres (personal, employer, LIST page CTE)", async (t) => {
  if (!pg) return t.skip("set BILLING_PG_URL to a migrated Postgres");
  const db = pg;
  const user = crypto.randomUUID();
  const company = crypto.randomUUID();
  const cNeeds = crypto.randomUUID();
  const cQueue = crypto.randomUUID();
  const cMulti = crypto.randomUUID();
  const cDone = crypto.randomUUID();
  const cEmployer = crypto.randomUUID();
  const t0 = new Date("2026-06-01T10:00:00Z");
  const t1 = new Date("2026-06-01T10:01:00Z");
  const t2 = new Date("2026-06-01T10:02:00Z");
  const t3 = new Date("2026-06-01T10:03:00Z");
  const jA = crypto.randomUUID();
  const jB = crypto.randomUUID();
  const jMulti1 = crypto.randomUUID();
  const jMulti2 = crypto.randomUUID();
  const jRun = crypto.randomUUID();
  const apprLive = crypto.randomUUID();
  const apprExpired = crypto.randomUUID();
  const target = crypto.randomUUID();

  await db.query(
    "INSERT INTO users (id, provider, provider_subject, display_name, plan) VALUES ($1, 'test', $1::text, 'owner', 'FREE')",
    [user],
  );
  await db.query("INSERT INTO companies (id, name) VALUES ($1, 'co')", [company]);
  await db.query("INSERT INTO company_members (company_id, user_id, role) VALUES ($1, $2, 'ADMIN')", [company, user]);

  const insertConv = (id: string, title: string, updated: Date, companyId: string | null) => db.query(
    "INSERT INTO conversations (id, user_id, revision, title, pinned, archived, created_at, updated_at, company_id) "
    + "VALUES ($1, $2, 1, $3, false, false, $4, $5, $6)",
    [id, user, title, t0, updated, companyId],
  );
  await insertConv(cNeeds, "needs", new Date("2026-06-10T00:00:00Z"), null);
  await insertConv(cQueue, "queue", new Date("2026-06-09T00:00:00Z"), null);
  await insertConv(cMulti, "multi", new Date("2026-06-08T00:00:00Z"), null);
  await insertConv(cDone, "done", new Date("2026-06-07T00:00:00Z"), null);
  await insertConv(cEmployer, "employer", new Date("2026-06-06T00:00:00Z"), company);

  await db.query(
    "INSERT INTO messages (id, user_id, conversation_id, role, text, attachments, created_at) "
    + "VALUES ($1, $2, $3, 'USER', $4, '[]'::jsonb, $5)",
    [crypto.randomUUID(), user, cQueue, "preview queue", t1],
  );

  const insertJob = (id: string, convId: string, status: string, at: Date) => db.query(
    "INSERT INTO chat_jobs (id, user_id, conversation_id, status, payload, created_at, run_at) "
    + "VALUES ($1, $2, $3, $4, '{}'::jsonb, $5, $5)",
    [id, user, convId, status, at],
  );
  await insertJob(jA, cQueue, "PENDING", t1);
  await insertJob(jB, cMulti, "PENDING", t2);
  await insertJob(jMulti1, cMulti, "PENDING", t2);
  await insertJob(jMulti2, cMulti, "PENDING", t3);
  await insertJob(jRun, cQueue, "RUNNING", t1);

  const insertApproval = (id: string, convId: string, title: string, expires: Date | null) => db.query(
    "INSERT INTO approvals (id, user_id, revision, kind, target_id, payload_hash, status, conversation_id, title, "
    + "expires_at, created_at, updated_at) VALUES ($1, $2, 1, 'TOOL_ACTION', $3, 'hash', 'PENDING', $4, $5, $6, now(), now())",
    [id, user, target, convId, title, expires],
  );
  await insertApproval(apprLive, cNeeds, "승인 카드", new Date("2099-01-01T00:00:00Z"));
  await insertApproval(apprExpired, cDone, "만료", new Date("2020-01-01T00:00:00Z"));

  await db.query(
    "INSERT INTO chat_events (job_id, type, payload) VALUES ($1, 'status', $2::jsonb)",
    [jRun, JSON.stringify({ text: "진행 중" })],
  );

  const legacyPersonal = legacyConversationListSelect("c.user_id = $1::uuid AND c.company_id IS NULL AND NOT c.archived");
  const newPersonal = conversationRowSelect(personalOwnerPc("$1"))
    + "WHERE c.user_id = $1::uuid AND c.company_id IS NULL AND NOT c.archived "
    + "ORDER BY c.updated_at DESC, c.id DESC";
  const legacyEmployer = legacyConversationListSelect("c.company_id = $1::uuid AND NOT c.archived");
  const newEmployer = conversationRowSelect(employerOwnerPc("$1"))
    + "WHERE c.company_id = $1::uuid AND NOT c.archived "
    + "ORDER BY c.updated_at DESC, c.id DESC";

  const oldP = pick((await db.query(legacyPersonal, [user])).rows);
  const newP = pick((await db.query(newPersonal, [user])).rows);
  assertParity(oldP, newP);

  const oldE = pick((await db.query(legacyEmployer, [company])).rows);
  const newE = pick((await db.query(newEmployer, [company])).rows);
  assertParity(oldE, newE);

  const oldLive = pick((await db.query(legacyListSqlPageForLive(), [user])).rows);
  const newLive = pick((await db.query(listSqlPageForLive(), [user])).rows);
  assertParity(oldLive, newLive);

  const multi = newP.find((r) => r.id === cMulti);
  const queued = newP.find((r) => r.id === cQueue);
  assert.ok(multi && queued);
  assert.equal(queued.queue_position, 0);
  assert.equal(multi.queue_position, 1);

  const needs = newP.find((r) => r.id === cNeeds);
  assert.equal(needs?.status, "NEEDS_APPROVAL");
  assert.equal(needs?.last_line, "승인 카드");
  const done = newP.find((r) => r.id === cDone);
  assert.equal(done?.status, "DONE");
});
