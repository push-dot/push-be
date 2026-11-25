import { isMissingRelation, isUndefinedColumn, one } from "../db.ts";
import type { Row } from "../db.ts";
import { HttpError, asBool, codePoints, fieldError, jsonList } from "../http.ts";
import type { JsonObject } from "../json.ts";
import { ts } from "../page.ts";
import { decodeCursor, encodeCursor } from "../time.ts";
import { sendNotification } from "../push/notify.ts";
import type { Ctx } from "../types.ts";

export const JOB_CATEGORIES = new Set(["dev", "data", "design", "plan", "marketing", "sales", "hr", "ops"]);

const IMAGE_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

export const GUEST_ID = "00000000-0000-0000-0000-000000000000";

const NOTIFY_COLUMN = new Map([
  ["DEADLINE", "notify_deadline"],
  ["OFFER", "notify_offer"],
  ["COMMENT", "notify_comment"],
  ["AI_DONE", "notify_ai_done"],
  ["APPLICATION_STAGE", "notify_application_stage"],
]);

export function unprocessable(field: string, message: string): HttpError {
  return new HttpError(422, "VALIDATION_ERROR", message, { field });
}

export function notFound(): HttpError {
  return new HttpError(404, "NOT_FOUND", "resource not found");
}

// JSON.parse output is plain JSON, so a non-array object is a JsonObject.
export const isJsonObject = (value: unknown): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);

export async function readObject(request: Request): Promise<JsonObject> {
  const raw = await request.text();
  if (!raw) {throw new HttpError(400, "VALIDATION_ERROR", "request body required");}
  try {
    const body: unknown = JSON.parse(raw);
    if (!isJsonObject(body)) {throw new Error("shape");}
    return body;
  } catch (error) {
    if (error instanceof HttpError) {throw error;}
    throw new HttpError(400, "VALIDATION_ERROR", "invalid request body");
  }
}

export function rejectFields(body: JsonObject, fields: Array<string>): void {
  for (const field of fields) {
    if (field in body) {throw fieldError(field, "server-managed field");}
  }
}

export function textOf(value: unknown, field: string, min: number, max: number): string {
  if (typeof value !== "string") {throw fieldError(field, "must be a string");}
  const size = codePoints(value);
  if (size < min || size > max) {throw fieldError(field, `${field} must be ${min}-${max} characters`);}
  return value;
}

export function intOf(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw fieldError(field, "invalid " + field);
  }
  return value;
}

export function boolOf(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {throw fieldError(field, "must be a boolean");}
  return value;
}

export function dateOf(value: unknown, field: string): string | null {
  if ((value === null || value === undefined)) {return null;}
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw fieldError(field, "must be YYYY-MM-DD");
  }
  return value;
}

export function httpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password && Boolean(url.hostname);
  } catch {
    return false;
  }
}

export function stringList(value: unknown, field: string, maxItems: number, maxLen: number): Array<string> {
  if ((value === null || value === undefined)) {return [];}
  if (!Array.isArray(value)) {throw fieldError(field, "must be an array");}
  if (value.length > maxItems) {throw fieldError(field, "too many items");}
  return value.map((item) => textOf(item, field, 1, maxLen));
}

export function imageKeyOf(value: unknown, field: string): string | null {
  if ((value === null || value === undefined) || value === "") {return null;}
  if (typeof value !== "string" || !IMAGE_KEY.test(value) || value.includes("..")) {
    throw fieldError(field, "invalid image key");
  }
  return value;
}

export function imageUrl(key: unknown): string | null {
  if ((key === null || key === undefined) || key === "") {return null;}
  return "/api/v1/uploads/images/" + encodeURIComponent(String(key));
}

export function jsonObject(value: unknown): JsonObject {
  let raw = value;
  if (typeof raw === "string") {
    try { raw = JSON.parse(raw); } catch { return {}; }
  }
  return isJsonObject(raw) ? raw : {};
}

export function splitList(url: URL, name: string): Array<string> {
  const raw = url.searchParams.get(name);
  if (!raw) {return [];}
  return raw.split(",").map((part) => part.trim()).filter((part) => part.length > 0);
}

export function enumList(url: URL, name: string, allowed: Set<string>, field: string): Array<string> {
  const values = splitList(url, name);
  for (const value of values) {
    if (!allowed.has(value)) {throw unprocessable(field, "unsupported " + field);}
  }
  return values;
}

export function pushArray(params: Array<unknown>, values: Array<string>): number {
  params.push(values.join("\u001f"));
  return params.length;
}

export function anyOf(index: number): string {
  return `string_to_array($${index}, E'\\x1f')`;
}

export function postingDto(row: Row, detail: boolean, member = false): JsonObject {
  const dto: JsonObject = {
    id: String(row.id),
    company: String(row.company ?? ""),
    title: String(row.title ?? ""),
    jobCategory: String(row.job_category ?? ""),
    imageUrl: imageUrl(row.image_key),
    skills: jsonList(row.skills).map(String),
    careerMin: Number(row.career_min ?? 0),
    careerMax: (row.career_max === null || row.career_max === undefined) ? null : Number(row.career_max),
    location: String(row.location ?? ""),
    employmentType: String(row.employment_type ?? ""),
    deadline: (row.deadline === null || row.deadline === undefined) || row.deadline === "" ? null : String(row.deadline).slice(0, 10),
    bookmarked: asBool(row.bookmarked),
    applied: asBool(row.applied),
    sourceUrl: (row.source_url === null || row.source_url === undefined) ? null : String(row.source_url),
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
  if (detail || member) {dto.applicantCount = Number(row.applicant_count ?? 0);}
  if (member) {
    const stored = (row.status === null || row.status === undefined) || row.status === "" ? "" : String(row.status);
    dto.status = stored || ((row.closed_at !== null && row.closed_at !== undefined) ? "CLOSED" : "OPEN");
    dto.newApplicantCount = Number(row.new_applicant_count ?? 0);
    const createdName = (row.created_by_name === null || row.created_by_name === undefined) || row.created_by_name === "" ? "" : String(row.created_by_name);
    dto.createdBy = createdName ? { displayName: createdName } : null;
    dto.draftSource = (row.draft_source === null || row.draft_source === undefined) || row.draft_source === "" ? null : String(row.draft_source);
  } else if ((row.status !== null && row.status !== undefined) && row.status !== "") {
    dto.status = String(row.status);
  }
  return dto;
}

export const POSTING_COLS = "p.id, p.company, p.title, p.job_category, p.image_key, p.skills, p.career_min, p.career_max, p.location, p.employment_type, p.deadline, p.source_url, p.created_at, p.revision, p.preferred, p.closed_at";

export const openClause = (withStatus: boolean): string =>
  withStatus ? "p.status = 'OPEN' AND p.closed_at IS NULL" : "p.closed_at IS NULL";

export const withPublicStatus = async <T>(run: (withStatus: boolean) => Promise<T>): Promise<T> => {
  try {
    return await run(true);
  } catch (error) {
    if (!isUndefinedColumn(error)) {throw error;}
    return run(false);
  }
};

const usesParam = (sql: string, index: number): boolean => new RegExp(`\\$${index}(?!\\d)`).test(sql);

export const countWhere = async (ctx: Ctx, sql: string, marker: string, params: Array<unknown>): Promise<number> => {
  const at = sql.lastIndexOf(marker);
  if (at < 0) {return 0;}
  let countSql = "SELECT count(*)::int AS total" + sql.slice(at);
  for (let index = 1; index <= params.length; index += 1) {
    if (!usesParam(countSql, index)) {countSql += ` AND $${index} IS NOT DISTINCT FROM $${index}`;}
  }
  const read = async (statement: string): Promise<number> => {
    const row = await one(ctx.deps.query, statement, params);
    return Number(row?.total ?? 0);
  };
  try {
    return await read(countSql);
  } catch (error) {
    if (!(isMissingRelation(error) || isUndefinedColumn(error)) || !countSql.includes("company_members")) {throw error;}
    const fallback = countSql
      .replaceAll(" LEFT JOIN company_members cm ON cm.user_id = u.id", "")
      .replaceAll(" LEFT JOIN company_members sm ON sm.user_id = o.sender_id", "")
      .replaceAll(" LEFT JOIN company_members rm ON rm.user_id = o.profile_user_id", "")
      .replaceAll(" LEFT JOIN companies co ON co.id = cm.company_id", "")
      .replaceAll(" LEFT JOIN companies sc ON sc.id = sm.company_id", "")
      .replaceAll(" LEFT JOIN companies rc ON rc.id = rm.company_id", "");
    return read(fallback);
  }
};

export type SearchSort = "relevance" | "latest";

export const searchSortMode = (url: URL): SearchSort => {
  const raw = url.searchParams.get("sort");
  if ((raw === null || raw === undefined) || raw === "relevance") {return "relevance";}
  if (raw === "latest") {return "latest";}
  throw unprocessable("sort", "unsupported sort");
};

export const assertSearchCursor = (url: URL, sort: SearchSort): void => {
  const encoded = url.searchParams.get("cursor");
  if (!encoded) {return;}
  const marked = decodeCursor(encoded).sort ?? "relevance";
  if (sort === "latest" && marked !== "latest") {throw fieldError("cursor", "cursor does not match sort");}
  if (sort === "relevance" && marked === "latest") {throw fieldError("cursor", "cursor does not match sort");}
};

export const stampSearchCursor = (cursor: string | null, sort: SearchSort): string | null => {
  if (!cursor) {return null;}
  const decoded = decodeCursor(cursor);
  return encodeCursor(decoded.createdAt, decoded.id, sort);
};

// The pattern parameters come from queryForms, already escaped for LIKE; an unwildcarded ILIKE is the exact, case-insensitive match.
export function relevance(title: string, extra: string, raw = "$2", cho = "$3", hangul = "$5"): string {
  return `CASE
    WHEN ${title} ILIKE ${raw} ESCAPE '\\' OR ${extra} ILIKE ${raw} ESCAPE '\\' THEN 0
    WHEN ${title} ILIKE ${raw} || '%' ESCAPE '\\' OR ${extra} ILIKE ${raw} || '%' ESCAPE '\\' THEN 1
    WHEN search_choseong LIKE '%' || ${cho} || '%' ESCAPE '\\' THEN 2
    WHEN ${hangul} <> '' AND (${title} ILIKE '%' || ${hangul} || '%' ESCAPE '\\' OR ${extra} ILIKE '%' || ${hangul} || '%' ESCAPE '\\') THEN 3
    ELSE 4 END`;
}

// Hides accounts in the deletion grace period.
export const NOT_DELETING = "u.deletion_requested_at IS NULL";

interface Person { id: string; displayName: string }

export function person(row: Row, idKey: string, nameKey: string): Person {
  return { id: String(row[idKey] ?? ""), displayName: String(row[nameKey] ?? "") };
}

export function offerDto(row: Row): JsonObject {
  return {
    id: String(row.id),
    sender: {
      ...person(row, "sender_id", "sender_name"),
      kind: (row.sender_company === null || row.sender_company === undefined) || row.sender_company === "" ? "PERSON" : "COMPANY",
      companyName: (row.sender_company === null || row.sender_company === undefined) || row.sender_company === "" ? null : String(row.sender_company),
      headline: (row.sender_headline === null || row.sender_headline === undefined) ? "" : String(row.sender_headline),
      avatarUrl: imageUrl(row.sender_avatar),
    },
    recipient: {
      ...person(row, "profile_user_id", "recipient_name"),
      kind: (row.recipient_company === null || row.recipient_company === undefined) || row.recipient_company === "" ? "PERSON" : "COMPANY",
      companyName: (row.recipient_company === null || row.recipient_company === undefined) || row.recipient_company === "" ? null : String(row.recipient_company),
      headline: (row.recipient_headline === null || row.recipient_headline === undefined) ? "" : String(row.recipient_headline),
      avatarUrl: imageUrl(row.recipient_avatar),
    },
    message: String(row.message ?? ""),
    posting: (row.posting_id === null || row.posting_id === undefined) ? null : {
      id: String(row.posting_id),
      title: String(row.posting_title ?? ""),
      company: String(row.posting_company ?? ""),
      imageUrl: imageUrl(row.posting_image),
      location: String(row.posting_location ?? ""),
      careerMin: Number(row.posting_career_min ?? 0),
      careerMax: (row.posting_career_max === null || row.posting_career_max === undefined) ? null : Number(row.posting_career_max),
      deadline: (row.posting_deadline === null || row.posting_deadline === undefined) || row.posting_deadline === "" ? null : String(row.posting_deadline).slice(0, 10),
    },
    status: String(row.status ?? "SENT"),
    readAt: ts(row.read_at),
    respondedAt: ts(row.responded_at),
    canSend: String(row.status) === "ACCEPTED" && !asBool(row.blocked_me),
    createdAt: ts(row.created_at),
    archivedAt: ts(row.archived_at),
  };
}

export const OFFER_COLS = `o.id, o.sender_id, su.display_name AS sender_name, o.profile_user_id, ru.display_name AS recipient_name,
  o.message, o.posting_id, jp.title AS posting_title, jp.company AS posting_company, jp.image_key AS posting_image,
  jp.location AS posting_location, jp.career_min AS posting_career_min, jp.career_max AS posting_career_max, jp.deadline AS posting_deadline,
  o.status, o.read_at, to_jsonb(o)->>'responded_at' AS responded_at, o.created_at, sp.headline AS sender_headline, sp.avatar_key AS sender_avatar, sc.name AS sender_company,
  rp.headline AS recipient_headline, rp.avatar_key AS recipient_avatar, rc.name AS recipient_company`;

export const OFFER_FROM = `
  FROM offers o
  JOIN users su ON su.id = o.sender_id
  JOIN users ru ON ru.id = o.profile_user_id
  LEFT JOIN profiles sp ON sp.user_id = o.sender_id
  LEFT JOIN company_members sm ON sm.user_id = o.sender_id
  LEFT JOIN companies sc ON sc.id = sm.company_id
  LEFT JOIN profiles rp ON rp.user_id = o.profile_user_id
  LEFT JOIN company_members rm ON rm.user_id = o.profile_user_id
  LEFT JOIN companies rc ON rc.id = rm.company_id
  LEFT JOIN job_postings jp ON jp.id = o.posting_id`;

export const OFFER_SQL = OFFER_COLS + OFFER_FROM;

export async function notify(ctx: Ctx, userId: string, type: string, title: string, body: string, target: JsonObject): Promise<void> {
  if (userId === ctx.user.id) {return;}
  const column = NOTIFY_COLUMN.get(type);
  if (!column) {return;}
  const pref = await one(ctx.deps.query, `SELECT ${column} AS enabled FROM user_settings WHERE user_id = $1`, [userId]);
  if (pref && !asBool(pref.enabled)) {return;}
  await sendNotification(ctx, { userId, type, title, body, target });
}
