import { one, query } from "../db.ts";
import { HttpError, asBool, data, fieldError, requireUuid, sha256Hex } from "../http.ts";
import { deliverPush } from "../push/notifier.ts";
import type { Ctx } from "../types.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

const readObject = async (request: Request): Promise<Record<string, unknown>> => {
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
};

const sameSecret = async (left: string, right: string): Promise<boolean> => {
  const a = await sha256Hex(left);
  const b = await sha256Hex(right);
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

const requireJob = async (ctx: Ctx): Promise<void> => {
  const expected = ctx.env.INTERNAL_JOB_TOKEN?.trim() ?? "";
  if (!expected) throw new HttpError(503, "NOT_CONFIGURED", "internal job token is not configured");
  const header = ctx.request.headers.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!(await sameSecret(token, expected))) throw new HttpError(401, "UNAUTHENTICATED", "missing bearer token");
};

const allowed = async (ctx: Ctx, userId: string, column: string): Promise<boolean> => {
  const pref = await one(ctx.deps.query, `SELECT ${column} AS enabled FROM user_settings WHERE user_id = $1`, [userId]);
  return !pref || asBool(pref.enabled);
};

const claim = async (ctx: Ctx, key: string): Promise<boolean> => {
  const row = await one(ctx.deps.query,
    "INSERT INTO notification_dedupes (dedupe_key, created_at) VALUES ($1,$2) ON CONFLICT (dedupe_key) DO NOTHING RETURNING dedupe_key",
    [key, ctx.now.toISOString()]);
  return Boolean(row);
};

const insertNote = async (
  ctx: Ctx,
  userId: string,
  type: string,
  title: string,
  body: string,
  target: Record<string, unknown>,
): Promise<void> => {
  await query(ctx.deps.query,
    "INSERT INTO notifications (id, user_id, type, title, body, target, read_at, created_at) VALUES ($1,$2,$3,$4,$5,$6::jsonb,NULL,$7)",
    [crypto.randomUUID(), userId, type, title, body, JSON.stringify(target), ctx.now.toISOString()]);
  await deliverPush(ctx, userId, title, body, target);
};

const utcDay = (moment: Date, shiftDays: number): string => {
  const day = new Date(Date.UTC(moment.getUTCFullYear(), moment.getUTCMonth(), moment.getUTCDate() + shiftDays));
  return day.toISOString().slice(0, 10);
};

export const recordAiDone = async (ctx: Ctx): Promise<Response> => {
  await requireJob(ctx);
  const body = await readObject(ctx.request);
  const userId = requireUuid(String(body.userId ?? ""), "userId");
  const conversationId = requireUuid(String(body.conversationId ?? ""), "conversationId");
  const title = body.title == null || body.title === "" ? "AI 작업이 끝났어요" : String(body.title);
  if (title.length > 200) throw fieldError("title", "must be at most 200 characters");
  if (!(await allowed(ctx, userId, "notify_ai_done"))) return data(201, { id: null }, ctx.rid);
  const id = crypto.randomUUID();
  const target = { kind: "conversation", id: conversationId };
  await query(ctx.deps.query,
    "INSERT INTO notifications (id, user_id, type, title, body, target, read_at, created_at) VALUES ($1,$2,$3,$4,'',$5::jsonb,NULL,$6)",
    [id, userId, "AI_DONE", title, JSON.stringify(target), ctx.now.toISOString()]);
  await deliverPush(ctx, userId, title, "", target);
  return data(201, { id }, ctx.rid);
};

export const runNotificationJobs = async (ctx: Ctx): Promise<Response> => {
  await requireJob(ctx);
  const deadlineDay = utcDay(ctx.now, 3);
  const due = await query(ctx.deps.query,
    `SELECT b.user_id, p.id, p.title
     FROM bookmarks b JOIN job_postings p ON p.id = b.posting_id
     WHERE p.deadline = $1::date AND p.closed_at IS NULL`,
    [deadlineDay]);
  let deadlines = 0;
  for (const row of due.rows) {
    const userId = String(row.user_id);
    const postingId = String(row.id);
    if (!(await claim(ctx, `deadline:${userId}:${postingId}:${deadlineDay}`))) continue;
    if (!(await allowed(ctx, userId, "notify_deadline"))) continue;
    const title = String(row.title ?? "");
    await insertNote(ctx, userId, "DEADLINE", title, title, { kind: "posting", id: postingId });
    deadlines += 1;
  }
  const lookback = new Date(ctx.now.getTime() - 2 * DAY_MS).toISOString();
  const reminders = await query(ctx.deps.query,
    `SELECT id, user_id, title FROM calendar_events
     WHERE remind_at IS NOT NULL AND remind_at <= $1 AND remind_at > $2`,
    [ctx.now.toISOString(), lookback]);
  let reminded = 0;
  for (const row of reminders.rows) {
    const userId = String(row.user_id);
    const eventId = String(row.id);
    if (!(await claim(ctx, `remind:${eventId}`))) continue;
    if (!(await allowed(ctx, userId, "notify_deadline"))) continue;
    const title = String(row.title ?? "");
    await insertNote(ctx, userId, "DEADLINE", title, "", { kind: "calendar", id: eventId });
    reminded += 1;
  }
  return data(200, { deadlines, reminders: reminded }, ctx.rid);
};

export const dispatchNotificationJobs = async (ctx: Ctx, path: string): Promise<Response | null> => {
  if (ctx.request.method !== "POST") return null;
  if (path === "/api/v1/internal/notifications/ai-done") return recordAiDone(ctx);
  if (path === "/api/v1/internal/notifications/run") return runNotificationJobs(ctx);
  return null;
};
