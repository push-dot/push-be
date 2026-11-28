// The contact an apply needs (a phone and an email, each checked by a code) and the move of documents from the
// account that already holds the phone. Real Postgres (BILLING_PG_URL), where the copy statement runs for real.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import type { Mail } from "../src/mail/mailer.ts";
import { botsPg } from "../test-support/bots-pg.ts";
import type { BotsPg, Person } from "../test-support/bots-pg.ts";

const URL_ = process.env.BILLING_PG_URL;
const SKIP = "set BILLING_PG_URL to a migrated Postgres";

let db: BotsPg | undefined;
before(async () => { if (URL_) {db = await botsPg(URL_);} });
after(async () => { await db?.close(); });

/** A personal account the way a fresh social login leaves it: no phone and no contact email. */
const bare = async (email: string | null = null): Promise<Person> => {
  const user = await db!.person("FREE");
  await db!.pg.query("UPDATE users SET phone = NULL, contact_email = NULL, contact_email_verified_at = NULL, email = $2, email_verified_at = CASE WHEN $2::text IS NULL THEN NULL ELSE now() END WHERE id = $1", [user.id, email]);
  return user;
};

const freshPhone = (): string => `+8210${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;

const smsTo = (codes: Array<string>) => ({ sms: { send: async (_phone: string, code: string) => { codes.push(code); } } });
const mailTo = (mails: Array<Mail>) => ({ mailer: { send: async (mail: Mail) => { mails.push(mail); } } });

test("apply waits for a checked phone and email, then goes through", { skip: URL_ ? false : SKIP }, async () => {
  const login = `ada-${crypto.randomUUID()}@push.app`;
  const user = await bare(login);
  const posting = await db!.posting("연락처회사");
  const blocked = await db!.call(user, "POST", `/postings/${posting}/apply`, { documentIds: [], sourceIds: [] });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.error?.code, "CONTACT_REQUIRED");
  assert.deepEqual(blocked.error?.details.missing, ["PHONE", "EMAIL"]);

  const contact = await db!.call(user, "GET", "/me/contact");
  assert.deepEqual(contact.data, { phone: null, email: null, loginEmail: login });

  const codes: Array<string> = [];
  const phone = freshPhone();
  assert.equal((await db!.call(user, "POST", "/auth/phone/send", { phone }, smsTo(codes))).status, 202);
  const verified = await db!.call(user, "POST", "/me/contact/phone", { phone, code: codes[0] });
  assert.equal(verified.status, 200);
  assert.deepEqual(verified.data, { phone });

  // The verified login email is saved without a code.
  const mails: Array<Mail> = [];
  const same = await db!.call(user, "POST", "/me/contact/email/send", { email: login.toUpperCase() }, mailTo(mails));
  assert.equal(same.status, 200);
  assert.deepEqual(same.data, { email: login, verified: true });
  assert.equal(mails.length, 0);

  const applied = await db!.call(user, "POST", `/postings/${posting}/apply`, { documentIds: [], sourceIds: [] });
  assert.equal(applied.status, 201);
});

test("another email is saved only with the mailed code", { skip: URL_ ? false : SKIP }, async () => {
  const user = await bare(`login-${crypto.randomUUID()}@push.app`);
  const mails: Array<Mail> = [];
  const sent = await db!.call(user, "POST", "/me/contact/email/send", { email: "work@push.app" }, mailTo(mails));
  assert.equal(sent.status, 202);
  assert.equal(mails[0]?.to, "work@push.app");
  const code = /(\d{6})/.exec(mails[0]?.text ?? "")?.[1] ?? "";
  assert.equal(code.length, 6);

  const again = await db!.call(user, "POST", "/me/contact/email/send", { email: "work@push.app" }, mailTo(mails));
  assert.equal(again.status, 429);

  const wrong = await db!.call(user, "POST", "/me/contact/email", { email: "work@push.app", code: code === "000000" ? "111111" : "000000" });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.error?.code, "EMAIL_CODE_INVALID");
  assert.equal(wrong.error?.details.attemptsLeft, 4);
  const otherEmail = await db!.call(user, "POST", "/me/contact/email", { email: "else@push.app", code });
  assert.equal(otherEmail.error?.code, "EMAIL_CODE_INVALID");

  const ok = await db!.call(user, "POST", "/me/contact/email", { email: "work@push.app", code });
  assert.equal(ok.status, 200);
  assert.equal((await db!.call(user, "GET", "/me/contact")).data.email, "work@push.app");
  const reused = await db!.call(user, "POST", "/me/contact/email", { email: "work@push.app", code });
  assert.equal(reused.status, 400);
});

test("a phone held by another account is found after the code, and moving copies its documents", { skip: URL_ ? false : SKIP }, async () => {
  const owner = await bare();
  const phone = freshPhone();
  await db!.pg.query("UPDATE users SET phone = $2 WHERE id = $1", [owner.id, phone]);
  await db!.pg.query("INSERT INTO user_identities (user_id, provider, provider_subject) VALUES ($1, 'phone', $2)", [owner.id, phone]);
  const docId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  await db!.pg.query("INSERT INTO documents (id, user_id, application_id, title, kind, template, latest_version_id) VALUES ($1, $2, NULL, '이력서', 'RESUME', 'MODERN', $3)", [docId, owner.id, versionId]);
  await db!.pg.query("INSERT INTO document_versions (id, user_id, document_id, application_id, number, content) VALUES ($1, $2, $3, NULL, 1, '{\"type\":\"doc\"}'::jsonb)", [versionId, owner.id, docId]);
  await db!.pg.query("INSERT INTO sources (id, user_id, file_name, mime_type, size, sha256, path) VALUES (gen_random_uuid(), $1, 'a.pdf', 'application/pdf', 3, 'x', 'k/a.pdf')", [owner.id]);

  const user = await bare();
  const codes: Array<string> = [];
  await db!.call(user, "POST", "/auth/phone/send", { phone }, smsTo(codes));
  const conflict = await db!.call(user, "POST", "/me/contact/phone", { phone, code: codes[0] });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.error?.code, "PHONE_TAKEN");
  assert.equal(conflict.error?.details.canMoveDocuments, true);

  const moved = await db!.call(user, "POST", "/me/contact/phone", { phone, code: codes[0], moveDocuments: true });
  assert.equal(moved.status, 200);
  assert.deepEqual(moved.data, { phone, moved: { documents: 1, files: 1 } });

  const mine = await db!.pg.query("SELECT d.title, d.application_id, v.content FROM documents d JOIN document_versions v ON v.id = d.latest_version_id WHERE d.user_id = $1", [user.id]);
  assert.equal(mine.rows.length, 1);
  assert.equal(mine.rows[0].title, "이력서");
  assert.equal(mine.rows[0].application_id, null);
  const phones = await db!.pg.query("SELECT id, phone FROM users WHERE id = ANY($1::uuid[]) ORDER BY id", [[owner.id, user.id]]);
  assert.deepEqual(Object.fromEntries(phones.rows.map((row) => [String(row.id), row.phone])), { [owner.id]: null, [user.id]: phone });
  const logins = await db!.pg.query("SELECT user_id FROM user_identities WHERE provider = 'phone' AND provider_subject = $1", [phone]);
  assert.deepEqual(logins.rows.map((row) => String(row.user_id)), [user.id]);
  // The owner keeps its own rows.
  assert.equal((await db!.pg.query("SELECT 1 FROM documents WHERE user_id = $1", [owner.id])).rows.length, 1);

  for (const id of [owner.id, user.id]) {
    await db!.pg.query("UPDATE documents SET latest_version_id = NULL WHERE user_id = $1", [id]);
    await db!.pg.query("DELETE FROM document_versions WHERE user_id = $1", [id]);
    await db!.pg.query("DELETE FROM documents WHERE user_id = $1", [id]);
    await db!.pg.query("DELETE FROM sources WHERE user_id = $1", [id]);
  }
});
