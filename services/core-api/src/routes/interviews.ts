import { parseTimeField, strictBody } from "../body.ts";
import { one, query } from "../db.ts";
import { HttpError, data, fieldError, pageBody, parseUuid, requireUuid } from "../http.ts";
import { pageOf, pageResult, ts } from "../page.ts";
import type { Ctx } from "../types.ts";
import { validTz } from "./calendar.ts";

const COLS = "id, user_id, revision, application_id, title, scheduled_at, duration_minutes, event_id, evidence_ids, company_sources, notes, reflection, created_at, updated_at";
const EVENT_COLS = "id, user_id, revision, application_id, type, title, starts_at, ends_at, time_zone, source, external_id, notes, created_at, updated_at";

type Row = Record<string, unknown>;
type CompanySource = { sourceUrl: string; sourceText: string; accessedAt: string | null };

const notFound = (): HttpError => new HttpError(404, "NOT_FOUND", "resource not found");
const invalidBody = (): HttpError => new HttpError(400, "VALIDATION_ERROR", "invalid request body");
const len = (value: string): number => Array.from(value).length;

const sourceOut = (value: unknown): CompanySource => {
  const s = (value && typeof value === "object" ? value : {}) as Row;
  return {
    sourceUrl: String(s.sourceUrl ?? s.source_url ?? ""),
    sourceText: String(s.sourceText ?? s.source_text ?? ""),
    accessedAt: ts(s.accessedAt ?? s.accessed_at),
  };
};

const interviewDto = (row: Row): Row => ({
  id: String(row.id),
  revision: Number(row.revision),
  applicationId: String(row.application_id),
  title: String(row.title),
  scheduledAt: ts(row.scheduled_at),
  durationMinutes: row.duration_minutes == null ? null : Number(row.duration_minutes),
  eventId: row.event_id == null ? null : String(row.event_id),
  evidenceIds: Array.isArray(row.evidence_ids) ? row.evidence_ids.map(String) : [],
  companySources: Array.isArray(row.company_sources) ? row.company_sources.map(sourceOut) : [],
  notes: String(row.notes ?? ""),
  reflection: String(row.reflection ?? ""),
  createdAt: ts(row.created_at),
  updatedAt: ts(row.updated_at),
});

/** `CompanySourceReq` (strict, no extra keys) plus the router's `accessedAt` parse. */
const companySources = (value: unknown): CompanySource[] => {
  if (!Array.isArray(value)) throw invalidBody();
  const parsed = value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw invalidBody();
    const entry = item as Row;
    const keys = Object.keys(entry);
    if (keys.some((key) => !["sourceUrl", "sourceText", "accessedAt"].includes(key))) throw invalidBody();
    if (typeof entry.sourceUrl !== "string" || typeof entry.sourceText !== "string" || typeof entry.accessedAt !== "string") throw invalidBody();
    return entry as { sourceUrl: string; sourceText: string; accessedAt: string };
  });
  return parsed.map((entry) => ({
    sourceUrl: entry.sourceUrl,
    sourceText: entry.sourceText,
    accessedAt: parseTimeField(entry.accessedAt, "companySources.accessedAt"),
  }));
};

const httpUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
};

const validateSources = (sources: CompanySource[], now: Date): void => {
  if (sources.length > 10) throw fieldError("companySources", "at most 10 sources");
  for (const source of sources) {
    if (!httpUrl(source.sourceUrl)) throw fieldError("companySources", "sourceUrl must be http(s)");
    if (len(source.sourceText) < 1 || len(source.sourceText) > 20000) throw fieldError("companySources", "sourceText must be 1-20000 characters");
    if (Date.parse(String(source.accessedAt)) > now.getTime()) throw fieldError("companySources", "accessedAt cannot be in the future");
  }
};

const queryTime = (ctx: Ctx, name: string): string | null => {
  const raw = ctx.url.searchParams.get(name);
  if (!raw) return null;
  return parseTimeField(raw, name);
};

export const listInterviews = async (ctx: Ctx): Promise<Response> => {
  const appRaw = ctx.url.searchParams.get("applicationId");
  let applicationId: string | null = null;
  if (appRaw) {
    applicationId = parseUuid(appRaw);
    if (!applicationId) throw fieldError("applicationId", "must be a UUID");
  }
  const from = queryTime(ctx, "from");
  const to = queryTime(ctx, "to");
  const page = pageOf(ctx.url);
  const params: unknown[] = [ctx.user.id];
  const where = ["user_id = $1"];
  for (const [value, clause] of [[applicationId, "application_id ="], [from, "scheduled_at >="], [to, "scheduled_at <="]] as const) {
    if (value === null) continue;
    params.push(value);
    where.push(`${clause} $${params.length}`);
  }
  if (page.cursor) {
    params.push(page.cursor.createdAt, page.cursor.id);
    where.push(`(created_at, id) < ($${params.length - 1}, $${params.length})`);
  }
  params.push(page.limit + 1);
  const rows = await query(ctx.deps.query,
    `SELECT ${COLS} FROM interviews WHERE ${where.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT $${params.length}`, params);
  const paged = pageResult(rows.rows, page.limit, (row) => ({ createdAt: row.created_at, id: String(row.id) }));
  return pageBody(paged.items.map(interviewDto), paged.nextCursor, paged.hasMore, ctx.rid);
};

const loadInterview = async (ctx: Ctx, id: string): Promise<Row> => {
  const row = await one(ctx.deps.query, `SELECT ${COLS} FROM interviews WHERE id = $1 AND user_id = $2`, [id, ctx.user.id]);
  if (!row) throw notFound();
  return row;
};

export const getInterview = async (ctx: Ctx, idRaw: string): Promise<Response> =>
  data(200, interviewDto(await loadInterview(ctx, requireUuid(idRaw, "id"))), ctx.rid);

export const createInterview = async (ctx: Ctx): Promise<Response> => {
  const { values } = await strictBody(ctx.request, {
    applicationId: { kind: "uuid", required: true },
    title: { kind: "str", required: true },
    scheduledAt: { kind: "str", required: true },
    durationMinutes: { kind: "int", nullable: true },
    evidenceIds: { kind: "uuid[]" },
    companySources: { kind: "any" },
    notes: { kind: "str" },
    timeZone: { kind: "str", required: true },
  });
  const scheduledAt = parseTimeField(values.scheduledAt, "scheduledAt");
  const sources = values.companySources === undefined ? [] : companySources(values.companySources);
  const title = String(values.title);
  if (len(title) < 1 || len(title) > 300) throw fieldError("title", "title must be 1-300 characters");
  validateSources(sources, ctx.now);
  const applicationId = String(values.applicationId);
  const app = await one(ctx.deps.query, "SELECT id FROM applications WHERE id = $1 AND user_id = $2", [applicationId, ctx.user.id]);
  if (!app) throw notFound();
  const evidenceIds = (values.evidenceIds as string[] | undefined) ?? [];
  for (const eid of evidenceIds) {
    const found = await one(ctx.deps.query, "SELECT id FROM career_evidence WHERE id = $1 AND user_id = $2", [eid, ctx.user.id]);
    if (!found) throw fieldError("evidenceIds", "evidence " + eid + " not found");
  }
  const tz = String(values.timeZone) || "UTC";
  if (!validTz(tz)) throw fieldError("timeZone", "invalid IANA time zone");
  const duration = values.durationMinutes == null ? null : Number(values.durationMinutes);
  const notes = String(values.notes ?? "");
  const now = ts(ctx.now);
  const row: Row = {
    id: crypto.randomUUID(), revision: 1, application_id: applicationId, title, scheduled_at: scheduledAt,
    duration_minutes: duration, event_id: crypto.randomUUID(), evidence_ids: evidenceIds, company_sources: sources,
    notes, reflection: "", created_at: now, updated_at: now,
  };
  await query(ctx.deps.query,
    `WITH ev AS (INSERT INTO calendar_events (${EVENT_COLS}) VALUES ($1, $2, 1, $3, 'INTERVIEW', $4, $5, $5::timestamptz + make_interval(mins => COALESCE($6::int, 0)), $7, 'LOCAL', NULL, $8, $9, $9) RETURNING id),
     iv AS (INSERT INTO interviews (${COLS}) SELECT $10, $2, 1, $3, $4, $5, $6, ev.id, $11::jsonb, $12::jsonb, $8, '', $9, $9 FROM ev RETURNING id)
     INSERT INTO application_events (id, user_id, application_id, type, payload, created_at) SELECT $13, $2, $3, 'INTERVIEW', $14::jsonb, $9 FROM iv`,
    [row.event_id, ctx.user.id, applicationId, title, scheduledAt, duration, tz, notes, now, row.id,
      JSON.stringify(evidenceIds), JSON.stringify(sources), crypto.randomUUID(),
      JSON.stringify({ interviewId: row.id, scheduledAt })]);
  return data(201, interviewDto(row), ctx.rid);
};

export const patchInterview = async (ctx: Ctx, idRaw: string): Promise<Response> => {
  const id = requireUuid(idRaw, "id");
  const { values } = await strictBody(ctx.request, {
    expectedRevision: { kind: "int", required: true },
    title: { kind: "str", nullable: true },
    scheduledAt: { kind: "str", nullable: true },
    companySources: { kind: "any", nullable: true },
    notes: { kind: "str", nullable: true },
    reflection: { kind: "str", nullable: true },
  });
  const scheduledAt = values.scheduledAt == null ? null : parseTimeField(values.scheduledAt, "scheduledAt");
  const sources = values.companySources == null ? null : companySources(values.companySources);
  const expected = Number(values.expectedRevision);
  const row = await loadInterview(ctx, id);
  if (Number(row.revision) !== expected) {
    throw new HttpError(409, "REVISION_CONFLICT", "resource was modified", { currentRevision: Number(row.revision) });
  }
  if (values.title != null) {
    const title = String(values.title);
    if (len(title) < 1 || len(title) > 300) throw fieldError("title", "title must be 1-300 characters");
    row.title = title;
  }
  if (scheduledAt !== null) row.scheduled_at = scheduledAt;
  if (sources !== null) {
    validateSources(sources, ctx.now);
    row.company_sources = sources;
  }
  if (values.notes != null) row.notes = values.notes;
  if (values.reflection != null) row.reflection = values.reflection;
  const now = ts(ctx.now);
  row.updated_at = now;
  const moveEvent = row.event_id != null && scheduledAt !== null;
  const updated = await one(ctx.deps.query,
    `WITH upd AS (UPDATE interviews SET revision = revision + 1, title = $3, scheduled_at = $4, company_sources = $5::jsonb, notes = $6, reflection = $7, updated_at = $8
       WHERE id = $1 AND user_id = $2 AND revision = $9 RETURNING id, scheduled_at, duration_minutes, event_id),
     cal AS (UPDATE calendar_events SET starts_at = upd.scheduled_at, ends_at = upd.scheduled_at + make_interval(mins => COALESCE(upd.duration_minutes, 0)), updated_at = now()
       FROM upd WHERE calendar_events.id = upd.event_id AND $10)
     SELECT id FROM upd`,
    [id, ctx.user.id, row.title, ts(row.scheduled_at), JSON.stringify(Array.isArray(row.company_sources) ? row.company_sources.map(sourceOut) : []),
      row.notes, row.reflection, now, expected, moveEvent]);
  if (!updated) {
    const current = await one(ctx.deps.query, "SELECT revision FROM interviews WHERE id = $1 AND user_id = $2", [id, ctx.user.id]);
    if (!current) throw notFound();
    throw new HttpError(409, "REVISION_CONFLICT", "resource was modified", { currentRevision: Number(current.revision) });
  }
  row.revision = expected + 1;
  return data(200, interviewDto(row), ctx.rid);
};

export const dispatchInterviews = async (ctx: Ctx, path: string): Promise<Response | null> => {
  const method = ctx.request.method;
  if (path === "/api/v1/interviews") {
    if (method === "GET") return listInterviews(ctx);
    if (method === "POST") return createInterview(ctx);
    return null;
  }
  const m = path.match(/^\/api\/v1\/interviews\/([^/]+)$/);
  if (!m) return null;
  if (method === "GET") return getInterview(ctx, m[1]);
  if (method === "PATCH") return patchInterview(ctx, m[1]);
  return null;
};
