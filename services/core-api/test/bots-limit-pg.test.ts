// One bot per company and the plan limit, on a migrated Postgres (BILLING_PG_URL): both are decided by
// a row lock and a unique index, which the in-memory fakes of bots.test.ts cannot show.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { BOT_COLORS } from "../src/routes/bots.ts";
import { botsPg, type BotsPg, type Person } from "../test-support/bots-pg.ts";

const URL_ = process.env.BILLING_PG_URL;
const SKIP = "set BILLING_PG_URL to a migrated Postgres";

let db: BotsPg | undefined;
before(async () => { if (URL_) db = await botsPg(URL_); });
after(async () => { await db?.close(); });

const companyBots = async (user: Person): Promise<Record<string, unknown>[]> => (await db!.pg.query(
  "SELECT id, company_id, company_name, display_name, color FROM bots WHERE user_id = $1::uuid AND kind = 'company' AND deleted_at IS NULL",
  [user.id])).rows;

test("parallel FREE creates at the limit allow only one more company bot", async (t) => {
  if (!db) return t.skip(SKIP);
  const user = await db.person("FREE");
  for (const company of ["Acme", "Beta"]) {
    assert.equal((await db.call(user, "POST", "/bots", { postingId: await db.posting(company) })).status, 201);
  }
  const [gamma, delta] = [await db.posting("Gamma"), await db.posting("Delta")];
  const answers = await Promise.all([
    db.call(user, "POST", "/bots", { postingId: gamma }),
    db.call(user, "POST", "/bots", { postingId: delta }),
  ]);
  assert.deepEqual(answers.map((a) => a.status).sort(), [201, 403]);
  const limited = answers.find((a) => a.status === 403)!;
  assert.equal(limited.error!.code, "BOT_LIMIT");
  assert.deepEqual(limited.error!.details, { limit: 3, plan: "FREE" });
  assert.equal((await companyBots(user)).length, 3);
});

test("two parallel creates for one company give 201 and 200 and one bot", async (t) => {
  if (!db) return t.skip(SKIP);
  const { person, posting, call } = db;
  for (const plan of ["FREE", "ULTRA"]) {
    const user = await person(plan);
    const [first, second] = [await posting("Moa Pay"), await posting("  moa pay ")];
    const answers = await Promise.all([
      call(user, "POST", "/bots", { postingId: first }),
      call(user, "POST", "/bots", { postingId: second }),
    ]);
    assert.deepEqual(answers.map((a) => a.status).sort(), [200, 201], plan);
    assert.equal(answers[0].data.id, answers[1].data.id, plan);
    assert.equal((await companyBots(user)).length, 1, plan);
  }
});

test("a create for a company the caller already has a bot for answers 200 at the limit", async (t) => {
  if (!db) return t.skip(SKIP);
  const user = await db.person("FREE");
  const made: string[] = [];
  for (const company of ["Acme", "Beta", "Gamma"]) {
    const answer = await db.call(user, "POST", "/bots", { postingId: await db.posting(company) });
    made.push(String(answer.data.id));
  }
  const again = await db.call(user, "POST", "/bots", { postingId: await db.posting("ACME"), displayName: "other name", color: "pink" });
  assert.equal(again.status, 200);
  assert.equal(again.data.id, made[0]);
  assert.equal(again.data.displayName, "Acme");
  assert.equal(again.data.color, "teal");
  const fourth = await db.call(user, "POST", "/bots", { postingId: await db.posting("Delta") });
  assert.equal(fourth.status, 403);
  assert.equal(fourth.error!.code, "BOT_LIMIT");
});

test("a company bot takes its company from the posting and is never an employer's", async (t) => {
  if (!db) return t.skip(SKIP);
  const user = await db.person("PRO");
  const answer = await db.call(user, "POST", "/bots", { postingId: await db.posting("모아페이"), color: "violet" });
  assert.equal(answer.status, 201);
  assert.deepEqual(
    { kind: answer.data.kind, displayName: answer.data.displayName, companyName: answer.data.companyName, color: answer.data.color, companyId: answer.data.companyId },
    { kind: "company", displayName: "모아페이", companyName: "모아페이", color: "violet", companyId: null });
  assert.deepEqual(await companyBots(user), [{
    id: answer.data.id, company_id: null, company_name: "모아페이", display_name: "모아페이", color: "violet",
  }]);
  const long = await db.call(user, "POST", "/bots", { postingId: await db.posting("긴".repeat(200)) });
  assert.deepEqual([long.status, long.data.displayName, long.data.companyName], [201, "긴".repeat(120), "긴".repeat(200)]);
});

test("create is refused without consent, for a draft posting, and for any body key outside the contract", async (t) => {
  if (!db) return t.skip(SKIP);
  const stranger = await db.person("PRO", false);
  const postingId = await db.posting("Acme");
  const refused = await db.call(stranger, "POST", "/bots", { postingId });
  assert.equal(refused.status, 403);
  assert.equal(refused.error!.code, "CONSENT_REQUIRED");
  assert.equal((await companyBots(stranger)).length, 0);

  const user = await db.person("PRO");
  assert.equal((await db.call(user, "POST", "/bots", { postingId: await db.posting("Hidden", "DRAFT") })).status, 404);
  assert.equal((await db.call(user, "POST", "/bots", { postingId: crypto.randomUUID() })).status, 404);
  const loose = await db.call(user, "POST", "/bots", { postingId, companyName: "Acme" });
  assert.equal(loose.status, 400);
  assert.equal(loose.error!.details.field, "companyName");
  assert.equal((await companyBots(user)).length, 0);
});

test("push works on every bot route before the first list", async (t) => {
  if (!db) return t.skip(SKIP);
  for (const [method, path, body, status] of [
    ["GET", "/bots/push", undefined, 200],
    ["PATCH", "/bots/push", { expectedRevision: 1, notificationsMuted: true }, 200],
    ["POST", "/bots/push/read", {}, 200],
    ["DELETE", "/bots/push/transcript", undefined, 204],
    ["DELETE", "/bots/push", undefined, 403],
  ] as const) {
    const user = await db.person("FREE");
    const answer = await db.call(user, method, path, body);
    assert.equal(answer.status, status, `${method} ${path}`);
    const listed = await db.pg.query("SELECT id, kind FROM bots WHERE user_id = $1::uuid", [user.id]);
    assert.deepEqual(listed.rows.map((row) => row.kind), ["push"], `${method} ${path}`);
    if (status === 200 && method !== "POST") assert.equal(answer.data.id, listed.rows[0].id);
  }
  const user = await db.person("FREE");
  const answers = await Promise.all(Array.from({ length: 8 }, () => db!.call(user, "GET", "/bots/push")));
  assert.deepEqual(answers.map((a) => a.status), Array(8).fill(200));
  assert.equal(new Set(answers.map((a) => a.data.id)).size, 1);
});

test("PATCH stores colour and mute, and keeps the Push Bot's name and colour fixed", async (t) => {
  if (!db) return t.skip(SKIP);
  const user = await db.person("PRO");
  const bot = await db.call(user, "POST", "/bots", { postingId: await db.posting("Acme") });
  const patched = await db.call(user, "PATCH", `/bots/${bot.data.id}`, { expectedRevision: 1, color: "coral", notificationsMuted: true });
  assert.equal(patched.status, 200);
  assert.deepEqual([patched.data.color, patched.data.notificationsMuted, patched.data.revision], ["coral", true, 2]);
  const read = await db.call(user, "GET", `/bots/${bot.data.id}`);
  assert.deepEqual([read.data.color, read.data.notificationsMuted], ["coral", true]);
  assert.equal((await db.call(user, "PATCH", `/bots/${bot.data.id}`, { expectedRevision: 1, color: "sky" })).status, 409);
  const push = await db.call(user, "PATCH", "/bots/push", { expectedRevision: 1, color: "sky" });
  assert.equal(push.status, 400);
  assert.equal(push.error!.details.field, "color");
  assert.equal((await db.call(user, "GET", "/bots/push")).data.color, null);
});

test("the colours the route accepts are the colours the database accepts", async (t) => {
  if (!db) return t.skip(SKIP);
  const check = await db.pg.query("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'bots_color_chk'");
  const names = [...String(check.rows[0].def).matchAll(/'([a-z]+)'/g)].map((match) => match[1]);
  assert.deepEqual(names, [...BOT_COLORS]);
});
