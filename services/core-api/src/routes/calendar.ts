import { one, query } from "../db.ts";
import { HttpError, data, pageBody, requireUuid } from "../http.ts";
import { pageOf, pageResult, revisionUpdate, ts } from "../page.ts";
import type { Ctx } from "../types.ts";

const TYPES = new Set(["INTERVIEW", "DEADLINE", "FOLLOW_UP", "CUSTOM"]);

function validTz(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function eventDto(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: String(row.id),
    revision: Number(row.revision),
    applicationId: row.application_id == null ? null : String(row.application_id),
    type: String(row.type),
    title: String(row.title ?? ""),
    startsAt: ts(row.starts_at),
    endsAt: ts(row.ends_at),
    timeZone: String(row.time_zone ?? "UTC"),
    source: String(row.source ?? "LOCAL"),
    externalId: row.external_id == null ? null : String(row.external_id),
    notes: String(row.notes ?? ""),
    createdAt: ts(row.created_at),
    updatedAt: ts(row.updated_at),
  };
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

function parseTime(value: unknown, field: string): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new HttpError(400, "VALIDATION_ERROR", "must be RFC3339", { field });
  }
  return new Date(value).toISOString();
}

export async function listEvents(ctx: Ctx): Promise<Response> {
  const from = ctx.url.searchParams.get("from");
  const to = ctx.url.searchParams.get("to");
  if (!from || !to) throw new HttpError(400, "VALIDATION_ERROR", "from and to are required");
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  if (Number.isNaN(fromMs)) throw new HttpError(400, "VALIDATION_ERROR", "must be RFC3339", { field: "from" });
  if (Number.isNaN(toMs)) throw new HttpError(400, "VALIDATION_ERROR", "must be RFC3339", { field: "to" });
  if (toMs <= fromMs) throw new HttpError(400, "VALIDATION_ERROR", "must be after from", { field: "to" });
  if (toMs - fromMs > 366 * 24 * 60 * 60 * 1000) {
    throw new HttpError(400, "VALIDATION_ERROR", "range must be at most 366 days", { field: "to" });
  }
  const page = pageOf(ctx.url);
  const params: unknown[] = [ctx.user.id, new Date(fromMs).toISOString(), new Date(toMs).toISOString()];
  let sql = "SELECT id, revision, application_id, type, title, starts_at, ends_at, time_zone, source, external_id, notes, created_at, updated_at FROM calendar_events WHERE user_id = $1 AND starts_at >= $2 AND starts_at <= $3";
  const app = ctx.url.searchParams.get("applicationId");
  if (app) {
    params.push(requireUuid(app, "applicationId"));
    sql += ` AND application_id = $${params.length}`;
  }
  if (page.cursor) {
    params.push(page.cursor.createdAt, page.cursor.id);
    sql += ` AND (created_at, id) < ($${params.length - 1}, $${params.length})`;
  }
  params.push(page.limit + 1);
  sql += ` ORDER BY created_at DESC, id DESC LIMIT $${params.length}`;
  const rows = await query(ctx.deps.query, sql, params);
  const mapped = rows.rows.map((row) => ({ item: eventDto(row), createdAt: row.created_at, id: String(row.id) }));
  const paged = pageResult(mapped, page.limit, (row) => ({ createdAt: row.createdAt, id: row.id }));
  return pageBody(paged.items.map((row) => row.item), paged.nextCursor, paged.hasMore, ctx.rid);
}

export async function createEvent(ctx: Ctx): Promise<Response> {
  const body = await readObject(ctx.request);
  const type = String(body.type ?? "");
  const title = String(body.title ?? "");
  if (!TYPES.has(type)) throw new HttpError(400, "VALIDATION_ERROR", "unsupported event type", { field: "type" });
  if (title.length < 1 || title.length > 300) {
    throw new HttpError(400, "VALIDATION_ERROR", "title must be 1-300 characters", { field: "title" });
  }
  const starts = parseTime(body.startsAt, "startsAt");
  const ends = parseTime(body.endsAt, "endsAt");
  if (Date.parse(ends) <= Date.parse(starts)) {
    throw new HttpError(400, "VALIDATION_ERROR", "must be after startsAt", { field: "endsAt" });
  }
  const tz = typeof body.timeZone === "string" && body.timeZone ? body.timeZone : "UTC";
  if (!validTz(tz)) throw new HttpError(400, "VALIDATION_ERROR", "invalid IANA time zone", { field: "timeZone" });
  const notes = typeof body.notes === "string" ? body.notes : "";
  let applicationId: string | null = null;
  if (body.applicationId != null) {
    applicationId = requireUuid(String(body.applicationId), "applicationId");
    const app = await one(ctx.deps.query, "SELECT id FROM applications WHERE id = $1 AND user_id = $2", [applicationId, ctx.user.id]);
    if (!app) throw new HttpError(404, "NOT_FOUND", "resource not found");
  }
  const id = crypto.randomUUID();
  const now = ctx.now.toISOString();
  await query(ctx.deps.query,
    "INSERT INTO calendar_events (id, user_id, revision, application_id, type, title, starts_at, ends_at, time_zone, source, external_id, notes, created_at, updated_at) VALUES ($1,$2,1,$3,$4,$5,$6,$7,$8,'LOCAL',NULL,$9,$10,$10)",
    [id, ctx.user.id, applicationId, type, title, starts, ends, tz, notes, now]);
  return data(201, eventDto({
    id, revision: 1, application_id: applicationId, type, title, starts_at: starts, ends_at: ends,
    time_zone: tz, source: "LOCAL", external_id: null, notes, created_at: now, updated_at: now,
  }), ctx.rid);
}

export async function patchEvent(ctx: Ctx, idRaw: string): Promise<Response> {
  const id = requireUuid(idRaw, "id");
  const body = await readObject(ctx.request);
  if (typeof body.expectedRevision !== "number") throw new HttpError(400, "VALIDATION_ERROR", "invalid request body");
  const current = await one(ctx.deps.query,
    "SELECT id, revision, application_id, type, title, starts_at, ends_at, time_zone, source, external_id, notes, created_at FROM calendar_events WHERE id = $1 AND user_id = $2",
    [id, ctx.user.id]);
  if (!current) throw new HttpError(404, "NOT_FOUND", "resource not found");
  if (Number(current.revision) !== body.expectedRevision) {
    throw new HttpError(409, "REVISION_CONFLICT", "resource was modified", { currentRevision: Number(current.revision) });
  }
  if (body.title != null) {
    if (typeof body.title !== "string" || body.title.length < 1 || body.title.length > 300) {
      throw new HttpError(400, "VALIDATION_ERROR", "title must be 1-300 characters", { field: "title" });
    }
    current.title = body.title;
  }
  if (body.startsAt != null) current.starts_at = parseTime(body.startsAt, "startsAt");
  if (body.endsAt != null) current.ends_at = parseTime(body.endsAt, "endsAt");
  if (Date.parse(String(current.ends_at)) <= Date.parse(String(current.starts_at))) {
    throw new HttpError(400, "VALIDATION_ERROR", "must be after startsAt", { field: "endsAt" });
  }
  if (body.timeZone != null) {
    if (typeof body.timeZone !== "string" || !validTz(body.timeZone)) {
      throw new HttpError(400, "VALIDATION_ERROR", "invalid IANA time zone", { field: "timeZone" });
    }
    current.time_zone = body.timeZone;
  }
  if (body.notes != null) current.notes = String(body.notes);
  const now = ctx.now.toISOString();
  const updated = await revisionUpdate(ctx.deps.query, "calendar_events",
    "UPDATE calendar_events SET revision = revision + 1, title = $3, starts_at = $4, ends_at = $5, time_zone = $6, notes = $7, updated_at = $8 WHERE id = $1 AND user_id = $2 AND revision = $9 RETURNING id, revision, application_id, type, title, starts_at, ends_at, time_zone, source, external_id, notes, created_at, updated_at",
    [id, ctx.user.id, current.title, current.starts_at, current.ends_at, current.time_zone, current.notes, now, body.expectedRevision],
    id, ctx.user.id);
  return data(200, eventDto(updated), ctx.rid);
}

export async function deleteEvent(ctx: Ctx, idRaw: string): Promise<Response> {
  const id = requireUuid(idRaw, "id");
  const body = await readObject(ctx.request);
  if (typeof body.expectedRevision !== "number") throw new HttpError(400, "VALIDATION_ERROR", "invalid request body");
  const gone = await one(ctx.deps.query,
    "DELETE FROM calendar_events WHERE id = $1 AND user_id = $2 AND revision = $3 RETURNING id",
    [id, ctx.user.id, body.expectedRevision]);
  if (gone) return new Response(null, { status: 204, headers: { "x-request-id": ctx.rid } });
  const current = await one(ctx.deps.query, "SELECT revision FROM calendar_events WHERE id = $1 AND user_id = $2", [id, ctx.user.id]);
  if (!current) throw new HttpError(404, "NOT_FOUND", "resource not found");
  throw new HttpError(409, "REVISION_CONFLICT", "resource was modified", { currentRevision: Number(current.revision) });
}
