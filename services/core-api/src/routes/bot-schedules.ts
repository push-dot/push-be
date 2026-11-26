import { boundTransaction, lockOwner } from "../billing/credits.ts";
import { one, query } from "../db.ts";
import type { Row, Transaction } from "../db.ts";
import { userForActAs } from "../internal-auth.ts";
import { HttpError, asBool, data, fieldError, noContent, requireUuid } from "../http.ts";
import type { JsonObject } from "../json.ts";
import { ts } from "../page.ts";
import type { Ctx } from "../types.ts";
import { hasDataRow, sendToBot } from "./bot-chat.ts";
import { resolveBot } from "./bots.ts";
import { forbidExtra, requireAgentConsent } from "./conversations.ts";
import { requireJob } from "./notification-jobs.ts";
import { boolOf, intOf, readObject, textOf } from "./recruiting-shared.ts";

const CADENCES = ["DAILY", "WEEKDAYS", "WEEKLY"] as const;
type Cadence = (typeof CADENCES)[number];

/** When a schedule runs, in Korea time. weekday is 0 Sunday to 6 Saturday, and only WEEKLY has one. */
export type Timing =
  | { cadence: Exclude<Cadence, "WEEKLY">; hour: number; weekday: null }
  | { cadence: "WEEKLY"; hour: number; weekday: number };

const SCHEDULE_LIMIT = 5;
const PROMPT_MAX = 500;
const RUN_BATCH = 50;
const KST_MS = 9 * 60 * 60 * 1000;

const notFound = (): HttpError => new HttpError(404, "NOT_FOUND", "resource not found");

const runsOn = (timing: Timing, weekday: number): boolean => {
  switch (timing.cadence) {
    case "DAILY": return true;
    case "WEEKDAYS": return weekday >= 1 && weekday <= 5;
    case "WEEKLY": return weekday === timing.weekday;
  }
};

/** The first run strictly after `after`. Korea keeps UTC+9 all year, so a fixed offset is exact. */
export const nextRunAt = (timing: Timing, after: Date): Date => {
  const local = new Date(after.getTime() + KST_MS);
  for (let day = 0; day <= 7; day += 1) {
    const at = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + day, timing.hour) - KST_MS;
    if (at > after.getTime() && runsOn(timing, new Date(at + KST_MS).getUTCDay())) {return new Date(at);}
  }
  throw new Error("no run within a week");
};

const isAbsent = (value: unknown): boolean => value === null || value === undefined;

const timingOf = (cadenceRaw: unknown, hourRaw: unknown, weekdayRaw: unknown): Timing => {
  const cadence = CADENCES.find((name) => name === cadenceRaw);
  if (!cadence) {throw fieldError("cadence", `must be one of ${CADENCES.join(", ")}`);}
  const hour = intOf(hourRaw, "hour", 0, 23);
  if (cadence === "WEEKLY") {
    if (isAbsent(weekdayRaw)) {throw fieldError("weekday", "a WEEKLY schedule needs a weekday");}
    return { cadence, hour, weekday: intOf(weekdayRaw, "weekday", 0, 6) };
  }
  if (!isAbsent(weekdayRaw)) {throw fieldError("weekday", "only a WEEKLY schedule takes a weekday");}
  return { cadence, hour, weekday: null };
};

const timingOfRow = (row: Row): Timing =>
  timingOf(row.cadence, Number(row.hour), isAbsent(row.weekday) ? null : Number(row.weekday));

const sameTiming = (a: Timing, b: Timing): boolean => a.cadence === b.cadence && a.hour === b.hour && a.weekday === b.weekday;

const COLS = "id, bot_id, prompt, cadence, hour, weekday, enabled, next_run_at, last_run_at, last_error";

const scheduleDto = (row: Row): JsonObject => ({
  id: String(row.id),
  botId: String(row.bot_id),
  prompt: String(row.prompt),
  cadence: String(row.cadence),
  hour: Number(row.hour),
  weekday: isAbsent(row.weekday) ? null : Number(row.weekday),
  enabled: asBool(row.enabled),
  nextRunAt: ts(row.next_run_at),
  lastRunAt: ts(row.last_run_at),
  lastError: isAbsent(row.last_error) ? null : String(row.last_error),
});

const LIST = `SELECT ${COLS} FROM bot_schedules WHERE user_id = $1 AND bot_id = $2 ORDER BY created_at, id`;
const COUNT = "SELECT count(*)::int AS n FROM bot_schedules WHERE user_id = $1";
const INSERT = `INSERT INTO bot_schedules (id, user_id, bot_id, prompt, cadence, hour, weekday, next_run_at, created_at, updated_at)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9) RETURNING ${COLS}`;
const CURRENT = `SELECT ${COLS} FROM bot_schedules WHERE id = $1 AND user_id = $2 AND bot_id = $3`;
const UPDATE = `UPDATE bot_schedules SET prompt = $4, cadence = $5, hour = $6, weekday = $7, enabled = $8, next_run_at = $9, updated_at = $10
  WHERE id = $1 AND user_id = $2 AND bot_id = $3 RETURNING ${COLS}`;
const DELETE = "DELETE FROM bot_schedules WHERE id = $1 AND user_id = $2 AND bot_id = $3";

const listSchedules = async (ctx: Ctx, idRaw: string): Promise<Response> => {
  const bot = await resolveBot(ctx, idRaw);
  const rows = await query(ctx.deps.query, LIST, [ctx.user.id, bot.id]);
  return data(200, rows.rows.map(scheduleDto), ctx.rid);
};

const createSchedule = async (ctx: Ctx, idRaw: string): Promise<Response> => {
  const bot = await resolveBot(ctx, idRaw);
  const body = await readObject(ctx.request);
  forbidExtra(body, ["prompt", "cadence", "hour", "weekday"]);
  const prompt = textOf(body.prompt, "prompt", 1, PROMPT_MAX);
  if (!prompt.trim()) {throw fieldError("prompt", "must not be blank");}
  const timing = timingOf(body.cadence, body.hour, body.weekday);
  await requireAgentConsent(ctx);
  const transaction: Transaction = ctx.deps.transaction ?? ((work) => work(ctx.deps.query));
  const row = await transaction(async (q) => {
    await boundTransaction(q, "3s");
    await lockOwner(q, "PERSONAL", ctx.user.id);
    const count = await one(q, COUNT, [ctx.user.id]);
    if (Number(count?.n ?? 0) >= SCHEDULE_LIMIT) {
      throw new HttpError(403, "SCHEDULE_LIMIT", "schedule limit reached", { limit: SCHEDULE_LIMIT });
    }
    return one(q, INSERT, [crypto.randomUUID(), ctx.user.id, bot.id, prompt, timing.cadence, timing.hour, timing.weekday,
      nextRunAt(timing, ctx.now).toISOString(), ctx.now.toISOString()]);
  });
  if (!row) {throw notFound();}
  return data(201, scheduleDto(row), ctx.rid);
};

const patchSchedule = async (ctx: Ctx, idRaw: string, scheduleRaw: string): Promise<Response> => {
  const bot = await resolveBot(ctx, idRaw);
  const body = await readObject(ctx.request);
  forbidExtra(body, ["prompt", "cadence", "hour", "weekday", "enabled"]);
  const keys = [requireUuid(scheduleRaw, "scheduleId"), ctx.user.id, bot.id];
  const current = await one(ctx.deps.query, CURRENT, keys);
  if (!current) {throw notFound();}
  const prompt = isAbsent(body.prompt) ? String(current.prompt) : textOf(body.prompt, "prompt", 1, PROMPT_MAX);
  if (!prompt.trim()) {throw fieldError("prompt", "must not be blank");}
  const cadence = body.cadence ?? current.cadence;
  const weekday = "weekday" in body ? body.weekday : (cadence === "WEEKLY" ? current.weekday : null);
  const timing = timingOf(cadence, body.hour ?? Number(current.hour), isAbsent(weekday) ? null : Number(weekday));
  const wasEnabled = asBool(current.enabled);
  const enabled = isAbsent(body.enabled) ? wasEnabled : boolOf(body.enabled, "enabled");
  const moved = !sameTiming(timing, timingOfRow(current)) || (enabled && !wasEnabled);
  const next = moved ? nextRunAt(timing, ctx.now).toISOString() : current.next_run_at;
  const row = await one(ctx.deps.query, UPDATE,
    [...keys, prompt, timing.cadence, timing.hour, timing.weekday, enabled, next, ctx.now.toISOString()]);
  if (!row) {throw notFound();}
  return data(200, scheduleDto(row), ctx.rid);
};

const deleteSchedule = async (ctx: Ctx, idRaw: string, scheduleRaw: string): Promise<Response> => {
  const bot = await resolveBot(ctx, idRaw);
  const gone = await query(ctx.deps.query, DELETE, [requireUuid(scheduleRaw, "scheduleId"), ctx.user.id, bot.id]);
  if (gone.rowCount === 0) {throw notFound();}
  return noContent(ctx.rid);
};

const DUE = `SELECT s.id, s.user_id, s.bot_id, s.prompt, s.cadence, s.hour, s.weekday, s.next_run_at, u.plan
  FROM bot_schedules s
  JOIN bots b ON b.id = s.bot_id AND b.user_id = s.user_id AND b.deleted_at IS NULL
  JOIN users u ON u.id = s.user_id AND u.deletion_requested_at IS NULL
  WHERE s.enabled AND s.next_run_at <= $1
  ORDER BY s.next_run_at LIMIT ${RUN_BATCH}`;
// Only the run that still sees the slot it read moves it on, so overlapping crons send a slot once.
const CLAIM = `UPDATE bot_schedules SET next_run_at = $3, last_run_at = $4, updated_at = $4
  WHERE id = $1 AND next_run_at = $2::timestamptz AND enabled RETURNING id`;
const BUSY = "SELECT 1 AS busy FROM bot_state_v s WHERE s.user_id = $1 AND s.bot_id = $2 AND (s.card_id IS NOT NULL OR s.job_id IS NOT NULL)";
const LIVE_OWNER = "SELECT 1 AS live FROM users WHERE id = $1 AND deletion_requested_at IS NULL";
const RAN = "UPDATE bot_schedules SET last_job_id = $2, last_error = NULL WHERE id = $1";
const FAILED = "UPDATE bot_schedules SET last_error = $2 WHERE id = $1";

const runOne = async (ctx: Ctx, row: Row): Promise<string | null> => {
  const claimed = await one(ctx.deps.query, CLAIM,
    [row.id, row.next_run_at, nextRunAt(timingOfRow(row), ctx.now).toISOString(), ctx.now.toISOString()]);
  if (!claimed) {return null;}
  const owner: Ctx = {
    ...ctx,
    user: await userForActAs(ctx.deps.query, { userId: String(row.user_id), companyId: null }),
    request: new Request(ctx.request.url, { method: "POST", headers: { "idempotency-key": `schedule:${row.id}:${ts(row.next_run_at)}` } }),
  };
  await requireAgentConsent(owner);
  // A new message would close the card the user has not answered yet, so a busy bot skips this slot.
  if (await one(ctx.deps.query, BUSY, [owner.user.id, row.bot_id])) {throw new HttpError(409, "BOT_BUSY", "the bot is running or waiting on a card");}
  // The batch can take a while, and a user who asked to delete the account in the meantime gets no more runs.
  if (!(await one(ctx.deps.query, LIVE_OWNER, [owner.user.id]))) {throw new HttpError(403, "ACCOUNT_DELETING", "the account is being deleted");}
  const sent: unknown = await (await sendToBot(owner, String(row.bot_id), {
    text: String(row.prompt), materials: [], intent: null, ai: null, accessMode: "ALWAYS_ASK",
  })).json();
  return hasDataRow(sent) ? String(sent.data.id) : null;
};

export const runBotSchedules = async (ctx: Ctx): Promise<Response> => {
  await requireJob(ctx);
  const due = await query(ctx.deps.query, DUE, [ctx.now.toISOString()]);
  const tally = { ran: 0, failed: 0 };
  for (const row of due.rows) {
    try {
      const jobId = await runOne(ctx, row);
      if (jobId === null) {continue;}
      await query(ctx.deps.query, RAN, [row.id, jobId]);
      tally.ran += 1;
    } catch (error) {
      const code = error instanceof HttpError ? error.code : "INTERNAL";
      console.error(JSON.stringify({ botScheduleError: String(row.id), code }));
      await query(ctx.deps.query, FAILED, [row.id, code]).catch(() => undefined);
      tally.failed += 1;
    }
  }
  return data(200, tally, ctx.rid);
};

export const dispatchBotSchedules = async (ctx: Ctx, path: string): Promise<Response | null> => {
  const method = ctx.request.method;
  const list = path.match(/^\/api\/v1\/bots\/([^/]+)\/schedules$/);
  if (method === "GET" && list) {return listSchedules(ctx, list[1]);}
  if (method === "POST" && list) {return createSchedule(ctx, list[1]);}
  const item = path.match(/^\/api\/v1\/bots\/([^/]+)\/schedules\/([^/]+)$/);
  if (method === "PATCH" && item) {return patchSchedule(ctx, item[1], item[2]);}
  if (method === "DELETE" && item) {return deleteSchedule(ctx, item[1], item[2]);}
  return null;
};
