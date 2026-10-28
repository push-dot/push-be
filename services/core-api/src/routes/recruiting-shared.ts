import { isMissingRelation, isUndefinedColumn, one, query } from "../db.ts";
import { HttpError, asBool, codePoints, data, fieldError, jsonList } from "../http.ts";
import { ts } from "../page.ts";
import { sendNotification } from "../push/notify.ts";
import type { Ctx } from "../types.ts";

export const JOB_CATEGORIES = new Set(["dev", "data", "design", "plan", "marketing", "sales", "hr", "ops"]);

const IMAGE_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

export const GUEST_ID = "00000000-0000-0000-0000-000000000000";

const NOTIFY_COLUMN: Record<string, string> = {
  DEADLINE: "notify_deadline",
  OFFER: "notify_offer",
  COMMENT: "notify_comment",
  AI_DONE: "notify_ai_done",
  APPLICATION_STAGE: "notify_application_stage",
};

export function unprocessable(field: string, message: string): HttpError {
  return new HttpError(422, "VALIDATION_ERROR", message, { field });
}

export function notFound(): HttpError {
  return new HttpError(404, "NOT_FOUND", "resource not found");
}

export async function readObject(request: Request): Promise<Record<string, unknown>> {
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

export function rejectFields(body: Record<string, unknown>, fields: string[]): void {
  for (const field of fields) {
    if (field in body) throw fieldError(field, "server-managed field");
  }
}

export function textOf(value: unknown, field: string, min: number, max: number): string {
  if (typeof value !== "string") throw fieldError(field, "must be a string");
  const size = codePoints(value);
  if (size < min || size > max) throw fieldError(field, `${field} must be ${min}-${max} characters`);
  return value;
}

function optionalText(value: unknown, field: string, max: number): string | null {
  if (value == null) return null;
  return textOf(value, field, 0, max);
}

export function intOf(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw fieldError(field, "invalid " + field);
  }
  return value;
}

export function boolOf(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw fieldError(field, "must be a boolean");
  return value;
}

export function dateOf(value: unknown, field: string): string | null {
  if (value == null) return null;
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

export function stringList(value: unknown, field: string, maxItems: number, maxLen: number): string[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw fieldError(field, "must be an array");
  if (value.length > maxItems) throw fieldError(field, "too many items");
  return value.map((item) => textOf(item, field, 1, maxLen));
}

export function imageKeyOf(value: unknown, field: string): string | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || !IMAGE_KEY.test(value) || value.includes("..")) {
    throw fieldError(field, "invalid image key");
  }
  return value;
}

export function imageUrl(key: unknown): string | null {
  if (key == null || key === "") return null;
  return "/api/v1/uploads/images/" + encodeURIComponent(String(key));
}

export function jsonObject(value: unknown): Record<string, unknown> {
  let raw = value;
  if (typeof raw === "string") {
    try { raw = JSON.parse(raw); } catch { return {}; }
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return raw as Record<string, unknown>;
}

export function splitList(url: URL, name: string): string[] {
  const raw = url.searchParams.get(name);
  if (!raw) return [];
  return raw.split(",").map((part) => part.trim()).filter((part) => part.length > 0);
}

export function enumList(url: URL, name: string, allowed: Set<string>, field: string): string[] {
  const values = splitList(url, name);
  for (const value of values) {
    if (!allowed.has(value)) throw unprocessable(field, "unsupported " + field);
  }
  return values;
}

export function pushArray(params: unknown[], values: string[]): number {
  params.push(values.join("\u001f"));
  return params.length;
}

export function anyOf(index: number): string {
  return `string_to_array($${index}, E'\\x1f')`;
}

export function postingDto(row: Record<string, unknown>, detail: boolean, member = false): Record<string, unknown> {
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
  if (detail || member) dto.applicantCount = Number(row.applicant_count ?? 0);
  if (member) {
    const stored = row.status == null || row.status === "" ? "" : String(row.status);
    dto.status = stored || (row.closed_at != null ? "CLOSED" : "OPEN");
    dto.newApplicantCount = Number(row.new_applicant_count ?? 0);
    const createdName = row.created_by_name == null || row.created_by_name === "" ? "" : String(row.created_by_name);
    dto.createdBy = createdName ? { displayName: createdName } : null;
  } else if (row.status != null && row.status !== "") {
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
  } catch (err) {
    if (!isUndefinedColumn(err)) throw err;
    return run(false);
  }
};

const usesParam = (sql: string, index: number): boolean => new RegExp(`\\$${index}(?!\\d)`).test(sql);

export const countWhere = async (ctx: Ctx, sql: string, marker: string, params: unknown[]): Promise<number> => {
  const at = sql.lastIndexOf(marker);
  if (at < 0) return 0;
  let countSql = "SELECT count(*)::int AS total" + sql.slice(at);
  for (let index = 1; index <= params.length; index += 1) {
    if (!usesParam(countSql, index)) countSql += ` AND $${index} IS NOT DISTINCT FROM $${index}`;
  }
  const read = async (statement: string): Promise<number> => {
    const row = await one(ctx.deps.query, statement, params);
    return Number(row?.total ?? 0);
  };
  try {
    return await read(countSql);
  } catch (err) {
    if (!(isMissingRelation(err) || isUndefinedColumn(err)) || !countSql.includes("company_members")) throw err;
    const fallback = countSql
      .replaceAll(" LEFT JOIN company_members cm ON cm.user_id = u.id", "")
      .replaceAll(" LEFT JOIN company_members sm ON sm.user_id = o.sender_id", "")
      .replaceAll(" LEFT JOIN companies co ON co.id = cm.company_id", "")
      .replaceAll(" LEFT JOIN companies sc ON sc.id = sm.company_id", "");
    return read(fallback);
  }
};

export function relevance(title: string, extra: string, raw = "$2", cho = "$3", hangul = "$5"): string {
  return `CASE
    WHEN lower(${title}) = lower(${raw}) OR lower(${extra}) = lower(${raw}) THEN 0
    WHEN ${title} ILIKE ${raw} || '%' OR ${extra} ILIKE ${raw} || '%' THEN 1
    WHEN search_choseong LIKE '%' || ${cho} || '%' THEN 2
    WHEN ${hangul} <> '' AND (${title} ILIKE '%' || ${hangul} || '%' OR ${extra} ILIKE '%' || ${hangul} || '%') THEN 3
    ELSE 4 END`;
}

// Hides accounts in the deletion grace period. Read through to_jsonb so it also runs before migration 0018.
// shortcut: per-row jsonb cast, switch to u.deletion_requested_at IS NULL once 0018 is on Neon.
export const NOT_DELETING = "to_jsonb(u) ->> 'deletion_requested_at' IS NULL";

export function person(row: Record<string, unknown>, idKey: string, nameKey: string): { id: string; displayName: string } {
  return { id: String(row[idKey] ?? ""), displayName: String(row[nameKey] ?? "") };
}

export function offerDto(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: String(row.id),
    sender: {
      ...person(row, "sender_id", "sender_name"),
      companyName: row.sender_company == null || row.sender_company === "" ? null : String(row.sender_company),
      headline: row.sender_headline == null ? "" : String(row.sender_headline),
      avatarUrl: imageUrl(row.sender_avatar),
    },
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

export const OFFER_SQL = `o.id, o.sender_id, su.display_name AS sender_name, o.profile_user_id, ru.display_name AS recipient_name,
  o.message, o.posting_id, jp.title AS posting_title, jp.company AS posting_company, jp.image_key AS posting_image,
  o.status, o.read_at, o.created_at, sp.headline AS sender_headline, sp.avatar_key AS sender_avatar, sc.name AS sender_company
  FROM offers o
  JOIN users su ON su.id = o.sender_id
  JOIN users ru ON ru.id = o.profile_user_id
  LEFT JOIN profiles sp ON sp.user_id = o.sender_id
  LEFT JOIN company_members sm ON sm.user_id = o.sender_id
  LEFT JOIN companies sc ON sc.id = sm.company_id
  LEFT JOIN job_postings jp ON jp.id = o.posting_id`;

export async function notify(ctx: Ctx, userId: string, type: string, title: string, body: string, target: Record<string, unknown>): Promise<void> {
  if (userId === ctx.user.id) return;
  const column = NOTIFY_COLUMN[type];
  if (!column) return;
  const pref = await one(ctx.deps.query, `SELECT ${column} AS enabled FROM user_settings WHERE user_id = $1`, [userId]);
  if (pref && !asBool(pref.enabled)) return;
  await sendNotification(ctx, { userId, type, title, body, target });
}
