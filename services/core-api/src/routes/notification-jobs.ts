import { one, query } from "../db.ts";
import type { Row } from "../db.ts";
import { HttpError, asBool, data, fieldError, requireUuid, sha256Hex } from "../http.ts";
import { sendNotification } from "../push/notify.ts";
import type { Notice } from "../push/notify.ts";
import type { Ctx } from "../types.ts";
import { plainLine } from "./bots.ts";
import { readObject } from "./recruiting-shared.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

const sameSecret = async (left: string, right: string): Promise<boolean> => {
  const a = await sha256Hex(left);
  const b = await sha256Hex(right);
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {diff |= a.charCodeAt(i) ^ b.charCodeAt(i);}
  return diff === 0;
};

export const requireJob = async (ctx: Ctx): Promise<void> => {
  const expected = ctx.env.INTERNAL_JOB_TOKEN?.trim() ?? "";
  if (!expected) {throw new HttpError(503, "NOT_CONFIGURED", "internal job token is not configured");}
  const header = ctx.request.headers.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!(await sameSecret(token, expected))) {throw new HttpError(401, "UNAUTHENTICATED", "missing bearer token");}
};

// $2 is the member whose job ran: in a company conversation that may be any member, and the
// notice and its opt-out are theirs.
const THREAD = `SELECT c.bot_id, c.company_id, b.notifications_muted, COALESCE(b.display_name, s.display_name) AS display_name,
    s.last_message_preview, s.card_title, s.unread, COALESCE(us.notify_ai_done, true) AS allowed
  FROM conversations c
  LEFT JOIN bots b ON b.id = c.bot_id AND b.deleted_at IS NULL
  LEFT JOIN bot_state_v s ON s.bot_id = b.id
  LEFT JOIN user_settings us ON us.user_id = $2
  WHERE c.id = $1 AND (c.user_id = $2 OR (c.company_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM company_members m WHERE m.company_id = c.company_id AND m.user_id = $2)))`;

const CLAIM = `INSERT INTO notification_dedupes (dedupe_key, created_at) VALUES ($1, $2::timestamptz)
  ON CONFLICT (dedupe_key) DO NOTHING RETURNING dedupe_key`;

type Outcome = "done" | "waiting" | "failed";

const OUTCOMES: Record<Outcome, { title: string; tail: string }> = {
  done: { title: "Bot 작업 완료", tail: "작업을 마쳤어요" },
  waiting: { title: "확인이 필요해요", tail: "확인을 기다려요" },
  failed: { title: "작업을 마치지 못했어요", tail: "작업을 마치지 못했어요" },
};

const AGENT_TITLES: Record<Exclude<Outcome, "done">, string> = {
  waiting: "에이전트가 확인을 기다려요",
  failed: "에이전트가 작업을 마치지 못했어요",
};

const outcomeOf = (value: unknown): Outcome => {
  if (value === undefined || value === null || value === "done") {return "done";}
  if (value === "waiting" || value === "failed") {return value;}
  throw fieldError("outcome", "must be done, waiting or failed");
};

const pushSentence = (name: unknown, tail: string): string => {
  const text = String(name ?? "").trim();
  if (!text) {return `Bot이 ${tail}`;}
  if (text.endsWith("봇") || text.endsWith("Bot")) {return `${text}이 ${tail}`;}
  return `${text} Bot이 ${tail}`;
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

// A company bot watches its posting and its company: a close after the bot was made, and an open posting of the
// same company made after the bot (a draft counts once it is published). The dedupe key per user and posting is
// the only state: rows already claimed or for opted-out users are dropped before the batch limit, so a later run
// picks up where this one stopped, and one user with several bots on a company hears once.
const DUE_WATCH = `WITH changes AS (
    SELECT b.user_id, b.display_name, p.id, p.title, 'closed' AS change, p.closed_at AS at,
      'watch:closed:' || b.user_id || ':' || p.id AS dedupe_key
    FROM bots b JOIN job_postings p ON p.id = b.posting_id
    WHERE b.kind = 'company' AND b.deleted_at IS NULL AND NOT b.notifications_muted
      AND p.closed_at > GREATEST(b.created_at, $2::timestamptz)
    UNION ALL
    SELECT b.user_id, b.display_name, p.id, p.title, 'new', p.created_at, 'watch:new:' || b.user_id || ':' || p.id
    FROM bots b JOIN job_postings src ON src.id = b.posting_id
    JOIN job_postings p ON p.company_id = COALESCE(b.company_id, src.company_id) AND p.id <> src.id
    WHERE b.kind = 'company' AND b.deleted_at IS NULL AND NOT b.notifications_muted
      AND COALESCE(p.status, 'OPEN') = 'OPEN' AND p.closed_at IS NULL AND p.created_at > GREATEST(b.created_at, $3::timestamptz)
  ), due AS (
    SELECT DISTINCT ON (c.dedupe_key) c.* FROM changes c
    JOIN users u ON u.id = c.user_id AND u.deletion_requested_at IS NULL
    LEFT JOIN user_settings s ON s.user_id = c.user_id
    WHERE COALESCE(s.notify_ai_done, true)
      AND NOT EXISTS (SELECT 1 FROM notification_dedupes d WHERE d.dedupe_key = c.dedupe_key)
    ORDER BY c.dedupe_key, c.at
  ), batch AS (
    SELECT * FROM due ORDER BY at, dedupe_key LIMIT 500
  ), claimed AS (
    INSERT INTO notification_dedupes (dedupe_key, created_at) SELECT dedupe_key, $1::timestamptz FROM batch ON CONFLICT (dedupe_key) DO NOTHING RETURNING dedupe_key
  ) SELECT batch.user_id, batch.display_name, batch.id, batch.title, batch.change FROM batch JOIN claimed USING (dedupe_key)`;

export const watchNotice = (row: Row): Notice => {
  const title = String(row.title ?? "");
  const name = String(row.display_name ?? "").trim();
  const closed = row.change === "closed";
  return {
    userId: String(row.user_id),
    type: "AI_DONE",
    title: closed ? "공고가 마감됐어요" : "새 공고가 올라왔어요",
    body: title,
    pushBody: closed ? `${title} 공고가 마감됐어요` : `${name}에 새 공고가 올라왔어요: ${title}`,
    target: { kind: "posting", id: String(row.id) },
  };
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
  const jobId = requireUuid(String(body.jobId ?? ""), "jobId");
  const outcome = outcomeOf(body.outcome);
  const row = await one(ctx.deps.query, THREAD, [conversationId, userId]);
  // A failure adds no message, so the read marker cannot tell whether the user saw it.
  const seen = outcome !== "failed" && alreadyRead(row?.unread);
  if (!row || !asBool(row.allowed) || asBool(row.notifications_muted) || seen) {
    return data(201, { id: null }, ctx.rid);
  }
  const botId = (row.bot_id === null || row.bot_id === undefined) || row.bot_id === "" ? "" : String(row.bot_id);
  const company = row.company_id !== null && row.company_id !== undefined;
  if (!botId && !company && outcome !== "done") {return data(201, { id: null }, ctx.rid);}
  const key = outcome === "done" ? `ai-done:${jobId}` : `ai-${outcome}:${jobId}`;
  const claim = await one(ctx.deps.query, CLAIM, [key, ctx.now.toISOString()]);
  if (!claim) {return data(201, { id: null }, ctx.rid);}
  const title = botId ? OUTCOMES[outcome].title
    : outcome !== "done" ? AGENT_TITLES[outcome]
    : ((body.title === null || body.title === undefined) || body.title === "" ? "AI 작업이 끝났어요" : String(body.title));
  if (title.length > 200) {throw fieldError("title", "must be at most 200 characters");}
  const notice: Notice = {
    userId,
    type: "AI_DONE",
    title,
    body: !botId || outcome === "failed" ? "" : plainLine(String((outcome === "waiting" ? row.card_title : row.last_message_preview) ?? "")),
    target: botId ? { kind: "bot", id: botId } : { kind: "conversation", id: conversationId },
    conversationId,
  };
  if (botId) {notice.pushBody = pushSentence(row.display_name, OUTCOMES[outcome].tail);}
  const id = await sendNotification(ctx, notice);
  return data(201, { id }, ctx.rid);
};

export const runNotificationJobs = async (ctx: Ctx): Promise<Response> => {
  await requireJob(ctx);
  const nowIso = ctx.now.toISOString();
  const deadlineDay = utcDay(ctx.now, 3);
  const lookback = new Date(ctx.now.getTime() - 2 * DAY_MS).toISOString();
  const [due, reminders, watched] = await Promise.all([
    query(ctx.deps.query, DUE_DEADLINES, [deadlineDay, nowIso]),
    query(ctx.deps.query, DUE_REMINDERS, [nowIso, nowIso, lookback]),
    query(ctx.deps.query, DUE_WATCH, [nowIso, lookback, new Date(ctx.now.getTime() - 30 * DAY_MS).toISOString()]),
  ]);
  for (const row of due.rows) {
    const title = String(row.title ?? "");
    await sendNotification(ctx, { userId: String(row.user_id), type: "DEADLINE", title, body: title, target: { kind: "posting", id: String(row.id) } });
  }
  for (const row of reminders.rows) {
    await sendNotification(ctx, { userId: String(row.user_id), type: "DEADLINE", title: String(row.title ?? ""), body: "", target: { kind: "calendar", id: String(row.id) } });
  }
  for (const row of watched.rows) {
    await sendNotification(ctx, watchNotice(row));
  }
  return data(200, { deadlines: due.rows.length, reminders: reminders.rows.length, watched: watched.rows.length }, ctx.rid);
};

export const dispatchNotificationJobs = async (ctx: Ctx, path: string): Promise<Response | null> => {
  if (ctx.request.method !== "POST") {return null;}
  if (path === "/api/v1/internal/notifications/ai-done") {return recordAiDone(ctx);}
  if (path === "/api/v1/internal/notifications/run") {return runNotificationJobs(ctx);}
  return null;
};
