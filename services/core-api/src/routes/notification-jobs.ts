import { one, query } from "../db.ts";
import { HttpError, asBool, data, fieldError, requireUuid, sha256Hex } from "../http.ts";
import { sendNotification } from "../push/notify.ts";
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

// One statement per kind: pick due rows, skip opted-out users, and claim the dedupe key so a rerun sends nothing twice.
const claimed = (due: string): string => `WITH due AS (${due}), claimed AS (
  INSERT INTO notification_dedupes (dedupe_key, created_at) SELECT dedupe_key, $2::timestamptz FROM due ON CONFLICT (dedupe_key) DO NOTHING RETURNING dedupe_key
) SELECT due.user_id, due.id, due.title FROM due JOIN claimed USING (dedupe_key)`;

const DUE_DEADLINES = claimed(`SELECT b.user_id, p.id, p.title, 'deadline:' || b.user_id || ':' || p.id || ':' || $1 AS dedupe_key
    FROM bookmarks b JOIN job_postings p ON p.id = b.posting_id LEFT JOIN user_settings s ON s.user_id = b.user_id
    WHERE p.deadline = $1::date AND p.closed_at IS NULL AND COALESCE(s.notify_deadline, true)`);

const DUE_REMINDERS = claimed(`SELECT e.user_id, e.id, e.title, 'remind:' || e.id AS dedupe_key
    FROM calendar_events e LEFT JOIN user_settings s ON s.user_id = e.user_id
    WHERE e.remind_at IS NOT NULL AND e.remind_at <= $1::timestamptz AND e.remind_at > $3::timestamptz AND COALESCE(s.notify_deadline, true)`);

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
  const id = await sendNotification(ctx, {
    userId, type: "AI_DONE", title, body: "", target: { kind: "conversation", id: conversationId },
  });
  return data(201, { id }, ctx.rid);
};

export const runNotificationJobs = async (ctx: Ctx): Promise<Response> => {
  await requireJob(ctx);
  const nowIso = ctx.now.toISOString();
  const deadlineDay = utcDay(ctx.now, 3);
  const lookback = new Date(ctx.now.getTime() - 2 * DAY_MS).toISOString();
  const [due, reminders] = await Promise.all([
    query(ctx.deps.query, DUE_DEADLINES, [deadlineDay, nowIso]),
    query(ctx.deps.query, DUE_REMINDERS, [nowIso, nowIso, lookback]),
  ]);
  for (const row of due.rows) {
    const title = String(row.title ?? "");
    await sendNotification(ctx, { userId: String(row.user_id), type: "DEADLINE", title, body: title, target: { kind: "posting", id: String(row.id) } });
  }
  for (const row of reminders.rows) {
    await sendNotification(ctx, { userId: String(row.user_id), type: "DEADLINE", title: String(row.title ?? ""), body: "", target: { kind: "calendar", id: String(row.id) } });
  }
  return data(200, { deadlines: due.rows.length, reminders: reminders.rows.length }, ctx.rid);
};

export const dispatchNotificationJobs = async (ctx: Ctx, path: string): Promise<Response | null> => {
  if (ctx.request.method !== "POST") return null;
  if (path === "/api/v1/internal/notifications/ai-done") return recordAiDone(ctx);
  if (path === "/api/v1/internal/notifications/run") return runNotificationJobs(ctx);
  return null;
};
