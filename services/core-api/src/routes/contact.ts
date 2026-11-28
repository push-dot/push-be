import { isUnique, one, query } from "../db.ts";
import { HttpError, data, fieldError, sha256Hex } from "../http.ts";
import { createMailer } from "../mail/mailer.ts";
import { ts } from "../page.ts";
import type { Ctx } from "../types.ts";
import { bindIdentity, checkPhoneCode, codeOf, consumePhoneCode, phoneOf, taken } from "./phone-auth.ts";
import { readObject } from "./recruiting-shared.ts";

// Where an employer reaches a personal applicant: a phone checked by SMS and an email checked by a mail code.
const CONTACT_PATH = "/api/v1/me/contact";
const PHONE_PATH = "/api/v1/me/contact/phone";
const EMAIL_SEND_PATH = "/api/v1/me/contact/email/send";
const EMAIL_PATH = "/api/v1/me/contact/email";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_COOLDOWN_SEC = 60;
const EMAIL_TTL_SEC = 600;
const EMAIL_ATTEMPTS = 5;

const CONTACT = "SELECT phone, contact_email, email, email_verified_at FROM users WHERE id = $1";
const BY_PHONE = "SELECT id FROM users WHERE phone = $1 AND is_employer = false";
const SET_PHONE = "UPDATE users SET phone = $2 WHERE id = $1";
const SET_EMAIL = "UPDATE users SET contact_email = $2, contact_email_verified_at = $3 WHERE id = $1";
const LATEST_MAIL = "SELECT sent_at FROM contact_email_codes WHERE user_id = $1 ORDER BY sent_at DESC LIMIT 1";
const CONSUME_MAIL_OPEN = "UPDATE contact_email_codes SET consumed_at = $2 WHERE user_id = $1 AND consumed_at IS NULL";
const INSERT_MAIL = "INSERT INTO contact_email_codes (id, user_id, email, code_hash, expires_at, attempts, sent_at, consumed_at) VALUES ($1,$2,$3,$4,$5,0,$6,NULL)";
const ACTIVE_MAIL = "SELECT id, email, code_hash, expires_at, attempts FROM contact_email_codes WHERE user_id = $1 AND consumed_at IS NULL ORDER BY sent_at DESC LIMIT 1";
const TAKE_MAIL_ATTEMPT = "UPDATE contact_email_codes SET attempts = attempts + 1 WHERE id = $1 AND attempts < $2 AND consumed_at IS NULL RETURNING attempts";
const CONSUME_MAIL = "UPDATE contact_email_codes SET consumed_at = $2 WHERE id = $1 AND consumed_at IS NULL RETURNING id";

// The other account keeps its own rows; the caller gets a copy of each live document (latest version) and file.
const COPY_DOCUMENTS = `WITH d AS (
    SELECT x.id, x.title, x.kind, x.template, x.language, x.latest_version_id, gen_random_uuid() AS nid, gen_random_uuid() AS vid
    FROM documents x WHERE x.user_id = $1 AND x.status <> 'ARCHIVED' AND x.latest_version_id IS NOT NULL
  ), docs AS (
    INSERT INTO documents (id, user_id, revision, application_id, title, kind, template, language, status, latest_version_id, finalized_version_id, created_at, updated_at)
    SELECT d.nid, $2, 1, NULL, d.title, d.kind, d.template, d.language, 'DRAFT', d.vid, NULL, $3, $3 FROM d RETURNING id
  ), vers AS (
    INSERT INTO document_versions (id, user_id, document_id, application_id, number, content, blocks, change_note, quality, created_at)
    SELECT d.vid, $2, d.nid, NULL, 1, v.content, v.blocks, '', v.quality, $3 FROM d JOIN document_versions v ON v.id = d.latest_version_id
  ), files AS (
    INSERT INTO sources (id, user_id, file_name, mime_type, size, sha256, path, status, created_at, page_count, origin, content, doc_kind)
    SELECT gen_random_uuid(), $2, s.file_name, s.mime_type, s.size, s.sha256, s.path, s.status, $3, s.page_count, s.origin, s.content, s.doc_kind
    FROM sources s WHERE s.user_id = $1 RETURNING id
  )
  SELECT (SELECT count(*) FROM docs) AS documents, (SELECT count(*) FROM files) AS files`;
const RELEASE_PHONE = "UPDATE users SET phone = NULL WHERE id = $1 AND phone = $2";
const DROP_PHONE_LOGIN = "DELETE FROM user_identities WHERE user_id = $1 AND provider = 'phone' AND provider_subject = $2";

const text = (value: unknown): string | null => (value === null || value === undefined || value === "" ? null : String(value));

const personal = (ctx: Ctx): void => {
  if (ctx.user.accountType === "EMPLOYER") {throw new HttpError(403, "FORBIDDEN", "contact is for personal accounts");}
};

const emailOf = (value: unknown): string => {
  if (typeof value !== "string" || !EMAIL_RE.test(value.trim()) || value.trim().length > 254) {throw fieldError("email", "must be an email");}
  return value.trim().toLowerCase();
};

const six = (): string => {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return String(buf[0] % 1_000_000).padStart(6, "0");
};

const contactOf = async (ctx: Ctx) => {
  const row = await one(ctx.deps.query, CONTACT, [ctx.user.id]);
  const login = text(row?.email);
  return {
    phone: text(row?.phone),
    email: text(row?.contact_email),
    loginEmail: login && row?.email_verified_at ? login : null,
  };
};

/** Missing parts of the contact an apply needs, in a fixed order. */
export const missingContact = async (ctx: Ctx): Promise<Array<"PHONE" | "EMAIL">> => {
  const { phone, email } = await contactOf(ctx);
  return [...(phone ? [] : ["PHONE" as const]), ...(email ? [] : ["EMAIL" as const])];
};

const getContact = async (ctx: Ctx): Promise<Response> => {
  personal(ctx);
  return data(200, await contactOf(ctx), ctx.rid);
};

const setPhone = async (ctx: Ctx, phone: string): Promise<void> => {
  try {
    await query(ctx.deps.query, SET_PHONE, [ctx.user.id, phone]);
  } catch (error) {
    if (!isUnique(error)) {throw error;}
    throw taken("phone");
  }
  await bindIdentity(ctx, ctx.user.id, "phone", phone);
};

/**
 * Taken numbers are found only after the code checks out, so the response never says whether a number is
 * registered. Then 409 PHONE_TAKEN leaves the code open; the same code again with moveDocuments copies the
 * other account's documents and files here and moves the number (and its phone login) to this account.
 */
const verifyPhone = async (ctx: Ctx): Promise<Response> => {
  personal(ctx);
  const body = await readObject(ctx.request);
  const phone = phoneOf(body);
  const codeId = await checkPhoneCode(ctx, phone, codeOf(body));
  const owner = await one(ctx.deps.query, BY_PHONE, [phone]);
  const other = owner && String(owner.id) !== ctx.user.id ? String(owner.id) : null;
  if (other && body.moveDocuments !== true) {
    throw new HttpError(409, "PHONE_TAKEN", "this phone belongs to another account", { conflict: "PHONE", provider: "phone", canMoveDocuments: true });
  }
  await consumePhoneCode(ctx, codeId);
  if (!other) {
    await setPhone(ctx, phone);
    return data(200, { phone }, ctx.rid);
  }
  const copied = await one(ctx.deps.query, COPY_DOCUMENTS, [other, ctx.user.id, ctx.now.toISOString()]);
  await query(ctx.deps.query, RELEASE_PHONE, [other, phone]);
  await query(ctx.deps.query, DROP_PHONE_LOGIN, [other, phone]);
  await setPhone(ctx, phone);
  return data(200, { phone, moved: { documents: Number(copied?.documents ?? 0), files: Number(copied?.files ?? 0) } }, ctx.rid);
};

const sendEmail = async (ctx: Ctx): Promise<Response> => {
  personal(ctx);
  const email = emailOf((await readObject(ctx.request)).email);
  const { loginEmail } = await contactOf(ctx);
  // The login email was already verified by its provider or link, so it needs no second code.
  if (loginEmail && loginEmail.toLowerCase() === email) {
    await query(ctx.deps.query, SET_EMAIL, [ctx.user.id, email, ctx.now.toISOString()]);
    return data(200, { email, verified: true }, ctx.rid);
  }
  const latest = await one(ctx.deps.query, LATEST_MAIL, [ctx.user.id]);
  if (latest?.sent_at !== null && latest?.sent_at !== undefined) {
    const wait = Math.ceil((Date.parse(String(latest.sent_at)) + EMAIL_COOLDOWN_SEC * 1000 - ctx.now.getTime()) / 1000);
    if (wait > 0) {throw new HttpError(429, "RATE_LIMITED", "resend cooldown", { retryAfterSec: wait });}
  }
  const id = crypto.randomUUID();
  const code = six();
  const now = ctx.now.toISOString();
  const expires = new Date(ctx.now.getTime() + EMAIL_TTL_SEC * 1000);
  await query(ctx.deps.query, CONSUME_MAIL_OPEN, [ctx.user.id, now]);
  await query(ctx.deps.query, INSERT_MAIL, [id, ctx.user.id, email, await sha256Hex(`${id}:${code}`), expires.toISOString(), now]);
  const mailer = ctx.deps.mailer ?? createMailer(ctx.env, ctx.deps.fetch);
  await mailer.send({
    to: email,
    subject: "[Push] 이메일 인증 코드",
    text: `인증 코드: ${code}\n10분 안에 입력해 주세요.`,
    html: `<p>인증 코드: <strong>${code}</strong></p><p>10분 안에 입력해 주세요.</p>`,
    idempotencyKey: id,
  });
  return data(202, { cooldownSeconds: EMAIL_COOLDOWN_SEC, expiresAt: ts(expires) }, ctx.rid);
};

const verifyEmail = async (ctx: Ctx): Promise<Response> => {
  personal(ctx);
  const body = await readObject(ctx.request);
  const email = emailOf(body.email);
  const code = codeOf(body);
  const row = await one(ctx.deps.query, ACTIVE_MAIL, [ctx.user.id]);
  if (!row || String(row.email) !== email) {throw new HttpError(400, "EMAIL_CODE_INVALID", "code is invalid");}
  if (Date.parse(String(row.expires_at)) <= ctx.now.getTime()) {
    await query(ctx.deps.query, CONSUME_MAIL, [String(row.id), ctx.now.toISOString()]);
    throw new HttpError(400, "EMAIL_CODE_EXPIRED", "code is expired");
  }
  const attempt = Number(row.attempts) < EMAIL_ATTEMPTS ? await one(ctx.deps.query, TAKE_MAIL_ATTEMPT, [String(row.id), EMAIL_ATTEMPTS]) : null;
  if (!attempt) {throw new HttpError(429, "RATE_LIMITED", "too many attempts", { reason: "TOO_MANY_ATTEMPTS", maxAttempts: EMAIL_ATTEMPTS });}
  if (await sha256Hex(`${String(row.id)}:${code}`) !== String(row.code_hash)) {
    throw new HttpError(400, "EMAIL_CODE_INVALID", "code is invalid", { attemptsLeft: Math.max(0, EMAIL_ATTEMPTS - Number(attempt.attempts)) });
  }
  if (!(await one(ctx.deps.query, CONSUME_MAIL, [String(row.id), ctx.now.toISOString()]))) {
    throw new HttpError(400, "EMAIL_CODE_INVALID", "code is invalid");
  }
  await query(ctx.deps.query, SET_EMAIL, [ctx.user.id, email, ctx.now.toISOString()]);
  return data(200, { email, verified: true }, ctx.rid);
};

export const dispatchContact = async (ctx: Ctx, path: string): Promise<Response | null> => {
  const method = ctx.request.method;
  if (path === CONTACT_PATH) {return method === "GET" ? getContact(ctx) : null;}
  if (method !== "POST") {return null;}
  if (path === PHONE_PATH) {return verifyPhone(ctx);}
  if (path === EMAIL_SEND_PATH) {return sendEmail(ctx);}
  if (path === EMAIL_PATH) {return verifyEmail(ctx);}
  return null;
};
