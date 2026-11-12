import { one, query } from "../db.ts";
import { HttpError, asBool, data, fieldError, requireUuid, sha256Hex } from "../http.ts";
import { sendNotification } from "../push/notify.ts";
import type { Ctx } from "../types.ts";
import { readObject } from "./recruiting-shared.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

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

const THREAD = `SELECT c.bot_id, b.notifications_muted, COALESCE(b.display_name, s.display_name) AS display_name,
    s.last_message_preview, s.unread, COALESCE(us.notify_ai_done, true) AS allowed
  FROM conversations c
  LEFT JOIN bots b ON b.id = c.bot_id AND b.deleted_at IS NULL
  LEFT JOIN bot_state_v s ON s.bot_id = b.id
  LEFT JOIN user_settings us ON us.user_id = c.user_id
  WHERE c.id = $1 AND c.user_id = $2`;

const CLAIM = `INSERT INTO notification_dedupes (dedupe_key, created_at) VALUES ($1, $2::timestamptz)
  ON CONFLICT (dedupe_key) DO NOTHING RETURNING dedupe_key`;

const pushSentence = (name: unknown): string => {
  const text = String(name ?? "").trim();
  if (!text) return "봇이 작업을 마쳤어요";
  if (text.endsWith("봇") || text.endsWith("Bot")) return `${text}이 작업을 마쳤어요`;
  return `${text} 봇이 작업을 마쳤어요`;
};

const alreadyRead = (value: unknown): boolean => value === false || value === "f" || value === "false";

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
  const jobId = requireUuid(String(body.jobId ?? ""), "jobId");
  const row = await one(ctx.deps.query, THREAD, [conversationId, userId]);
  if (!row || !asBool(row.allowed) || asBool(row.notifications_muted) || alreadyRead(row.unread)) {
    return data(201, { id: null }, ctx.rid);
  }
  const claim = await one(ctx.deps.query, CLAIM, [`ai-done:${jobId}`, ctx.now.toISOString()]);
  if (!claim) return data(201, { id: null }, ctx.rid);
  const botId = row.bot_id == null || row.bot_id === "" ? "" : String(row.bot_id);
  const title = botId ? "봇 작업 완료" : (body.title == null || body.title === "" ? "AI 작업이 끝났어요" : String(body.title));
  if (title.length > 200) throw fieldError("title", "must be at most 200 characters");
  const id = await sendNotification(ctx, {
    userId,
    type: "AI_DONE",
    title,
    body: botId ? String(row.last_message_preview ?? "") : "",
    target: botId ? { kind: "bot", id: botId } : { kind: "conversation", id: conversationId },
    conversationId,
    ...(botId ? { pushBody: pushSentence(row.display_name) } : {}),
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
