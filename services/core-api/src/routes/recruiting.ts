import { isMissingRelation, isUndefinedColumn, isUnique, one, query } from "../db.ts";
import { queryForms, searchFields } from "../hangul.ts";
import {
  HttpError, asBool, codePoints, data, fieldError, jsonList, noContent, pageBody, requireUuid,
} from "../http.ts";
import { pageOf, pageResult, ts } from "../page.ts";
import type { Ctx } from "../types.ts";

const JOB_CATEGORIES = new Set(["dev", "data", "design", "plan", "marketing", "sales", "hr", "ops"]);
const EMPLOYMENT = new Set(["full_time", "contract", "intern", "freelance", "dispatch"]);
const CAREER_YEARS = new Set(["0", "1-3", "4-6", "7-9", "10+"]);
const POST_CATEGORIES = new Set(["work", "dev", "daily", "career", "talk", "coffeechat", "marketing"]);
const TENURE = new Map<string, [number, number]>([["0-2", [0, 2]], ["3-5", [3, 5]], ["6-9", [6, 9]], ["10+", [10, 80]]]);
const CAREER_STATUS = new Set(["satisfied", "seeking", "feedback"]);
const LINK_KINDS = new Set(["job", "github", "portfolio", "blog", "other"]);
const TONES = new Set(["as_is", "professional", "confident", "concise", "technical", "friendly"]);
const VISIBILITY = new Set(["everyone", "followers", "private"]);
const CONTACT = new Set(["accepted", "followers", "everyone", "private"]);
const FREE_MAIL = new Set([
  "gmail.com", "googlemail.com", "naver.com", "daum.net", "hanmail.net", "kakao.com",
  "outlook.com", "hotmail.com", "icloud.com", "yahoo.com",
]);
const IMAGE_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const GUEST_ID = "00000000-0000-0000-0000-000000000000";
const NOTIFY_COLUMN: Record<string, string> = {
  DEADLINE: "notify_deadline",
  OFFER: "notify_offer",
  COMMENT: "notify_comment",
  AI_DONE: "notify_ai_done",
  APPLICATION_STAGE: "notify_application_stage",
};
const EMPLOYER_STAGES = new Set(["SCREENING", "INTERVIEW", "OFFER", "REJECTED"]);
const TERMINAL_STAGES = new Set(["ACCEPTED", "REJECTED", "WITHDRAWN"]);

function unprocessable(field: string, message: string): HttpError {
  return new HttpError(422, "VALIDATION_ERROR", message, { field });
}

function notFound(): HttpError {
  return new HttpError(404, "NOT_FOUND", "resource not found");
}

async function readObject(request: Request): Promise<Record<string, unknown>> {
  const raw = await request.text();
  if (!raw) throw new HttpError(400, "VALIDATION_ERROR", "request body required");
  try {
    const body = JSON.parse(raw) as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("shape");
    return body as Record<string, unknown>;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, "VALIDATION_ERROR", "invalid request body");
  }
}

function rejectFields(body: Record<string, unknown>, fields: string[]): void {
  for (const field of fields) {
    if (field in body) throw fieldError(field, "server-managed field");
  }
}

function textOf(value: unknown, field: string, min: number, max: number): string {
  if (typeof value !== "string") throw fieldError(field, "must be a string");
  const size = codePoints(value);
  if (size < min || size > max) throw fieldError(field, `${field} must be ${min}-${max} characters`);
  return value;
}

function optionalText(value: unknown, field: string, max: number): string | null {
  if (value == null) return null;
  return textOf(value, field, 0, max);
}

function intOf(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw fieldError(field, "invalid " + field);
  }
  return value;
}

function boolOf(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw fieldError(field, "must be a boolean");
  return value;
}

function dateOf(value: unknown, field: string): string | null {
  if (value == null) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw fieldError(field, "must be YYYY-MM-DD");
  }
  return value;
}

function httpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password && Boolean(url.hostname);
  } catch {
    return false;
  }
}

function stringList(value: unknown, field: string, maxItems: number, maxLen: number): string[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw fieldError(field, "must be an array");
  if (value.length > maxItems) throw fieldError(field, "too many items");
  return value.map((item) => textOf(item, field, 1, maxLen));
}

function imageKeyOf(value: unknown, field: string): string | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || !IMAGE_KEY.test(value) || value.includes("..")) {
    throw fieldError(field, "invalid image key");
  }
  return value;
}

function imageUrl(key: unknown): string | null {
  if (key == null || key === "") return null;
  return "/api/v1/uploads/images/" + encodeURIComponent(String(key));
}

function jsonObject(value: unknown): Record<string, unknown> {
  let raw = value;
  if (typeof raw === "string") {
    try { raw = JSON.parse(raw); } catch { return {}; }
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return raw as Record<string, unknown>;
}

function splitList(url: URL, name: string): string[] {
  const raw = url.searchParams.get(name);
  if (!raw) return [];
  return raw.split(",").map((part) => part.trim()).filter((part) => part.length > 0);
}

function enumList(url: URL, name: string, allowed: Set<string>, field: string): string[] {
  const values = splitList(url, name);
  for (const value of values) {
    if (!allowed.has(value)) throw unprocessable(field, "unsupported " + field);
  }
  return values;
}

function plainList(url: URL, name: string, maxLen: number, field: string): string[] {
  const values = splitList(url, name);
  for (const value of values) {
    if (codePoints(value) > maxLen) throw fieldError(field, "too long");
  }
  return values;
}

function pushArray(params: unknown[], values: string[]): number {
  params.push(values.join("\u001f"));
  return params.length;
}

function anyOf(index: number): string {
  return `string_to_array($${index}, E'\\x1f')`;
}

function appendTextSearch(sql: string, params: unknown[], q: string, columns: string[]): string {
  if (!q) return sql;
  if (codePoints(q) > 200) throw fieldError("q", "must be at most 200 characters");
  const forms = queryForms(q);
  params.push(forms.raw, forms.choseong, forms.jamo, forms.hangul, forms.hangulJamo);
  const raw = params.length - 4;
  const cho = params.length - 3;
  const jamo = params.length - 2;
  const hangul = params.length - 1;
  const hangulJamo = params.length;
  const parts = columns.map((column) => `${column} ILIKE '%' || $${raw} || '%'`).join(" OR ");
  const hangulParts = columns.map((column) => `${column} ILIKE '%' || $${hangul} || '%'`).join(" OR ");
  sql += ` AND ((${parts})
    OR ($${cho} <> '' AND search_choseong LIKE '%' || $${cho} || '%')
    OR ($${jamo} <> '' AND search_jamo LIKE $${jamo} || '%')
    OR ($${hangul} <> '' AND ((${hangulParts}) OR search_jamo LIKE $${hangulJamo} || '%')))`;
  return sql;
}

function appendPostingFilters(sql: string, params: unknown[], url: URL, withLocation: boolean): string {
  const q = url.searchParams.get("q") || "";
  if (q) {
    if (codePoints(q) > 200) throw fieldError("q", "must be at most 200 characters");
    const forms = queryForms(q);
    params.push(forms.raw, forms.choseong, forms.jamo, forms.hangul, forms.hangulJamo);
    const raw = params.length - 4;
    const cho = params.length - 3;
    const jamo = params.length - 2;
    const hangul = params.length - 1;
    const hangulJamo = params.length;
    sql += ` AND (
      p.title ILIKE '%' || $${raw} || '%' OR p.company ILIKE '%' || $${raw} || '%'
      OR ($${cho} <> '' AND p.search_choseong LIKE '%' || $${cho} || '%')
      OR ($${jamo} <> '' AND p.search_jamo LIKE $${jamo} || '%')
      OR ($${hangul} <> '' AND (
        p.title ILIKE '%' || $${hangul} || '%' OR p.company ILIKE '%' || $${hangul} || '%'
        OR p.search_jamo LIKE $${hangulJamo} || '%'
      ))
    )`;
  }
  const categories = enumList(url, "category", JOB_CATEGORIES, "category");
  if (categories.length) {
    const i = pushArray(params, categories);
    sql += ` AND p.job_category = ANY(${anyOf(i)})`;
  }
  const skills = plainList(url, "skills", 40, "skills");
  if (skills.length) {
    const i = pushArray(params, skills);
    sql += ` AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(p.skills) sk WHERE sk = ANY(${anyOf(i)}))`;
  }
  const years = enumList(url, "careerYears", CAREER_YEARS, "careerYears");
  if (years.length) {
    const i = pushArray(params, years);
    const arr = anyOf(i);
    sql += ` AND (
      ('0' = ANY(${arr}) AND p.career_min = 0)
      OR ('1-3' = ANY(${arr}) AND p.career_min <= 3 AND COALESCE(p.career_max, 99) >= 1)
      OR ('4-6' = ANY(${arr}) AND p.career_min <= 6 AND COALESCE(p.career_max, 99) >= 4)
      OR ('7-9' = ANY(${arr}) AND p.career_min <= 9 AND COALESCE(p.career_max, 99) >= 7)
      OR ('10+' = ANY(${arr}) AND COALESCE(p.career_max, p.career_min) >= 10)
    )`;
  }
  if (withLocation) {
    const locations = plainList(url, "location", 80, "location");
    if (locations.length) {
      const i = pushArray(params, locations);
      sql += ` AND EXISTS (
        SELECT 1 FROM unnest(${anyOf(i)}) loc
        WHERE p.location = loc OR (loc <> '원격' AND p.location LIKE loc || ' %')
      )`;
    }
  }
  const employment = enumList(url, "employmentType", EMPLOYMENT, "employmentType");
  if (employment.length) {
    const i = pushArray(params, employment);
    sql += ` AND p.employment_type = ANY(${anyOf(i)})`;
  }
  return sql;
}

function postingDto(row: Record<string, unknown>, detail: boolean): Record<string, unknown> {
  const dto: Record<string, unknown> = {
    id: String(row.id),
    company: String(row.company ?? ""),
    title: String(row.title ?? ""),
    jobCategory: String(row.job_category ?? ""),
    imageUrl: imageUrl(row.image_key),
    skills: jsonList(row.skills).map(String),
    careerMin: Number(row.career_min ?? 0),
    careerMax: row.career_max == null ? null : Number(row.career_max),
    location: String(row.location ?? ""),
    employmentType: String(row.employment_type ?? ""),
    deadline: row.deadline == null || row.deadline === "" ? null : String(row.deadline).slice(0, 10),
    bookmarked: asBool(row.bookmarked),
    applied: asBool(row.applied),
    sourceUrl: row.source_url == null ? null : String(row.source_url),
    createdAt: ts(row.created_at),
    revision: Number(row.revision ?? 1),
    closedAt: ts(row.closed_at),
  };
  if (detail) {
    dto.description = String(row.description ?? "");
    dto.requirements = jsonList(row.requirements).map(String);
    dto.workConditions = jsonObject(row.work_conditions);
    dto.preferred = jsonList(row.preferred).map(String);
  }
  return dto;
}

const POSTING_COLS = "p.id, p.company, p.title, p.job_category, p.image_key, p.skills, p.career_min, p.career_max, p.location, p.employment_type, p.deadline, p.source_url, p.created_at, p.revision, p.preferred, p.closed_at";

function postingFlags(userParam: string): string {
  return `EXISTS (SELECT 1 FROM bookmarks b WHERE b.user_id = ${userParam} AND b.posting_id = p.id) AS bookmarked,
    EXISTS (SELECT 1 FROM jobs j JOIN applications a ON a.job_id = j.id AND a.user_id = ${userParam} WHERE j.source_posting_id = p.id) AS applied`;
}

async function listPostings(ctx: Ctx): Promise<Response> {
  const page = pageOf(ctx.url);
  const params: unknown[] = [ctx.user.id];
  let where = " FROM job_postings p WHERE p.closed_at IS NULL";
  where = appendPostingFilters(where, params, ctx.url, true);
  // $1 (the user) is only used by the row flags; Postgres rejects a bind with unused parameters, so reference it.
  const count = await one(ctx.deps.query, "SELECT count(*)::int AS total" + where + " AND $1::uuid IS NOT NULL", params.slice());
  const total = Number(count?.total ?? 0);
  let sql = `SELECT ${POSTING_COLS}, ${postingFlags("$1")}` + where;
  if (page.cursor) {
    params.push(page.cursor.createdAt, page.cursor.id);
    sql += ` AND (p.created_at, p.id) < ($${params.length - 1}, $${params.length})`;
  }
  params.push(page.limit + 1);
  sql += ` ORDER BY p.created_at DESC, p.id DESC LIMIT $${params.length}`;
  const rows = await query(ctx.deps.query, sql, params);
  const mapped = rows.rows.map((row) => ({ item: postingDto(row, false), createdAt: row.created_at, id: String(row.id) }));
  const paged = pageResult(mapped, page.limit, (row) => ({ createdAt: row.createdAt, id: row.id }));
  return pageBody(paged.items.map((row) => row.item), paged.nextCursor, paged.hasMore, ctx.rid, total);
}

async function listPostingLocations(ctx: Ctx): Promise<Response> {
  const params: unknown[] = [ctx.user.id];
  let sql = "SELECT p.location, count(*)::int AS count FROM job_postings p WHERE p.closed_at IS NULL AND $1::uuid IS NOT NULL";
  sql = appendPostingFilters(sql, params, ctx.url, false);
  sql += " GROUP BY p.location ORDER BY count DESC, p.location ASC";
  const rows = await query(ctx.deps.query, sql, params);
  return data(200, rows.rows.map((row) => ({ location: String(row.location ?? ""), count: Number(row.count ?? 0) })), ctx.rid);
}

async function getPosting(ctx: Ctx, idRaw: string): Promise<Response> {
  const id = requireUuid(idRaw, "id");
  const cols = `SELECT ${POSTING_COLS}, p.description, p.requirements, p.work_conditions, ${postingFlags("$2")} FROM job_postings p`;
  const open = await one(ctx.deps.query, `${cols} WHERE p.id = $1 AND p.closed_at IS NULL`, [id, ctx.user.id]);
  if (open) return data(200, postingDto(open, true), ctx.rid);
  if (ctx.user.id === GUEST_ID) throw notFound();
  const member = await one(ctx.deps.query,
    "SELECT p.id FROM job_postings p JOIN company_members m ON m.company_id = p.company_id AND m.user_id = $2 WHERE p.id = $1",
    [id, ctx.user.id]);
  if (!member) throw notFound();
  const closed = await one(ctx.deps.query, `${cols} WHERE p.id = $1`, [id, ctx.user.id]);
  if (!closed) throw notFound();
  return data(200, postingDto(closed, true), ctx.rid);
}

const verifiedCompany = async (ctx: Ctx): Promise<{ id: string; name: string }> => {
  const row = await one(ctx.deps.query,
    "SELECT c.id, c.name FROM company_members m JOIN companies c ON c.id = m.company_id WHERE m.user_id = $1 AND c.verified_at IS NOT NULL",
    [ctx.user.id]);
  if (!row) throw new HttpError(403, "FORBIDDEN", "verified company required");
  return { id: String(row.id), name: String(row.name ?? "") };
};

const snapshotText = (value: unknown): string => {
  if (value != null && typeof value === "object") return JSON.stringify(value);
  return String(value ?? "");
};

async function createPosting(ctx: Ctx): Promise<Response> {
  const body = await readObject(ctx.request);
  rejectFields(body, ["userId", "createdAt", "updatedAt", "revision", "id", "companyUserId"]);
  const title = textOf(body.title, "title", 1, 300);
  if (typeof body.jobCategory !== "string" || !JOB_CATEGORIES.has(body.jobCategory)) {
    throw unprocessable("jobCategory", "unsupported jobCategory");
  }
  const careerMin = intOf(body.careerMin, "careerMin", 0, 80);
  const careerMax = body.careerMax == null ? null : intOf(body.careerMax, "careerMax", 0, 80);
  if (careerMax != null && careerMax < careerMin) throw fieldError("careerMax", "must be greater than or equal to careerMin");
  const location = textOf(body.location, "location", 1, 80);
  if (typeof body.employmentType !== "string" || !EMPLOYMENT.has(body.employmentType)) {
    throw unprocessable("employmentType", "unsupported employmentType");
  }
  const description = textOf(body.description, "description", 1, 50000);
  const skills = stringList(body.skills, "skills", 30, 40);
  const requirements = stringList(body.requirements, "requirements", 50, 500);
  const preferred = stringList(body.preferred, "preferred", 50, 500);
  let workConditions: Record<string, unknown> = {};
  if (body.workConditions != null) {
    if (typeof body.workConditions !== "object" || Array.isArray(body.workConditions)) {
      throw fieldError("workConditions", "must be an object");
    }
    workConditions = body.workConditions as Record<string, unknown>;
  }
  const imageKey = imageKeyOf(body.imageKey, "imageKey");
  let sourceUrl: string | null = null;
  if (body.sourceUrl != null) {
    sourceUrl = textOf(body.sourceUrl, "sourceUrl", 1, 2000);
    if (!httpsUrl(sourceUrl)) throw fieldError("sourceUrl", "must be an http(s) URL without credentials");
  }
  const deadline = dateOf(body.deadline, "deadline");
  const account = await verifiedCompany(ctx);
  const company = body.company == null ? account.name : textOf(body.company, "company", 1, 200);
  if (!company) throw fieldError("company", "company must be 1-200 characters");
  const fields = searchFields(`${title} ${company}`);
  const id = crypto.randomUUID();
  const now = ctx.now.toISOString();
  await query(ctx.deps.query,
    `INSERT INTO job_postings (id, company_id, company, title, job_category, career_min, career_max, location, employment_type, description, requirements, work_conditions, skills, preferred, image_key, source_url, deadline, closed_at, revision, search_text, search_choseong, search_jamo, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13::jsonb,$14::jsonb,$15,$16,$17,NULL,1,$18,$19,$20,$21)`,
    [id, account.id, company, title, body.jobCategory, careerMin, careerMax, location, body.employmentType, description,
      JSON.stringify(requirements), JSON.stringify(workConditions), JSON.stringify(skills), JSON.stringify(preferred), imageKey, sourceUrl, deadline,
      fields.text, fields.choseong, fields.jamo, now]);
  return data(201, postingDto({
    id, company, title, job_category: body.jobCategory, image_key: imageKey, skills, career_min: careerMin,
    career_max: careerMax, location, employment_type: body.employmentType, deadline, source_url: sourceUrl,
    created_at: now, bookmarked: false, applied: false, description, requirements, work_conditions: workConditions,
    preferred, revision: 1, closed_at: null,
  }, true), ctx.rid);
}

async function requireOpenPosting(ctx: Ctx, idRaw: string): Promise<string> {
  const id = requireUuid(idRaw, "id");
  const row = await one(ctx.deps.query, "SELECT id FROM job_postings WHERE id = $1 AND closed_at IS NULL", [id]);
  if (!row) throw notFound();
  return id;
}

async function bookmarkPosting(ctx: Ctx, idRaw: string): Promise<Response> {
  const id = await requireOpenPosting(ctx, idRaw);
  await query(ctx.deps.query,
    "INSERT INTO bookmarks (user_id, posting_id, created_at) VALUES ($1,$2,$3) ON CONFLICT (user_id, posting_id) DO NOTHING",
    [ctx.user.id, id, ctx.now.toISOString()]);
  return noContent(ctx.rid);
}

async function unbookmarkPosting(ctx: Ctx, idRaw: string): Promise<Response> {
  const id = requireUuid(idRaw, "id");
  const row = await one(ctx.deps.query, "SELECT id FROM job_postings WHERE id = $1", [id]);
  if (!row) throw notFound();
  await query(ctx.deps.query, "DELETE FROM bookmarks WHERE user_id = $1 AND posting_id = $2", [ctx.user.id, id]);
  return noContent(ctx.rid);
}

function applicationDto(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: String(row.id),
    revision: Number(row.revision ?? 1),
    jobId: String(row.job_id),
    company: String(row.company ?? ""),
    title: String(row.title ?? ""),
    stage: String(row.stage ?? "APPLIED"),
    notes: String(row.notes ?? ""),
    appliedAt: ts(row.applied_at),
    nextActionAt: ts(row.next_action_at),
    imported: asBool(row.imported),
    createdAt: ts(row.created_at),
    updatedAt: ts(row.updated_at),
    fitScore: row.fit_score == null || row.fit_score === "" ? null : Number(row.fit_score),
  };
}

async function applyPosting(ctx: Ctx, idRaw: string): Promise<Response> {
  const id = await requireOpenPosting(ctx, idRaw);
  if (ctx.user.accountType === "EMPLOYER") throw new HttpError(403, "FORBIDDEN", "employer account required");
  const body = await readObject(ctx.request);
  rejectFields(body, ["userId", "createdAt", "id"]);
  const documentIds = body.documentIds == null ? [] : body.documentIds;
  if (!Array.isArray(documentIds)) throw fieldError("documentIds", "must be an array");
  const owned: { id: string; title: string; content: unknown }[] = [];
  for (const raw of documentIds) {
    const docId = requireUuid(String(raw), "documentIds");
    const doc = await one(ctx.deps.query,
      `SELECT d.id, d.title, v.content FROM documents d
       JOIN document_versions v ON v.document_id = d.id
       WHERE d.id = $1 AND d.user_id = $2
       ORDER BY v.number DESC, v.created_at DESC, v.id DESC LIMIT 1`,
      [docId, ctx.user.id]);
    if (!doc) throw notFound();
    owned.push({ id: docId, title: String(doc.title ?? ""), content: doc.content });
  }
  const existing = await one(ctx.deps.query,
    `SELECT a.id, a.revision, a.job_id, a.company, a.title, a.stage, a.notes, a.applied_at, a.next_action_at, a.imported, a.created_at, a.updated_at
     FROM applications a JOIN jobs j ON j.id = a.job_id
     WHERE a.user_id = $1 AND j.source_posting_id = $2
     ORDER BY a.created_at DESC LIMIT 1`,
    [ctx.user.id, id]);
  if (existing) return data(201, applicationDto(existing), ctx.rid);
  const posting = await one(ctx.deps.query,
    "SELECT company, title, description, requirements, deadline FROM job_postings WHERE id = $1",
    [id]);
  if (!posting) throw notFound();
  const fields = searchFields(`${String(posting.title)} ${String(posting.company)}`);
  const now = ctx.now.toISOString();
  const jobId = crypto.randomUUID();
  const applicationId = crypto.randomUUID();
  await query(ctx.deps.query,
    `INSERT INTO jobs (id, user_id, revision, company, title, source_kind, source_url, source_text, requirements, preferred, keywords, risks, deadline, language, archived, created_at, updated_at, source_posting_id, search_choseong, search_jamo)
     VALUES ($1,$2,1,$3,$4,'TEXT',NULL,$5,$6::jsonb,'[]'::jsonb,'[]'::jsonb,'[]'::jsonb,$7,'',false,$8,$8,$9,$10,$11)`,
    [jobId, ctx.user.id, posting.company, posting.title, posting.description, JSON.stringify(jsonList(posting.requirements)),
      posting.deadline, now, id, fields.choseong, fields.jamo]);
  await query(ctx.deps.query,
    `INSERT INTO applications (id, user_id, revision, job_id, company, title, stage, notes, applied_at, next_action_at, imported, created_at, updated_at)
     VALUES ($1,$2,1,$3,$4,$5,'APPLIED','',$6,NULL,false,$6,$6)`,
    [applicationId, ctx.user.id, jobId, posting.company, posting.title, now]);
  await query(ctx.deps.query,
    "INSERT INTO application_events (id, user_id, application_id, type, payload, created_at) VALUES ($1,$2,$3,'APPLIED',$4::jsonb,$5)",
    [crypto.randomUUID(), ctx.user.id, applicationId, JSON.stringify({ postingId: id, documentIds: owned.map((doc) => doc.id) }), now]);
  for (const doc of owned) {
    await query(ctx.deps.query,
      "INSERT INTO application_snapshots (id, application_id, document_id, title, content, created_at) VALUES ($1,$2,$3,$4,$5,$6)",
      [crypto.randomUUID(), applicationId, doc.id, doc.title, snapshotText(doc.content), now]);
  }
  return data(201, applicationDto({
    id: applicationId, revision: 1, job_id: jobId, company: posting.company, title: posting.title,
    stage: "APPLIED", notes: "", applied_at: now, next_action_at: null, imported: false, created_at: now, updated_at: now,
  }), ctx.rid);
}

const expectedRevisionOf = (body: Record<string, unknown>): number => {
  if (typeof body.expectedRevision !== "number" || !Number.isInteger(body.expectedRevision)) {
    throw fieldError("expectedRevision", "invalid expectedRevision");
  }
  return body.expectedRevision;
};

const revisionConflict = (currentRevision: number): HttpError =>
  new HttpError(409, "REVISION_CONFLICT", "resource was modified", { currentRevision });

const POSTING_RETURNING = `id, company, title, job_category, image_key, skills, career_min, career_max, location, employment_type, deadline, source_url, created_at, revision, preferred, closed_at, description, requirements, work_conditions`;

const patchPosting = async (ctx: Ctx, idRaw: string): Promise<Response> => {
  const id = requireUuid(idRaw, "id");
  const body = await readObject(ctx.request);
  rejectFields(body, ["userId", "createdAt", "updatedAt", "revision", "id", "companyUserId", "closedAt"]);
  const expected = expectedRevisionOf(body);
  const company = await verifiedCompany(ctx);
  const current = await one(ctx.deps.query,
    `SELECT ${POSTING_RETURNING} FROM job_postings WHERE id = $1 AND company_id = $2`,
    [id, company.id]);
  if (!current) throw notFound();
  if (Number(current.revision) !== expected) throw revisionConflict(Number(current.revision));
  const next = { ...current };
  if ("title" in body) next.title = textOf(body.title, "title", 1, 300);
  if ("company" in body) next.company = textOf(body.company, "company", 1, 200);
  if ("jobCategory" in body) {
    if (typeof body.jobCategory !== "string" || !JOB_CATEGORIES.has(body.jobCategory)) {
      throw unprocessable("jobCategory", "unsupported jobCategory");
    }
    next.job_category = body.jobCategory;
  }
  if ("careerMin" in body) next.career_min = intOf(body.careerMin, "careerMin", 0, 80);
  if ("careerMax" in body) next.career_max = body.careerMax == null ? null : intOf(body.careerMax, "careerMax", 0, 80);
  const careerMin = Number(next.career_min ?? 0);
  const careerMax = next.career_max == null ? null : Number(next.career_max);
  if (careerMax != null && careerMax < careerMin) throw fieldError("careerMax", "must be greater than or equal to careerMin");
  if ("location" in body) next.location = textOf(body.location, "location", 1, 80);
  if ("employmentType" in body) {
    if (typeof body.employmentType !== "string" || !EMPLOYMENT.has(body.employmentType)) {
      throw unprocessable("employmentType", "unsupported employmentType");
    }
    next.employment_type = body.employmentType;
  }
  if ("description" in body) next.description = textOf(body.description, "description", 1, 50000);
  if ("skills" in body) next.skills = stringList(body.skills, "skills", 30, 40);
  if ("requirements" in body) next.requirements = stringList(body.requirements, "requirements", 50, 500);
  if ("preferred" in body) next.preferred = stringList(body.preferred, "preferred", 50, 500);
  if ("workConditions" in body) {
    if (body.workConditions != null && (typeof body.workConditions !== "object" || Array.isArray(body.workConditions))) {
      throw fieldError("workConditions", "must be an object");
    }
    next.work_conditions = body.workConditions ?? {};
  }
  if ("imageKey" in body) next.image_key = imageKeyOf(body.imageKey, "imageKey");
  if ("sourceUrl" in body) {
    if (body.sourceUrl == null) next.source_url = null;
    else {
      const sourceUrl = textOf(body.sourceUrl, "sourceUrl", 1, 2000);
      if (!httpsUrl(sourceUrl)) throw fieldError("sourceUrl", "must be an http(s) URL without credentials");
      next.source_url = sourceUrl;
    }
  }
  if ("deadline" in body) next.deadline = dateOf(body.deadline, "deadline");
  const fields = searchFields(`${String(next.title ?? "")} ${String(next.company ?? "")}`);
  const updated = await one(ctx.deps.query,
    `UPDATE job_postings SET company = $3, title = $4, job_category = $5, career_min = $6, career_max = $7, location = $8, employment_type = $9, description = $10, requirements = $11::jsonb, work_conditions = $12::jsonb, skills = $13::jsonb, preferred = $14::jsonb, image_key = $15, source_url = $16, deadline = $17, search_text = $18, search_choseong = $19, search_jamo = $20, revision = revision + 1
     WHERE id = $1 AND company_id = $2 AND revision = $21
     RETURNING ${POSTING_RETURNING}`,
    [id, company.id, next.company, next.title, next.job_category, careerMin, careerMax, next.location, next.employment_type, next.description,
      JSON.stringify(jsonList(next.requirements)), JSON.stringify(jsonObject(next.work_conditions)), JSON.stringify(jsonList(next.skills)), JSON.stringify(jsonList(next.preferred)),
      next.image_key ?? null, next.source_url ?? null, next.deadline ?? null, fields.text, fields.choseong, fields.jamo, expected]);
  if (!updated) {
    const again = await one(ctx.deps.query, "SELECT revision FROM job_postings WHERE id = $1 AND company_id = $2", [id, company.id]);
    if (!again) throw notFound();
    throw revisionConflict(Number(again.revision));
  }
  return data(200, postingDto({ ...updated, bookmarked: false, applied: false }, true), ctx.rid);
};

const closePosting = async (ctx: Ctx, idRaw: string): Promise<Response> => {
  const id = requireUuid(idRaw, "id");
  const body = await readObject(ctx.request);
  const expected = expectedRevisionOf(body);
  const company = await verifiedCompany(ctx);
  const current = await one(ctx.deps.query,
    "SELECT id, revision, closed_at FROM job_postings WHERE id = $1 AND company_id = $2",
    [id, company.id]);
  if (!current) throw notFound();
  if (current.closed_at != null || Number(current.revision) !== expected) {
    throw revisionConflict(Number(current.revision));
  }
  const updated = await one(ctx.deps.query,
    `UPDATE job_postings SET closed_at = $3, revision = revision + 1
     WHERE id = $1 AND company_id = $2 AND revision = $4 AND closed_at IS NULL
     RETURNING ${POSTING_RETURNING}`,
    [id, company.id, ctx.now.toISOString(), expected]);
  if (!updated) {
    const again = await one(ctx.deps.query, "SELECT revision FROM job_postings WHERE id = $1 AND company_id = $2", [id, company.id]);
    if (!again) throw notFound();
    throw revisionConflict(Number(again.revision));
  }
  return data(200, postingDto({ ...updated, bookmarked: false, applied: false }, true), ctx.rid);
};

const listCompanyPostings = async (ctx: Ctx): Promise<Response> => {
  const member = await one(ctx.deps.query, "SELECT company_id FROM company_members WHERE user_id = $1 LIMIT 1", [ctx.user.id]);
  if (!member) throw notFound();
  const page = pageOf(ctx.url);
  const params: unknown[] = [ctx.user.id, String(member.company_id)];
  const where = " FROM job_postings p WHERE p.company_id = $2";
  const count = await one(ctx.deps.query, "SELECT count(*)::int AS total" + where + " AND $1::uuid IS NOT NULL", params.slice());
  const total = Number(count?.total ?? 0);
  let sql = `SELECT ${POSTING_COLS}, ${postingFlags("$1")}` + where;
  if (page.cursor) {
    params.push(page.cursor.createdAt, page.cursor.id);
    sql += ` AND (p.created_at, p.id) < ($${params.length - 1}, $${params.length})`;
  }
  params.push(page.limit + 1);
  sql += ` ORDER BY p.created_at DESC, p.id DESC LIMIT $${params.length}`;
  const rows = await query(ctx.deps.query, sql, params);
  const mapped = rows.rows.map((row) => ({ item: postingDto(row, false), createdAt: row.created_at, id: String(row.id) }));
  const paged = pageResult(mapped, page.limit, (row) => ({ createdAt: row.createdAt, id: row.id }));
  return pageBody(paged.items.map((row) => row.item), paged.nextCursor, paged.hasMore, ctx.rid, total);
};

const requirePostingMember = async (ctx: Ctx, postingId: string): Promise<void> => {
  const row = await one(ctx.deps.query,
    "SELECT p.id FROM job_postings p JOIN company_members m ON m.company_id = p.company_id AND m.user_id = $2 WHERE p.id = $1",
    [postingId, ctx.user.id]);
  if (!row) throw notFound();
};

const APPLICANT_SQL = `SELECT a.id, a.user_id, a.revision, a.job_id, a.company, a.title, a.stage, a.notes, a.applied_at, a.next_action_at, a.imported, a.created_at, a.updated_at,
  (SELECT g.fit_score FROM gap_analyses g WHERE g.application_id = a.id ORDER BY g.created_at DESC, g.id DESC LIMIT 1) AS fit_score
  FROM applications a JOIN jobs j ON j.id = a.job_id
  WHERE a.id = $1 AND j.source_posting_id = $2`;

const loadApplicant = async (ctx: Ctx, postingId: string, applicationId: string): Promise<Record<string, unknown>> => {
  const row = await one(ctx.deps.query, APPLICANT_SQL, [applicationId, postingId]);
  if (!row) throw notFound();
  return row;
};

const listApplicants = async (ctx: Ctx, idRaw: string): Promise<Response> => {
  const postingId = requireUuid(idRaw, "id");
  await requirePostingMember(ctx, postingId);
  const stage = ctx.url.searchParams.get("stage");
  const page = pageOf(ctx.url);
  const params: unknown[] = [postingId];
  let sql = `SELECT a.id, a.stage, a.applied_at, u.display_name, pr.headline
    FROM applications a
    JOIN jobs j ON j.id = a.job_id
    JOIN users u ON u.id = a.user_id
    LEFT JOIN profiles pr ON pr.user_id = a.user_id
    WHERE j.source_posting_id = $1`;
  if (stage) {
    params.push(stage);
    sql += ` AND a.stage = $${params.length}`;
  }
  if (page.cursor) {
    params.push(page.cursor.createdAt, page.cursor.id);
    sql += ` AND (a.applied_at, a.id) < ($${params.length - 1}, $${params.length})`;
  }
  params.push(page.limit + 1);
  sql += ` ORDER BY a.applied_at DESC, a.id DESC LIMIT $${params.length}`;
  const rows = await query(ctx.deps.query, sql, params);
  const mapped = rows.rows.map((row) => ({
    item: {
      applicationId: String(row.id),
      applicant: {
        displayName: String(row.display_name ?? ""),
        headline: row.headline == null ? null : String(row.headline),
      },
      stage: String(row.stage ?? ""),
      appliedAt: ts(row.applied_at) ?? "",
    },
    createdAt: row.applied_at,
    id: String(row.id),
  }));
  const paged = pageResult(mapped, page.limit, (row) => ({ createdAt: row.createdAt, id: row.id }));
  return pageBody(paged.items.map((row) => row.item), paged.nextCursor, paged.hasMore, ctx.rid);
};

const snapshotDocuments = async (ctx: Ctx, applicationId: string): Promise<{ id: string; title: string; content: string }[]> => {
  const rows = await query(ctx.deps.query,
    "SELECT id, title, content FROM application_snapshots WHERE application_id = $1 ORDER BY created_at, id",
    [applicationId]);
  return rows.rows.map((row) => ({
    id: String(row.id),
    title: String(row.title ?? ""),
    content: snapshotText(row.content),
  }));
};

const getApplicant = async (ctx: Ctx, postingRaw: string, applicationRaw: string): Promise<Response> => {
  const postingId = requireUuid(postingRaw, "id");
  const applicationId = requireUuid(applicationRaw, "applicationId");
  await requirePostingMember(ctx, postingId);
  const application = await loadApplicant(ctx, postingId, applicationId);
  const documents = await snapshotDocuments(ctx, applicationId);
  return data(200, { application: applicationDto(application), documents }, ctx.rid);
};

const patchApplicant = async (ctx: Ctx, postingRaw: string, applicationRaw: string): Promise<Response> => {
  const postingId = requireUuid(postingRaw, "id");
  const applicationId = requireUuid(applicationRaw, "applicationId");
  const body = await readObject(ctx.request);
  if (typeof body.stage !== "string" || !EMPLOYER_STAGES.has(body.stage)) {
    throw unprocessable("stage", "unsupported stage");
  }
  await requirePostingMember(ctx, postingId);
  const current = await loadApplicant(ctx, postingId, applicationId);
  if (String(current.stage) === body.stage) return data(200, applicationDto(current), ctx.rid);
  if (TERMINAL_STAGES.has(String(current.stage))) {
    throw new HttpError(409, "INVALID_TRANSITION", "terminal stage");
  }
  const now = ctx.now.toISOString();
  const updated = await one(ctx.deps.query,
    `UPDATE applications SET stage = $3, revision = revision + 1, updated_at = $4
     WHERE id = $1 AND user_id = $2
     RETURNING id, revision, job_id, company, title, stage, notes, applied_at, next_action_at, imported, created_at, updated_at`,
    [applicationId, String(current.user_id), body.stage, now]);
  if (!updated) throw notFound();
  await notify(ctx, String(current.user_id), "APPLICATION_STAGE", "지원 상태가 바뀌었어요", "", { kind: "activity", id: applicationId });
  return data(200, applicationDto(updated), ctx.rid);
};

async function search(ctx: Ctx): Promise<Response> {
  const q = ctx.url.searchParams.get("q") || "";
  if (!q.trim()) throw fieldError("q", "required");
  const type = ctx.url.searchParams.get("type") || "postings";
  if (type !== "postings" && type !== "people" && type !== "posts") throw unprocessable("type", "unsupported type");
  if (ctx.user.id === GUEST_ID && (type === "people" || type === "posts")) {
    throw new HttpError(401, "UNAUTHENTICATED", "missing bearer token");
  }
  if (type === "people") return searchPeople(ctx, q);
  if (type === "posts") return searchPosts(ctx, q);
  return searchPostings(ctx, q);
}

function relevance(title: string, extra: string, raw = "$2", cho = "$3", hangul = "$5"): string {
  return `CASE
    WHEN lower(${title}) = lower(${raw}) OR lower(${extra}) = lower(${raw}) THEN 0
    WHEN ${title} ILIKE ${raw} || '%' OR ${extra} ILIKE ${raw} || '%' THEN 1
    WHEN search_choseong LIKE '%' || ${cho} || '%' THEN 2
    WHEN ${hangul} <> '' AND (${title} ILIKE '%' || ${hangul} || '%' OR ${extra} ILIKE '%' || ${hangul} || '%') THEN 3
    ELSE 4 END`;
}

async function searchPostings(ctx: Ctx, q: string): Promise<Response> {
  const page = pageOf(ctx.url);
  const forms = queryForms(q);
  const params: unknown[] = [ctx.user.id, forms.raw, forms.choseong, forms.jamo, forms.hangul, forms.hangulJamo];
  let sql = `SELECT ${POSTING_COLS}, ${postingFlags("$1")} FROM job_postings p WHERE p.closed_at IS NULL AND (
      p.title ILIKE '%' || $2 || '%' OR p.company ILIKE '%' || $2 || '%'
      OR ($3 <> '' AND p.search_choseong LIKE '%' || $3 || '%')
      OR ($4 <> '' AND p.search_jamo LIKE $4 || '%')
      OR ($5 <> '' AND (p.title ILIKE '%' || $5 || '%' OR p.company ILIKE '%' || $5 || '%' OR p.search_jamo LIKE $6 || '%'))
    )`;
  if (page.cursor) {
    params.push(page.cursor.createdAt, page.cursor.id);
    sql += ` AND (p.created_at, p.id) < ($${params.length - 1}, $${params.length})`;
  }
  params.push(page.limit + 1);
  sql += ` ORDER BY ${relevance("p.title", "p.company")}, p.created_at DESC, p.id DESC LIMIT $${params.length}`;
  const rows = await query(ctx.deps.query, sql, params);
  const mapped = rows.rows.map((row) => ({ item: postingDto(row, false), createdAt: row.created_at, id: String(row.id) }));
  const paged = pageResult(mapped, page.limit, (row) => ({ createdAt: row.createdAt, id: row.id }));
  return pageBody(paged.items.map((row) => row.item), paged.nextCursor, paged.hasMore, ctx.rid);
}

const PROFILE_COLS = `p.user_id, u.display_name, p.avatar_key, p.headline, p.job_category, p.tenure_years, p.career_status,
  p.open_to_offers, p.intro, p.careers, p.skills, p.resume_source_id, p.updated_at`;

function profileDto(row: Record<string, unknown>, viewerId: string): Record<string, unknown> {
  const visibility = String(row.career_status_visibility ?? "everyone");
  const following = asBool(row.following);
  const self = String(row.user_id) === viewerId;
  const showStatus = self || visibility === "everyone" || (visibility === "followers" && following);
  return {
    userId: String(row.user_id),
    displayName: String(row.display_name ?? ""),
    avatarUrl: imageUrl(row.avatar_key),
    headline: String(row.headline ?? ""),
    jobCategory: row.job_category == null ? null : String(row.job_category),
    tenureYears: row.tenure_years == null ? null : Number(row.tenure_years),
    careerStatus: showStatus && row.career_status != null ? String(row.career_status) : null,
    openToOffers: asBool(row.open_to_offers),
    intro: String(row.intro ?? ""),
    careers: jsonList(row.careers),
    skills: jsonList(row.skills).map(String),
    followerCount: Number(row.follower_count ?? 0),
    resumeSourceId: row.resume_source_id == null ? null : String(row.resume_source_id),
    updatedAt: ts(row.updated_at),
  };
}

// Hides accounts in the deletion grace period. Read through to_jsonb so it also runs before migration 0018.
// shortcut: per-row jsonb cast, switch to u.deletion_requested_at IS NULL once 0018 is on Neon.
const NOT_DELETING = "to_jsonb(u) ->> 'deletion_requested_at' IS NULL";

function profileSelect(extra: string): string {
  return `SELECT ${PROFILE_COLS},
    COALESCE(s.career_status_visibility, 'everyone') AS career_status_visibility,
    COALESCE(s.profile_public, true) AS profile_public,
    EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = $1 AND f.followee_id = p.user_id) AS following,
    (SELECT count(*)::int FROM follows f WHERE f.followee_id = p.user_id) AS follower_count
    ${extra}
    FROM profiles p
    JOIN users u ON u.id = p.user_id AND ${NOT_DELETING}
    LEFT JOIN user_settings s ON s.user_id = p.user_id`;
}

async function listProfiles(ctx: Ctx): Promise<Response> {
  const page = pageOf(ctx.url);
  const categories = enumList(ctx.url, "category", JOB_CATEGORIES, "category");
  const tenureRaw = ctx.url.searchParams.get("tenure");
  if (tenureRaw && !TENURE.has(tenureRaw)) throw unprocessable("tenure", "unsupported tenure");
  const status = ctx.url.searchParams.get("status");
  if (status && !CAREER_STATUS.has(status)) throw unprocessable("status", "unsupported status");
  const explore = ctx.url.searchParams.get("explore");
  if (explore && explore !== "recommended" && explore !== "offers") throw unprocessable("explore", "unsupported explore");
  const me = await one(ctx.deps.query, "SELECT email FROM users WHERE id = $1", [ctx.user.id]);
  const email = me?.email == null ? "" : String(me.email);
  const domain = email.includes("@") ? email.split("@")[1].toLowerCase() : "";
  const params: unknown[] = [ctx.user.id, domain, FREE_MAIL.has(domain)];
  let sql = profileSelect("") + `
    WHERE COALESCE(s.profile_public, true) = true
      AND p.user_id <> $1
      AND NOT (
        COALESCE(s.hide_from_current_company, false)
        AND $2 <> '' AND $3 = false
        AND u.email IS NOT NULL
        AND split_part(lower(u.email), '@', 2) = $2
      )`;
  if (categories.length) {
    const i = pushArray(params, categories);
    sql += ` AND p.job_category = ANY(${anyOf(i)})`;
  }
  if (tenureRaw) {
    const range = TENURE.get(tenureRaw)!;
    params.push(range[0], range[1]);
    sql += ` AND p.tenure_years BETWEEN $${params.length - 1} AND $${params.length}`;
  }
  if (status) {
    params.push(status);
    sql += ` AND p.career_status = $${params.length}
      AND (
        COALESCE(s.career_status_visibility, 'everyone') = 'everyone'
        OR (COALESCE(s.career_status_visibility, 'everyone') = 'followers'
            AND EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = $1 AND f.followee_id = p.user_id))
      )`;
  }
  if (explore === "recommended") {
    sql += " AND p.job_category IS NOT NULL AND p.job_category = (SELECT job_category FROM profiles WHERE user_id = $1)";
  }
  if (explore === "offers") {
    sql += " AND EXISTS (SELECT 1 FROM offers o WHERE o.sender_id = $1 AND o.profile_user_id = p.user_id)";
  }
  const q = ctx.url.searchParams.get("q") || "";
  let rank = "";
  if (q) {
    if (codePoints(q) > 200) throw fieldError("q", "must be at most 200 characters");
    const forms = queryForms(q);
    params.push(forms.raw, forms.choseong, forms.jamo, forms.hangul, forms.hangulJamo);
    const raw = params.length - 4;
    const cho = params.length - 3;
    const jamo = params.length - 2;
    const hangul = params.length - 1;
    const hangulJamo = params.length;
    sql += ` AND (
      u.display_name ILIKE '%' || $${raw} || '%' OR p.headline ILIKE '%' || $${raw} || '%' OR p.search_text ILIKE '%' || $${raw} || '%'
      OR ($${cho} <> '' AND p.search_choseong LIKE '%' || $${cho} || '%')
      OR ($${jamo} <> '' AND p.search_jamo LIKE $${jamo} || '%')
      OR ($${hangul} <> '' AND (u.display_name ILIKE '%' || $${hangul} || '%' OR p.search_jamo LIKE $${hangulJamo} || '%'))
    )`;
    rank = relevance("u.display_name", "p.headline", "$" + raw, "$" + cho, "$" + hangul) + ", ";
  }
  if (page.cursor) {
    params.push(page.cursor.createdAt, page.cursor.id);
    sql += ` AND (p.updated_at, p.user_id) < ($${params.length - 1}, $${params.length})`;
  }
  params.push(page.limit + 1);
  sql += ` ORDER BY ${rank}p.updated_at DESC, p.user_id DESC LIMIT $${params.length}`;
  const rows = await query(ctx.deps.query, sql, params);
  const mapped = rows.rows.map((row) => ({
    item: profileDto(row, ctx.user.id),
    createdAt: row.updated_at,
    id: String(row.user_id),
  }));
  const paged = pageResult(mapped, page.limit, (row) => ({ createdAt: row.createdAt, id: row.id }));
  return pageBody(paged.items.map((row) => row.item), paged.nextCursor, paged.hasMore, ctx.rid);
}

async function searchPeople(ctx: Ctx, q: string): Promise<Response> {
  const url = new URL(ctx.url);
  url.searchParams.set("q", q);
  const next = { ...ctx, url };
  return listProfiles(next);
}

async function loadProfile(ctx: Ctx, userId: string): Promise<Record<string, unknown> | null> {
  return one(ctx.deps.query,
    profileSelect(", EXISTS (SELECT 1 FROM offers o WHERE o.sender_id = $1 AND o.profile_user_id = p.user_id) AS offered")
      + " WHERE p.user_id = $2",
    [ctx.user.id, userId]);
}

async function getProfile(ctx: Ctx, idRaw: string): Promise<Response> {
  const id = requireUuid(idRaw, "userId");
  const row = await loadProfile(ctx, id);
  if (!row) throw notFound();
  const self = id === ctx.user.id;
  if (!self && !asBool(row.profile_public)) throw notFound();
  const dto = profileDto(row, ctx.user.id);
  return data(200, { ...dto, following: asBool(row.following), offered: asBool(row.offered) }, ctx.rid);
}

async function ensureProfile(ctx: Ctx): Promise<void> {
  await query(ctx.deps.query,
    "INSERT INTO profiles (user_id, created_at, updated_at) VALUES ($1,$2,$2) ON CONFLICT (user_id) DO NOTHING",
    [ctx.user.id, ctx.now.toISOString()]);
}

async function getMyProfile(ctx: Ctx): Promise<Response> {
  await ensureProfile(ctx);
  const row = await loadProfile(ctx, ctx.user.id);
  if (!row) throw notFound();
  const dto = profileDto(row, ctx.user.id);
  return data(200, { ...dto, following: false, offered: false }, ctx.rid);
}

function careersOf(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw fieldError("careers", "must be an array");
  if (value.length > 30) throw fieldError("careers", "too many items");
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw fieldError("careers", "invalid career");
    const row = item as Record<string, unknown>;
    return {
      company: textOf(row.company, "careers", 1, 200),
      role: textOf(row.role, "careers", 1, 200),
      startedOn: dateOf(row.startedOn, "startedOn"),
      endedOn: dateOf(row.endedOn ?? null, "endedOn"),
      description: textOf(row.description ?? "", "careers", 0, 500),
    };
  });
}

async function patchMyProfile(ctx: Ctx): Promise<Response> {
  const body = await readObject(ctx.request);
  rejectFields(body, ["userId", "createdAt", "updatedAt", "followerCount", "following", "offered"]);
  await ensureProfile(ctx);
  const current = await one(ctx.deps.query,
    `SELECT u.display_name, p.headline, p.job_category, p.tenure_years, p.career_status, p.open_to_offers, p.intro, p.careers, p.skills, p.avatar_key, p.resume_source_id
     FROM profiles p JOIN users u ON u.id = p.user_id WHERE p.user_id = $1`,
    [ctx.user.id]);
  if (!current) throw notFound();
  let displayName = String(current.display_name ?? "");
  if ("displayName" in body) displayName = textOf(body.displayName, "displayName", 1, 80);
  let headline = String(current.headline ?? "");
  if ("headline" in body) headline = textOf(body.headline ?? "", "headline", 0, 120);
  let jobCategory = current.job_category == null ? null : String(current.job_category);
  if ("jobCategory" in body) {
    if (body.jobCategory == null || body.jobCategory === "") jobCategory = null;
    else if (typeof body.jobCategory !== "string" || !JOB_CATEGORIES.has(body.jobCategory)) throw unprocessable("jobCategory", "unsupported jobCategory");
    else jobCategory = body.jobCategory;
  }
  let tenure = current.tenure_years == null ? null : Number(current.tenure_years);
  if ("tenureYears" in body) tenure = body.tenureYears == null ? null : intOf(body.tenureYears, "tenureYears", 0, 80);
  let careerStatus = current.career_status == null ? null : String(current.career_status);
  if ("careerStatus" in body) {
    if (body.careerStatus == null || body.careerStatus === "") careerStatus = null;
    else if (typeof body.careerStatus !== "string" || !CAREER_STATUS.has(body.careerStatus)) throw unprocessable("careerStatus", "unsupported careerStatus");
    else careerStatus = body.careerStatus;
  }
  let openToOffers = asBool(current.open_to_offers);
  if ("openToOffers" in body) openToOffers = boolOf(body.openToOffers, "openToOffers");
  let intro = String(current.intro ?? "");
  if ("intro" in body) intro = textOf(body.intro ?? "", "intro", 0, 2000);
  let careers = jsonList(current.careers);
  if ("careers" in body) careers = careersOf(body.careers);
  let skills = jsonList(current.skills).map(String);
  if ("skills" in body) skills = stringList(body.skills, "skills", 50, 40);
  let avatarKey = current.avatar_key == null ? null : String(current.avatar_key);
  if ("avatarKey" in body) avatarKey = imageKeyOf(body.avatarKey, "avatarKey");
  let resumeSourceId = current.resume_source_id == null ? null : String(current.resume_source_id);
  if ("resumeSourceId" in body) {
    if (body.resumeSourceId == null || body.resumeSourceId === "") resumeSourceId = null;
    else {
      resumeSourceId = requireUuid(String(body.resumeSourceId), "resumeSourceId");
      const source = await one(ctx.deps.query, "SELECT id FROM sources WHERE id = $1 AND user_id = $2", [resumeSourceId, ctx.user.id]);
      if (!source) throw notFound();
    }
  }
  const fields = searchFields([displayName, headline, skills.join(" ")].join(" "));
  const now = ctx.now.toISOString();
  await query(ctx.deps.query, "UPDATE users SET display_name = $2 WHERE id = $1", [ctx.user.id, displayName]);
  await query(ctx.deps.query,
    `UPDATE profiles SET headline = $2, job_category = $3, tenure_years = $4, career_status = $5, open_to_offers = $6, intro = $7, careers = $8::jsonb, skills = $9::jsonb, avatar_key = $10, resume_source_id = $11, search_text = $12, search_choseong = $13, search_jamo = $14, updated_at = $15 WHERE user_id = $1`,
    [ctx.user.id, headline, jobCategory, tenure, careerStatus, openToOffers, intro, JSON.stringify(careers), JSON.stringify(skills), avatarKey, resumeSourceId, fields.text, fields.choseong, fields.jamo, now]);
  const row = await loadProfile(ctx, ctx.user.id);
  if (!row) throw notFound();
  return data(200, { ...profileDto(row, ctx.user.id), following: false, offered: false }, ctx.rid);
}

function person(row: Record<string, unknown>, idKey: string, nameKey: string): { id: string; displayName: string } {
  return { id: String(row[idKey] ?? ""), displayName: String(row[nameKey] ?? "") };
}

function offerDto(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: String(row.id),
    sender: person(row, "sender_id", "sender_name"),
    recipient: person(row, "profile_user_id", "recipient_name"),
    message: String(row.message ?? ""),
    posting: row.posting_id == null ? null : {
      id: String(row.posting_id),
      title: String(row.posting_title ?? ""),
      company: String(row.posting_company ?? ""),
      imageUrl: imageUrl(row.posting_image),
    },
    status: String(row.status ?? "SENT"),
    readAt: ts(row.read_at),
    createdAt: ts(row.created_at),
  };
}

const OFFER_SQL = `o.id, o.sender_id, su.display_name AS sender_name, o.profile_user_id, ru.display_name AS recipient_name,
  o.message, o.posting_id, jp.title AS posting_title, jp.company AS posting_company, jp.image_key AS posting_image,
  o.status, o.read_at, o.created_at
  FROM offers o
  JOIN users su ON su.id = o.sender_id
  JOIN users ru ON ru.id = o.profile_user_id
  LEFT JOIN job_postings jp ON jp.id = o.posting_id`;

async function offerProfile(ctx: Ctx, idRaw: string): Promise<Response> {
  const id = requireUuid(idRaw, "userId");
  const body = await readObject(ctx.request);
  rejectFields(body, ["userId", "createdAt", "id", "status"]);
  if (id === ctx.user.id) throw new HttpError(400, "VALIDATION_ERROR", "cannot offer yourself", { field: "userId" });
  const message = textOf(body.message, "message", 1, 500);
  let postingId: string | null = null;
  if (body.postingId != null && body.postingId !== "") {
    postingId = requireUuid(String(body.postingId), "postingId");
    const posting = await one(ctx.deps.query, "SELECT id FROM job_postings WHERE id = $1 AND closed_at IS NULL", [postingId]);
    if (!posting) throw notFound();
  }
  const profile = await one(ctx.deps.query,
    `SELECT p.user_id, p.open_to_offers, COALESCE(s.profile_public, true) AS profile_public
     FROM profiles p LEFT JOIN user_settings s ON s.user_id = p.user_id WHERE p.user_id = $1`,
    [id]);
  if (!profile || !asBool(profile.profile_public)) throw notFound();
  if (!asBool(profile.open_to_offers)) throw new HttpError(403, "FORBIDDEN", "profile is not accepting offers");
  const offerId = crypto.randomUUID();
  const now = ctx.now.toISOString();
  try {
    await query(ctx.deps.query,
      "INSERT INTO offers (id, sender_id, profile_user_id, message, posting_id, status, read_at, created_at) VALUES ($1,$2,$3,$4,$5,'SENT',NULL,$6)",
      [offerId, ctx.user.id, id, message, postingId, now]);
  } catch (err) {
    if (isUnique(err)) throw new HttpError(409, "CONFLICT", "offer already sent");
    throw err;
  }
  await notify(ctx, id, "OFFER", "새 제안", message, { kind: "offer", id: offerId });
  const row = await one(ctx.deps.query, "SELECT " + OFFER_SQL + " WHERE o.id = $1", [offerId]);
  if (!row) throw notFound();
  return data(201, offerDto(row), ctx.rid);
}

async function listOffers(ctx: Ctx): Promise<Response> {
  const box = ctx.url.searchParams.get("box");
  if (box !== "received" && box !== "sent") throw fieldError("box", "must be received or sent");
  const page = pageOf(ctx.url);
  const params: unknown[] = [ctx.user.id];
  let sql = "SELECT " + OFFER_SQL + (box === "received" ? " WHERE o.profile_user_id = $1" : " WHERE o.sender_id = $1");
  if (page.cursor) {
    params.push(page.cursor.createdAt, page.cursor.id);
    sql += ` AND (o.created_at, o.id) < ($${params.length - 1}, $${params.length})`;
  }
  params.push(page.limit + 1);
  sql += ` ORDER BY o.created_at DESC, o.id DESC LIMIT $${params.length}`;
  const rows = await query(ctx.deps.query, sql, params);
  const mapped = rows.rows.map((row) => ({ item: offerDto(row), createdAt: row.created_at, id: String(row.id) }));
  const paged = pageResult(mapped, page.limit, (row) => ({ createdAt: row.createdAt, id: row.id }));
  return pageBody(paged.items.map((row) => row.item), paged.nextCursor, paged.hasMore, ctx.rid);
}

async function offerFor(ctx: Ctx, idRaw: string): Promise<Record<string, unknown>> {
  const id = requireUuid(idRaw, "id");
  const row = await one(ctx.deps.query, "SELECT " + OFFER_SQL + " WHERE o.id = $1 AND (o.sender_id = $2 OR o.profile_user_id = $2)", [id, ctx.user.id]);
  if (!row) throw notFound();
  return row;
}

async function getOffer(ctx: Ctx, idRaw: string): Promise<Response> {
  const row = await offerFor(ctx, idRaw);
  if (String(row.profile_user_id) === ctx.user.id && String(row.status) === "SENT") {
    const now = ctx.now.toISOString();
    await query(ctx.deps.query, "UPDATE offers SET status = 'READ', read_at = $2 WHERE id = $1 AND status = 'SENT'", [row.id, now]);
    row.status = "READ";
    row.read_at = now;
  }
  return data(200, offerDto(row), ctx.rid);
}

async function decideOffer(ctx: Ctx, idRaw: string, status: "ACCEPTED" | "DECLINED"): Promise<Response> {
  const row = await offerFor(ctx, idRaw);
  if (String(row.profile_user_id) !== ctx.user.id) throw new HttpError(403, "FORBIDDEN", "only the recipient can respond");
  const current = String(row.status);
  if (current !== "SENT" && current !== "READ") throw new HttpError(409, "CONFLICT", "offer is already closed");
  const body: Record<string, unknown> = await readObject(ctx.request).catch((err: unknown) => {
    if (err instanceof HttpError && err.message === "request body required") return {};
    throw err;
  });
  let reply = "";
  if (status === "ACCEPTED" && body.reply != null) reply = textOf(body.reply, "reply", 1, 2000);
  const now = ctx.now.toISOString();
  await query(ctx.deps.query, "UPDATE offers SET status = $2 WHERE id = $1", [row.id, status]);
  if (reply) {
    await query(ctx.deps.query,
      "INSERT INTO offer_messages (id, offer_id, sender_id, body, created_at) VALUES ($1,$2,$3,$4,$5)",
      [crypto.randomUUID(), row.id, ctx.user.id, reply, now]);
  }
  row.status = status;
  return data(200, offerDto(row), ctx.rid);
}

async function listOfferMessages(ctx: Ctx, idRaw: string): Promise<Response> {
  const offer = await offerFor(ctx, idRaw);
  const page = pageOf(ctx.url);
  const params: unknown[] = [offer.id];
  let sql = `SELECT m.id, m.offer_id, m.sender_id, u.display_name AS sender_name, m.body, m.created_at
    FROM offer_messages m JOIN users u ON u.id = m.sender_id WHERE m.offer_id = $1`;
  if (page.cursor) {
    params.push(page.cursor.createdAt, page.cursor.id);
    sql += ` AND (m.created_at, m.id) < ($${params.length - 1}, $${params.length})`;
  }
  params.push(page.limit + 1);
  sql += ` ORDER BY m.created_at DESC, m.id DESC LIMIT $${params.length}`;
  const rows = await query(ctx.deps.query, sql, params);
  const mapped = rows.rows.map((row) => ({
    item: {
      id: String(row.id),
      offerId: String(row.offer_id),
      sender: person(row, "sender_id", "sender_name"),
      body: String(row.body ?? ""),
      createdAt: ts(row.created_at),
    },
    createdAt: row.created_at,
    id: String(row.id),
  }));
  const paged = pageResult(mapped, page.limit, (row) => ({ createdAt: row.createdAt, id: row.id }));
  return pageBody(paged.items.map((row) => row.item), paged.nextCursor, paged.hasMore, ctx.rid);
}

async function postOfferMessage(ctx: Ctx, idRaw: string): Promise<Response> {
  const offer = await offerFor(ctx, idRaw);
  if (String(offer.status) !== "ACCEPTED") throw new HttpError(409, "CONFLICT", "offer is not accepted");
  const body = await readObject(ctx.request);
  const text = textOf(body.body, "body", 1, 2000);
  const id = crypto.randomUUID();
  const now = ctx.now.toISOString();
  await query(ctx.deps.query,
    "INSERT INTO offer_messages (id, offer_id, sender_id, body, created_at) VALUES ($1,$2,$3,$4,$5)",
    [id, offer.id, ctx.user.id, text, now]);
  return data(201, {
    id, offerId: String(offer.id), sender: { id: ctx.user.id, displayName: ctx.user.displayName }, body: text, createdAt: ts(now),
  }, ctx.rid);
}

function inferKind(url: string): string {
  let host = "";
  try { host = new URL(url).hostname.toLowerCase(); } catch { return "other"; }
  if (host === "github.com" || host.endsWith(".github.com")) return "github";
  if (/(^|\.)((velog\.io)|(tistory\.com)|(medium\.com)|(blogspot\.com)|(brunch\.co\.kr))$/.test(host)) return "blog";
  if (/(^|\.)((notion\.site)|(notion\.so)|(behance\.net)|(dribbble\.com))$/.test(host)) return "portfolio";
  return "other";
}

function linkDto(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: String(row.id),
    kind: String(row.kind ?? "other"),
    url: String(row.url ?? ""),
    title: String(row.title ?? ""),
    status: String(row.status ?? "READ"),
    fitCount: Number(row.fit_count ?? 0),
    aiRead: asBool(row.ai_read),
    createdAt: ts(row.created_at),
  };
}

async function listLinks(ctx: Ctx): Promise<Response> {
  const page = pageOf(ctx.url);
  const kind = ctx.url.searchParams.get("kind");
  if (kind && !LINK_KINDS.has(kind)) throw unprocessable("kind", "unsupported kind");
  const params: unknown[] = [ctx.user.id];
  let sql = "SELECT id, kind, url, title, status, fit_count, ai_read, created_at FROM user_links WHERE user_id = $1";
  if (kind) {
    params.push(kind);
    sql += ` AND kind = $${params.length}`;
  }
  if (page.cursor) {
    params.push(page.cursor.createdAt, page.cursor.id);
    sql += ` AND (created_at, id) < ($${params.length - 1}, $${params.length})`;
  }
  params.push(page.limit + 1);
  sql += ` ORDER BY created_at DESC, id DESC LIMIT $${params.length}`;
  const rows = await query(ctx.deps.query, sql, params);
  const mapped = rows.rows.map((row) => ({ item: linkDto(row), createdAt: row.created_at, id: String(row.id) }));
  const paged = pageResult(mapped, page.limit, (row) => ({ createdAt: row.createdAt, id: row.id }));
  return pageBody(paged.items.map((row) => row.item), paged.nextCursor, paged.hasMore, ctx.rid);
}

async function createLink(ctx: Ctx): Promise<Response> {
  const body = await readObject(ctx.request);
  rejectFields(body, ["userId", "createdAt", "id", "status", "fitCount"]);
  const url = textOf(body.url, "url", 1, 2000);
  if (!httpsUrl(url)) throw fieldError("url", "must be an http(s) URL without credentials");
  let kind = body.kind == null || body.kind === "" ? inferKind(url) : String(body.kind);
  if (!LINK_KINDS.has(kind)) throw unprocessable("kind", "unsupported kind");
  const title = textOf(body.title ?? "", "title", 0, 300);
  const aiRead = body.aiRead == null ? false : boolOf(body.aiRead, "aiRead");
  const id = crypto.randomUUID();
  const now = ctx.now.toISOString();
  const status = "READ";
  await query(ctx.deps.query,
    "INSERT INTO user_links (id, user_id, kind, url, title, status, fit_count, ai_read, created_at) VALUES ($1,$2,$3,$4,$5,$6,0,$7,$8)",
    [id, ctx.user.id, kind, url, title, status, aiRead, now]);
  return data(201, linkDto({ id, kind, url, title, status, fit_count: 0, ai_read: aiRead, created_at: now }), ctx.rid);
}

async function deleteLink(ctx: Ctx, idRaw: string): Promise<Response> {
  const id = requireUuid(idRaw, "id");
  const row = await one(ctx.deps.query, "DELETE FROM user_links WHERE id = $1 AND user_id = $2 RETURNING id", [id, ctx.user.id]);
  if (!row) throw notFound();
  return noContent(ctx.rid);
}

async function registerDevice(ctx: Ctx): Promise<Response> {
  const body = await readObject(ctx.request);
  const token = textOf(body.token, "token", 1, 4096);
  if (body.platform !== "ios" && body.platform !== "android") throw unprocessable("platform", "unsupported platform");
  await query(ctx.deps.query,
    "INSERT INTO user_devices (user_id, token, platform, created_at) VALUES ($1,$2,$3,$4) ON CONFLICT (user_id, token) DO UPDATE SET platform = EXCLUDED.platform",
    [ctx.user.id, token, body.platform, ctx.now.toISOString()]);
  return data(201, { token, platform: body.platform }, ctx.rid);
}

async function deleteDevice(ctx: Ctx, tokenRaw: string): Promise<Response> {
  const token = decodeURIComponent(tokenRaw);
  await query(ctx.deps.query, "DELETE FROM user_devices WHERE user_id = $1 AND token = $2", [ctx.user.id, token]);
  return noContent(ctx.rid);
}

async function notify(ctx: Ctx, userId: string, type: string, title: string, body: string, target: Record<string, unknown>): Promise<void> {
  if (userId === ctx.user.id) return;
  const column = NOTIFY_COLUMN[type];
  if (!column) return;
  const pref = await one(ctx.deps.query, `SELECT ${column} AS enabled FROM user_settings WHERE user_id = $1`, [userId]);
  if (pref && !asBool(pref.enabled)) return;
  await query(ctx.deps.query,
    "INSERT INTO notifications (id, user_id, type, title, body, target, read_at, created_at) VALUES ($1,$2,$3,$4,$5,$6::jsonb,NULL,$7)",
    [crypto.randomUUID(), userId, type, title, body, JSON.stringify(target), ctx.now.toISOString()]);
}

function notificationDto(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: String(row.id),
    type: String(row.type ?? ""),
    title: String(row.title ?? ""),
    body: String(row.body ?? ""),
    target: jsonObject(row.target),
    readAt: ts(row.read_at),
    createdAt: ts(row.created_at),
  };
}

async function listNotifications(ctx: Ctx): Promise<Response> {
  const page = pageOf(ctx.url);
  const params: unknown[] = [ctx.user.id];
  let sql = "SELECT id, type, title, body, target, read_at, created_at FROM notifications WHERE user_id = $1";
  if (page.cursor) {
    params.push(page.cursor.createdAt, page.cursor.id);
    sql += ` AND (created_at, id) < ($${params.length - 1}, $${params.length})`;
  }
  params.push(page.limit + 1);
  sql += ` ORDER BY created_at DESC, id DESC LIMIT $${params.length}`;
  const rows = await query(ctx.deps.query, sql, params);
  const mapped = rows.rows.map((row) => ({ item: notificationDto(row), createdAt: row.created_at, id: String(row.id) }));
  const paged = pageResult(mapped, page.limit, (row) => ({ createdAt: row.createdAt, id: row.id }));
  return pageBody(paged.items.map((row) => row.item), paged.nextCursor, paged.hasMore, ctx.rid);
}

async function readNotifications(ctx: Ctx): Promise<Response> {
  const body = await readObject(ctx.request);
  const now = ctx.now.toISOString();
  if (body.all === true) {
    await query(ctx.deps.query, "UPDATE notifications SET read_at = $2 WHERE user_id = $1 AND read_at IS NULL", [ctx.user.id, now]);
    return noContent(ctx.rid);
  }
  if (!Array.isArray(body.ids)) throw fieldError("ids", "must be an array");
  const ids = body.ids.map((id) => requireUuid(String(id), "ids"));
  if (ids.length) {
    await query(ctx.deps.query,
      "UPDATE notifications SET read_at = $3 WHERE user_id = $1 AND id = ANY(string_to_array($2, E'\\x1f')::uuid[]) AND read_at IS NULL",
      [ctx.user.id, ids.join("\u001f"), now]);
  }
  return noContent(ctx.rid);
}

function settingsDto(row: Record<string, unknown>): Record<string, unknown> {
  return {
    notifyDeadline: asBool(row.notify_deadline),
    notifyOffer: asBool(row.notify_offer),
    notifyComment: asBool(row.notify_comment),
    notifyAiDone: asBool(row.notify_ai_done),
    notifyApplicationStage: row.notify_application_stage == null ? true : asBool(row.notify_application_stage),
    locale: String(row.locale ?? "ko"),
    profilePublic: asBool(row.profile_public),
    careerStatusVisibility: String(row.career_status_visibility ?? "everyone"),
    hideFromCurrentCompany: asBool(row.hide_from_current_company),
    contactVisibility: String(row.contact_visibility ?? "accepted"),
    defaultTone: String(row.default_tone ?? "as_is"),
    chatRetentionDays: row.chat_retention_days == null ? null : Number(row.chat_retention_days),
    allowAiReadMyFiles: asBool(row.allow_ai_read_my_files),
  };
}

const SETTINGS_SELECT = `SELECT s.notify_deadline, s.notify_offer, s.notify_comment, s.notify_ai_done, s.notify_application_stage, u.locale, s.profile_public,
            s.career_status_visibility, s.hide_from_current_company, s.contact_visibility, s.default_tone,
            s.chat_retention_days, s.allow_ai_read_my_files
     FROM user_settings s JOIN users u ON u.id = s.user_id WHERE s.user_id = $1`;

const SETTINGS_UPDATE = `UPDATE user_settings SET notify_deadline = $2, notify_offer = $3, notify_comment = $4, notify_ai_done = $5,
      profile_public = $6, career_status_visibility = $7, hide_from_current_company = $8, contact_visibility = $9,
      default_tone = $10, chat_retention_days = $11, allow_ai_read_my_files = $12, notify_application_stage = $13, updated_at = $14 WHERE user_id = $1`;

const SETTINGS_UPDATE_LEGACY = `UPDATE user_settings SET notify_deadline = $2, notify_offer = $3, notify_comment = $4, notify_ai_done = $5,
      profile_public = $6, career_status_visibility = $7, hide_from_current_company = $8, contact_visibility = $9,
      default_tone = $10, chat_retention_days = $11, allow_ai_read_my_files = $12, updated_at = $13 WHERE user_id = $1`;

async function loadSettings(ctx: Ctx): Promise<Record<string, unknown>> {
  await query(ctx.deps.query, "INSERT INTO user_settings (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING", [ctx.user.id]);
  try {
    const row = await one(ctx.deps.query, SETTINGS_SELECT, [ctx.user.id]);
    if (!row) throw notFound();
    return row;
  } catch (err) {
    if (!isUndefinedColumn(err)) throw err;
    const row = await one(ctx.deps.query, SETTINGS_SELECT.replace("s.notify_application_stage, ", ""), [ctx.user.id]);
    if (!row) throw notFound();
    return row;
  }
}

async function getSettings(ctx: Ctx): Promise<Response> {
  return data(200, settingsDto(await loadSettings(ctx)), ctx.rid);
}

async function patchSettings(ctx: Ctx): Promise<Response> {
  const body = await readObject(ctx.request);
  const current = await loadSettings(ctx);
  const next = { ...current };
  if ("notifyDeadline" in body) next.notify_deadline = boolOf(body.notifyDeadline, "notifyDeadline");
  if ("notifyOffer" in body) next.notify_offer = boolOf(body.notifyOffer, "notifyOffer");
  if ("notifyComment" in body) next.notify_comment = boolOf(body.notifyComment, "notifyComment");
  if ("notifyAiDone" in body) next.notify_ai_done = boolOf(body.notifyAiDone, "notifyAiDone");
  if ("notifyApplicationStage" in body) next.notify_application_stage = boolOf(body.notifyApplicationStage, "notifyApplicationStage");
  if ("profilePublic" in body) next.profile_public = boolOf(body.profilePublic, "profilePublic");
  if ("hideFromCurrentCompany" in body) next.hide_from_current_company = boolOf(body.hideFromCurrentCompany, "hideFromCurrentCompany");
  if ("allowAiReadMyFiles" in body) next.allow_ai_read_my_files = boolOf(body.allowAiReadMyFiles, "allowAiReadMyFiles");
  if ("careerStatusVisibility" in body) {
    if (typeof body.careerStatusVisibility !== "string" || !VISIBILITY.has(body.careerStatusVisibility)) {
      throw unprocessable("careerStatusVisibility", "unsupported careerStatusVisibility");
    }
    next.career_status_visibility = body.careerStatusVisibility;
  }
  if ("contactVisibility" in body) {
    if (typeof body.contactVisibility !== "string" || !CONTACT.has(body.contactVisibility)) {
      throw unprocessable("contactVisibility", "unsupported contactVisibility");
    }
    next.contact_visibility = body.contactVisibility;
  }
  if ("defaultTone" in body) {
    if (typeof body.defaultTone !== "string" || !TONES.has(body.defaultTone)) throw unprocessable("defaultTone", "unsupported defaultTone");
    next.default_tone = body.defaultTone;
  }
  if ("locale" in body) {
    if (body.locale !== "ko" && body.locale !== "en") throw unprocessable("locale", "unsupported locale");
    await query(ctx.deps.query, "UPDATE users SET locale = $2 WHERE id = $1", [ctx.user.id, body.locale]);
    next.locale = body.locale;
  }
  if ("chatRetentionDays" in body) {
    next.chat_retention_days = body.chatRetentionDays == null ? null : intOf(body.chatRetentionDays, "chatRetentionDays", 1, 3650);
  }
  const params = [ctx.user.id, next.notify_deadline, next.notify_offer, next.notify_comment, next.notify_ai_done, next.profile_public,
    next.career_status_visibility, next.hide_from_current_company, next.contact_visibility, next.default_tone,
    next.chat_retention_days, next.allow_ai_read_my_files, next.notify_application_stage, ctx.now.toISOString()];
  try {
    await query(ctx.deps.query, SETTINGS_UPDATE, params);
  } catch (err) {
    if (!isUndefinedColumn(err)) throw err;
    await query(ctx.deps.query, SETTINGS_UPDATE_LEGACY, params.filter((_, index) => index !== 12));
  }
  return data(200, settingsDto(await loadSettings(ctx)), ctx.rid);
}

async function followUser(ctx: Ctx, idRaw: string): Promise<Response> {
  const id = requireUuid(idRaw, "userId");
  if (id === ctx.user.id) throw new HttpError(400, "VALIDATION_ERROR", "cannot follow yourself", { field: "userId" });
  const user = await one(ctx.deps.query, "SELECT id FROM users WHERE id = $1", [id]);
  if (!user) throw notFound();
  await query(ctx.deps.query,
    "INSERT INTO follows (follower_id, followee_id, created_at) VALUES ($1,$2,$3) ON CONFLICT (follower_id, followee_id) DO NOTHING",
    [ctx.user.id, id, ctx.now.toISOString()]);
  return noContent(ctx.rid);
}

async function unfollowUser(ctx: Ctx, idRaw: string): Promise<Response> {
  const id = requireUuid(idRaw, "userId");
  if (id === ctx.user.id) throw new HttpError(400, "VALIDATION_ERROR", "cannot follow yourself", { field: "userId" });
  const user = await one(ctx.deps.query, "SELECT id FROM users WHERE id = $1", [id]);
  if (!user) throw notFound();
  await query(ctx.deps.query, "DELETE FROM follows WHERE follower_id = $1 AND followee_id = $2", [ctx.user.id, id]);
  return noContent(ctx.rid);
}

async function listBookmarks(ctx: Ctx): Promise<Response> {
  const page = pageOf(ctx.url);
  const params: unknown[] = [ctx.user.id];
  let sql = `SELECT ${POSTING_COLS}, bk.created_at AS bookmark_created_at, true AS bookmarked,
    EXISTS (SELECT 1 FROM jobs j JOIN applications a ON a.job_id = j.id AND a.user_id = $1 WHERE j.source_posting_id = p.id) AS applied
    FROM bookmarks bk JOIN job_postings p ON p.id = bk.posting_id WHERE bk.user_id = $1`;
  if (page.cursor) {
    params.push(page.cursor.createdAt, page.cursor.id);
    sql += ` AND (bk.created_at, p.id) < ($${params.length - 1}, $${params.length})`;
  }
  params.push(page.limit + 1);
  sql += ` ORDER BY bk.created_at DESC, p.id DESC LIMIT $${params.length}`;
  const rows = await query(ctx.deps.query, sql, params);
  const mapped = rows.rows.map((row) => ({ item: postingDto(row, false), createdAt: row.bookmark_created_at, id: String(row.id) }));
  const paged = pageResult(mapped, page.limit, (row) => ({ createdAt: row.createdAt, id: row.id }));
  return pageBody(paged.items.map((row) => row.item), paged.nextCursor, paged.hasMore, ctx.rid);
}

async function listRelation(ctx: Ctx, incoming: boolean): Promise<Response> {
  const page = pageOf(ctx.url);
  const params: unknown[] = [ctx.user.id];
  const join = incoming ? "f.follower_id" : "f.followee_id";
  const mine = incoming ? "f.followee_id" : "f.follower_id";
  let sql = profileSelect(", f.created_at AS relation_created_at") + ` JOIN follows f ON ${join} = p.user_id WHERE ${mine} = $1 AND COALESCE(s.profile_public, true) = true`;
  if (page.cursor) {
    params.push(page.cursor.createdAt, page.cursor.id);
    sql += ` AND (f.created_at, p.user_id) < ($${params.length - 1}, $${params.length})`;
  }
  params.push(page.limit + 1);
  sql += ` ORDER BY f.created_at DESC, p.user_id DESC LIMIT $${params.length}`;
  const rows = await query(ctx.deps.query, sql, params);
  const mapped = rows.rows.map((row) => ({ item: profileDto(row, ctx.user.id), createdAt: row.relation_created_at, id: String(row.user_id) }));
  const paged = pageResult(mapped, page.limit, (row) => ({ createdAt: row.createdAt, id: row.id }));
  return pageBody(paged.items.map((row) => row.item), paged.nextCursor, paged.hasMore, ctx.rid);
}

function postDto(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: String(row.id),
    author: {
      id: String(row.user_id ?? ""),
      displayName: String(row.display_name ?? ""),
      employer: asBool(row.is_employer),
      companyName: row.company_name == null || row.company_name === "" ? null : String(row.company_name),
    },
    category: String(row.category ?? ""),
    title: String(row.title ?? ""),
    body: String(row.body ?? ""),
    imageUrls: jsonList(row.image_keys).map((key) => imageUrl(key)).filter((url) => url != null),
    commentCount: Number(row.comment_count ?? 0),
    viewCount: Number(row.view_count ?? 0),
    createdAt: ts(row.created_at),
  };
}

const POST_SQL = `p.id, p.user_id, u.display_name, u.is_employer, co.name AS company_name, p.category, p.title, p.body, p.image_keys, p.view_count, p.created_at,
  (SELECT count(*)::int FROM post_comments c WHERE c.post_id = p.id) AS comment_count
  FROM posts p JOIN users u ON u.id = p.user_id AND ${NOT_DELETING}
  LEFT JOIN company_members cm ON cm.user_id = u.id
  LEFT JOIN companies co ON co.id = cm.company_id`;

const withoutCompanyJoin = (sql: string): string => sql
  .replaceAll("co.name AS company_name", "NULL::text AS company_name")
  .replaceAll(" LEFT JOIN company_members cm ON cm.user_id = u.id", "")
  .replaceAll(" LEFT JOIN companies co ON co.id = cm.company_id", "");

const queryPosts = async (ctx: Ctx, sql: string, params: unknown[]) => {
  try {
    return await query(ctx.deps.query, sql, params);
  } catch (err) {
    if (!sql.includes("company_members") || !(isMissingRelation(err) || isUndefinedColumn(err))) throw err;
    const fallback = withoutCompanyJoin(sql);
    if (fallback === sql || fallback.includes("company_members") || fallback.includes("companies")) throw err;
    return query(ctx.deps.query, fallback, params);
  }
};

const onePost = async (ctx: Ctx, sql: string, params: unknown[]) => {
  const result = await queryPosts(ctx, sql, params);
  return result.rows[0] ?? null;
};

async function listPosts(ctx: Ctx): Promise<Response> {
  const page = pageOf(ctx.url);
  const category = ctx.url.searchParams.get("category");
  if (category && !POST_CATEGORIES.has(category)) throw unprocessable("category", "unsupported category");
  const params: unknown[] = [];
  let sql = "SELECT " + POST_SQL + " WHERE 1=1";
  if (category) {
    params.push(category);
    sql += ` AND p.category = $${params.length}`;
  }
  const q = ctx.url.searchParams.get("q") || "";
  sql = appendTextSearch(sql, params, q, ["p.title", "p.body"]);
  if (page.cursor) {
    params.push(page.cursor.createdAt, page.cursor.id);
    sql += ` AND (p.created_at, p.id) < ($${params.length - 1}, $${params.length})`;
  }
  params.push(page.limit + 1);
  sql += ` ORDER BY p.created_at DESC, p.id DESC LIMIT $${params.length}`;
  const rows = await queryPosts(ctx, sql, params);
  const mapped = rows.rows.map((row) => ({ item: postDto(row), createdAt: row.created_at, id: String(row.id) }));
  const paged = pageResult(mapped, page.limit, (row) => ({ createdAt: row.createdAt, id: row.id }));
  return pageBody(paged.items.map((row) => row.item), paged.nextCursor, paged.hasMore, ctx.rid);
}

async function searchPosts(ctx: Ctx, q: string): Promise<Response> {
  const page = pageOf(ctx.url);
  const forms = queryForms(q);
  const params: unknown[] = [forms.raw, forms.choseong, forms.jamo, forms.hangul, forms.hangulJamo];
  let sql = `SELECT ${POST_SQL} WHERE (
      p.title ILIKE '%' || $1 || '%' OR p.body ILIKE '%' || $1 || '%'
      OR ($2 <> '' AND p.search_choseong LIKE '%' || $2 || '%')
      OR ($3 <> '' AND p.search_jamo LIKE $3 || '%')
      OR ($4 <> '' AND (p.title ILIKE '%' || $4 || '%' OR p.body ILIKE '%' || $4 || '%' OR p.search_jamo LIKE $5 || '%'))
    )`;
  if (page.cursor) {
    params.push(page.cursor.createdAt, page.cursor.id);
    sql += ` AND (p.created_at, p.id) < ($${params.length - 1}, $${params.length})`;
  }
  params.push(page.limit + 1);
  sql += ` ORDER BY ${relevance("p.title", "p.body", "$1", "$2", "$4")}, p.created_at DESC, p.id DESC LIMIT $${params.length}`;
  const rows = await queryPosts(ctx, sql, params);
  const mapped = rows.rows.map((row) => ({ item: postDto(row), createdAt: row.created_at, id: String(row.id) }));
  const paged = pageResult(mapped, page.limit, (row) => ({ createdAt: row.createdAt, id: row.id }));
  return pageBody(paged.items.map((row) => row.item), paged.nextCursor, paged.hasMore, ctx.rid);
}

async function createPost(ctx: Ctx): Promise<Response> {
  const body = await readObject(ctx.request);
  rejectFields(body, ["userId", "createdAt", "id", "viewCount", "author"]);
  if (typeof body.category !== "string" || !POST_CATEGORIES.has(body.category)) {
    throw unprocessable("category", "unsupported category");
  }
  const title = textOf(body.title, "title", 1, 100);
  const text = textOf(body.body, "body", 1, 5000);
  const imageKeys = body.imageKeys == null ? [] : body.imageKeys;
  if (!Array.isArray(imageKeys) || imageKeys.length > 4) throw fieldError("imageKeys", "at most 4 images");
  const keys = imageKeys.map((key) => imageKeyOf(key, "imageKeys")).filter((key): key is string => key != null);
  const fields = searchFields(`${title}\n${text}`);
  const id = crypto.randomUUID();
  const now = ctx.now.toISOString();
  await query(ctx.deps.query,
    `INSERT INTO posts (id, user_id, category, title, body, image_keys, view_count, search_text, search_choseong, search_jamo, created_at)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,0,$7,$8,$9,$10)`,
    [id, ctx.user.id, body.category, title, text, JSON.stringify(keys), fields.text, fields.choseong, fields.jamo, now]);
  const author = await onePost(ctx,
    `SELECT u.is_employer, co.name AS company_name FROM users u
     LEFT JOIN company_members cm ON cm.user_id = u.id
     LEFT JOIN companies co ON co.id = cm.company_id WHERE u.id = $1`,
    [ctx.user.id]);
  return data(201, postDto({
    id, user_id: ctx.user.id, display_name: ctx.user.displayName, category: body.category, title, body: text,
    image_keys: keys, view_count: 0, comment_count: 0, created_at: now,
    is_employer: author ? author.is_employer : ctx.user.accountType === "EMPLOYER",
    company_name: author?.company_name ?? null,
  }), ctx.rid);
}

async function getPost(ctx: Ctx, idRaw: string): Promise<Response> {
  const id = requireUuid(idRaw, "id");
  const row = await one(ctx.deps.query,
    `UPDATE posts SET view_count = view_count + 1 WHERE id = $1 RETURNING id`,
    [id]);
  if (!row) throw notFound();
  const full = await onePost(ctx, "SELECT " + POST_SQL + " WHERE p.id = $1", [id]);
  if (!full) throw notFound();
  return data(200, postDto(full), ctx.rid);
}

async function listComments(ctx: Ctx, idRaw: string): Promise<Response> {
  const id = requireUuid(idRaw, "id");
  const post = await one(ctx.deps.query, "SELECT id FROM posts WHERE id = $1", [id]);
  if (!post) throw notFound();
  const page = pageOf(ctx.url);
  const params: unknown[] = [id];
  let sql = `SELECT c.id, c.user_id, u.display_name, c.body, c.created_at
    FROM post_comments c JOIN users u ON u.id = c.user_id WHERE c.post_id = $1`;
  if (page.cursor) {
    params.push(page.cursor.createdAt, page.cursor.id);
    sql += ` AND (c.created_at, c.id) < ($${params.length - 1}, $${params.length})`;
  }
  params.push(page.limit + 1);
  sql += ` ORDER BY c.created_at DESC, c.id DESC LIMIT $${params.length}`;
  const rows = await query(ctx.deps.query, sql, params);
  const mapped = rows.rows.map((row) => ({
    item: {
      id: String(row.id),
      author: { id: String(row.user_id), displayName: String(row.display_name ?? "") },
      body: String(row.body ?? ""),
      createdAt: ts(row.created_at),
    },
    createdAt: row.created_at,
    id: String(row.id),
  }));
  const paged = pageResult(mapped, page.limit, (row) => ({ createdAt: row.createdAt, id: row.id }));
  return pageBody(paged.items.map((row) => row.item), paged.nextCursor, paged.hasMore, ctx.rid);
}

async function createComment(ctx: Ctx, idRaw: string): Promise<Response> {
  const id = requireUuid(idRaw, "id");
  const post = await one(ctx.deps.query, "SELECT id, user_id, title FROM posts WHERE id = $1", [id]);
  if (!post) throw notFound();
  const body = await readObject(ctx.request);
  const text = textOf(body.body, "body", 1, 1000);
  const commentId = crypto.randomUUID();
  const now = ctx.now.toISOString();
  await query(ctx.deps.query,
    "INSERT INTO post_comments (id, post_id, user_id, body, created_at) VALUES ($1,$2,$3,$4,$5)",
    [commentId, id, ctx.user.id, text, now]);
  await notify(ctx, String(post.user_id), "COMMENT", "새 댓글", text, { kind: "post", id });
  return data(201, {
    id: commentId,
    author: { id: ctx.user.id, displayName: ctx.user.displayName },
    body: text,
    createdAt: ts(now),
  }, ctx.rid);
}

async function listMyPosts(ctx: Ctx): Promise<Response> {
  const page = pageOf(ctx.url);
  const params: unknown[] = [ctx.user.id];
  let sql = "SELECT " + POST_SQL + " WHERE p.user_id = $1";
  if (page.cursor) {
    params.push(page.cursor.createdAt, page.cursor.id);
    sql += ` AND (p.created_at, p.id) < ($${params.length - 1}, $${params.length})`;
  }
  params.push(page.limit + 1);
  sql += ` ORDER BY p.created_at DESC, p.id DESC LIMIT $${params.length}`;
  const rows = await queryPosts(ctx, sql, params);
  const mapped = rows.rows.map((row) => ({ item: postDto(row), createdAt: row.created_at, id: String(row.id) }));
  const paged = pageResult(mapped, page.limit, (row) => ({ createdAt: row.createdAt, id: row.id }));
  return pageBody(paged.items.map((row) => row.item), paged.nextCursor, paged.hasMore, ctx.rid);
}

async function listCommentedPosts(ctx: Ctx): Promise<Response> {
  const page = pageOf(ctx.url);
  const params: unknown[] = [ctx.user.id];
  let sql = `SELECT ${POST_SQL}
    WHERE p.id IN (SELECT post_id FROM post_comments WHERE user_id = $1)`;
  if (page.cursor) {
    params.push(page.cursor.createdAt, page.cursor.id);
    sql += ` AND (p.created_at, p.id) < ($${params.length - 1}, $${params.length})`;
  }
  params.push(page.limit + 1);
  sql += ` ORDER BY p.created_at DESC, p.id DESC LIMIT $${params.length}`;
  const rows = await queryPosts(ctx, sql, params);
  const mapped = rows.rows.map((row) => ({ item: postDto(row), createdAt: row.created_at, id: String(row.id) }));
  const paged = pageResult(mapped, page.limit, (row) => ({ createdAt: row.createdAt, id: row.id }));
  return pageBody(paged.items.map((row) => row.item), paged.nextCursor, paged.hasMore, ctx.rid);
}

export async function dispatchRecruiting(ctx: Ctx, path: string): Promise<Response | null> {
  const method = ctx.request.method;
  if (method === "GET" && path === "/api/v1/postings") return listPostings(ctx);
  if (method === "POST" && path === "/api/v1/postings") return createPosting(ctx);
  if (method === "GET" && path === "/api/v1/postings/locations") return listPostingLocations(ctx);
  const bookmark = path.match(/^\/api\/v1\/postings\/([^/]+)\/bookmark$/);
  if (bookmark && method === "POST") return bookmarkPosting(ctx, bookmark[1]);
  if (bookmark && method === "DELETE") return unbookmarkPosting(ctx, bookmark[1]);
  const apply = path.match(/^\/api\/v1\/postings\/([^/]+)\/apply$/);
  if (apply && method === "POST") return applyPosting(ctx, apply[1]);
  if (method === "GET" && path === "/api/v1/companies/me/postings") return listCompanyPostings(ctx);
  const close = path.match(/^\/api\/v1\/postings\/([^/]+)\/close$/);
  if (close && method === "POST") return closePosting(ctx, close[1]);
  const applicant = path.match(/^\/api\/v1\/postings\/([^/]+)\/applicants\/([^/]+)$/);
  if (applicant && method === "GET") return getApplicant(ctx, applicant[1], applicant[2]);
  if (applicant && method === "PATCH") return patchApplicant(ctx, applicant[1], applicant[2]);
  const applicants = path.match(/^\/api\/v1\/postings\/([^/]+)\/applicants$/);
  if (applicants && method === "GET") return listApplicants(ctx, applicants[1]);
  const posting = path.match(/^\/api\/v1\/postings\/([^/]+)$/);
  if (posting && method === "GET") return getPosting(ctx, posting[1]);
  if (posting && method === "PATCH") return patchPosting(ctx, posting[1]);

  if (method === "GET" && path === "/api/v1/search") return search(ctx);

  if (method === "GET" && path === "/api/v1/profiles") return listProfiles(ctx);
  const offer = path.match(/^\/api\/v1\/profiles\/([^/]+)\/offer$/);
  if (offer && method === "POST") return offerProfile(ctx, offer[1]);
  const profile = path.match(/^\/api\/v1\/profiles\/([^/]+)$/);
  if (profile && method === "GET") return getProfile(ctx, profile[1]);

  const follow = path.match(/^\/api\/v1\/users\/([^/]+)\/follow$/);
  if (follow && method === "POST") return followUser(ctx, follow[1]);
  if (follow && method === "DELETE") return unfollowUser(ctx, follow[1]);

  if (path === "/api/v1/me/profile" && method === "GET") return getMyProfile(ctx);
  if (path === "/api/v1/me/profile" && method === "PATCH") return patchMyProfile(ctx);
  if (path === "/api/v1/me/offers" && method === "GET") return listOffers(ctx);
  const messages = path.match(/^\/api\/v1\/me\/offers\/([^/]+)\/messages$/);
  if (messages && method === "GET") return listOfferMessages(ctx, messages[1]);
  if (messages && method === "POST") return postOfferMessage(ctx, messages[1]);
  const accept = path.match(/^\/api\/v1\/me\/offers\/([^/]+)\/accept$/);
  if (accept && method === "POST") return decideOffer(ctx, accept[1], "ACCEPTED");
  const decline = path.match(/^\/api\/v1\/me\/offers\/([^/]+)\/decline$/);
  if (decline && method === "POST") return decideOffer(ctx, decline[1], "DECLINED");
  const offerId = path.match(/^\/api\/v1\/me\/offers\/([^/]+)$/);
  if (offerId && method === "GET") return getOffer(ctx, offerId[1]);
  if (path === "/api/v1/me/links" && method === "GET") return listLinks(ctx);
  if (path === "/api/v1/me/links" && method === "POST") return createLink(ctx);
  const link = path.match(/^\/api\/v1\/me\/links\/([^/]+)$/);
  if (link && method === "DELETE") return deleteLink(ctx, link[1]);
  if (path === "/api/v1/me/devices" && method === "POST") return registerDevice(ctx);
  const device = path.match(/^\/api\/v1\/me\/devices\/([^/]+)$/);
  if (device && method === "DELETE") return deleteDevice(ctx, device[1]);
  if (path === "/api/v1/me/notifications" && method === "GET") return listNotifications(ctx);
  if (path === "/api/v1/me/notifications/read" && method === "POST") return readNotifications(ctx);
  if (path === "/api/v1/me/settings" && method === "GET") return getSettings(ctx);
  if (path === "/api/v1/me/settings" && method === "PATCH") return patchSettings(ctx);
  if (path === "/api/v1/me/bookmarks" && method === "GET") return listBookmarks(ctx);
  if (path === "/api/v1/me/follows" && method === "GET") return listRelation(ctx, false);
  if (path === "/api/v1/me/followers" && method === "GET") return listRelation(ctx, true);
  if (path === "/api/v1/me/posts" && method === "GET") return listMyPosts(ctx);
  if (path === "/api/v1/me/commented-posts" && method === "GET") return listCommentedPosts(ctx);

  if (path === "/api/v1/posts" && method === "GET") return listPosts(ctx);
  if (path === "/api/v1/posts" && method === "POST") return createPost(ctx);
  const comments = path.match(/^\/api\/v1\/posts\/([^/]+)\/comments$/);
  if (comments && method === "GET") return listComments(ctx, comments[1]);
  if (comments && method === "POST") return createComment(ctx, comments[1]);
  const post = path.match(/^\/api\/v1\/posts\/([^/]+)$/);
  if (post && method === "GET") return getPost(ctx, post[1]);
  return null;
}
