// POST /documents for the app's copy (copyBody + a version): a document that belongs to no posting (hub profile,
// portfolio) is copied without an applicationId, and one that does belong to a posting keeps it. Real Postgres
// (BILLING_PG_URL), where the owner check and the stored columns are visible.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { botsPg, type BotsPg, type Person } from "../test-support/bots-pg.ts";

const URL_ = process.env.BILLING_PG_URL;
const SKIP = "set BILLING_PG_URL to a migrated Postgres";

let db: BotsPg | undefined;
before(async () => { if (URL_) db = await botsPg(URL_); });
after(async () => { await db?.close(); });

const CONTENT = { type: "doc", content: [{ type: "paragraph", attrs: { blockId: "block-1" }, content: [{ type: "text", text: "본문" }] }] };

const application = async (user: Person): Promise<string> => {
  const apply = await db!.call(user, "POST", `/postings/${await db!.posting("복사회사")}/apply`, { documentIds: [], sourceIds: [] });
  assert.equal(apply.status, 201);
  return String(apply.data.id);
};

/** What the app does in duplicateDocument: POST documents with the source's fields, then POST its latest content as a version. */
const copy = async (user: Person, source: { applicationId: string | null; kind: string }) => {
  const body = { applicationId: source.applicationId, title: "원본 사본", kind: source.kind, template: "MODERN", language: "en" };
  const made = await db!.call(user, "POST", "/documents", body);
  if (made.status !== 201) return { made };
  const saved = await db!.call(user, "POST", `/documents/${made.data.id}/versions`, { expectedRevision: made.data.revision, content: CONTENT, blocks: [{ id: "block-1", text: "본문" }] });
  return { made, saved };
};

for (const kind of ["HUB_PROFILE", "PORTFOLIO", "RESUME", "COVER_LETTER", "CAREER_STATEMENT"]) {
  test(`a ${kind} copy without a posting keeps its kind, content and owner`, async (t) => {
    if (!db) return t.skip(SKIP);
    const user = await db.person("PRO");
    const { made, saved } = await copy(user, { applicationId: null, kind });
    assert.equal(made.status, 201);
    assert.deepEqual(
      [made.data.kind, made.data.applicationId ?? null, made.data.template, made.data.language, made.data.status],
      [kind, null, "MODERN", "en", "DRAFT"]);
    assert.equal(saved!.status, 201);
    const row = (await db.pg.query("SELECT user_id, application_id, kind FROM documents WHERE id = $1::uuid", [made.data.id])).rows[0]!;
    assert.deepEqual([row.user_id, row.application_id, row.kind], [user.id, null, kind]);
    const version = await db.call(user, "GET", `/documents/${made.data.id}/versions/${(saved!.data.version as { id: string }).id}`);
    assert.deepEqual(version.data.content, CONTENT);
  });
}

test("a copy that leaves applicationId out of the body is accepted too", async (t) => {
  if (!db) return t.skip(SKIP);
  const user = await db.person("PRO");
  const made = await db.call(user, "POST", "/documents", { title: "t", kind: "PORTFOLIO", template: "SIMPLE", language: "ko" });
  assert.equal(made.status, 201);
  assert.equal(made.data.applicationId ?? null, null);
});

test("a copy of a document under a posting keeps that applicationId", async (t) => {
  if (!db) return t.skip(SKIP);
  const user = await db.person("PRO");
  const applicationId = await application(user);
  const { made } = await copy(user, { applicationId, kind: "RESUME" });
  assert.equal(made.status, 201);
  assert.equal(made.data.applicationId, applicationId);
});

test("an applicationId that is not the caller's is still 404, and a malformed one is 400", async (t) => {
  if (!db) return t.skip(SKIP);
  const [me, other] = [await db.person("PRO"), await db.person("PRO")];
  const theirs = await application(other);
  assert.equal((await copy(me, { applicationId: theirs, kind: "RESUME" })).made.status, 404);
  assert.equal((await copy(me, { applicationId: crypto.randomUUID(), kind: "RESUME" })).made.status, 404);
  assert.equal((await copy(me, { applicationId: "nope", kind: "RESUME" })).made.status, 400);
});

test("a copy is listed for its owner only", async (t) => {
  if (!db) return t.skip(SKIP);
  const [me, other] = [await db.person("PRO"), await db.person("PRO")];
  const { made } = await copy(me, { applicationId: null, kind: "HUB_PROFILE" });
  const mine = await db.call(me, "GET", "/documents?kind=HUB_PROFILE");
  assert.ok((mine.body.data as { id: string }[]).some((d) => d.id === made.data.id));
  const theirs = await db.call(other, "GET", "/documents?kind=HUB_PROFILE");
  assert.deepEqual(theirs.body.data, []);
});
