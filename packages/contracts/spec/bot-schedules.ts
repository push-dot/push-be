import type { Route } from "./shared.ts";
import { get, post, patch, del, ref, obj, closed, arr, str, int, bool, uuid, dateTime, enumOf, nullable, body, ok, noContent, pathParam } from "./shared.ts";

const id = pathParam("id", { type: "string", description: "A bot id, or the literal push for the caller's Push Bot." });
const scheduleId = pathParam("scheduleId");

const cadence = {
  ...enumOf("DAILY", "WEEKDAYS", "WEEKLY"),
  description: "DAILY runs every day, WEEKDAYS Monday to Friday, WEEKLY on weekday only.",
};
const hour = { ...int, minimum: 0, maximum: 23, description: "The hour it runs, in Korea time (UTC+9)." };
const weekday = { ...int, minimum: 0, maximum: 6, description: "0 Sunday to 6 Saturday, Korea time. Set exactly when cadence is WEEKLY." };
const prompt = { ...str, minLength: 1, maxLength: 500, description: "What the bot is asked on each run, as if the user sent it." };

export const schemas = {
  BotSchedule: obj({
    id: uuid,
    botId: uuid,
    prompt: str,
    cadence,
    hour: int,
    weekday: nullable(int),
    enabled: bool,
    nextRunAt: { ...dateTime, description: "The next run. The hourly job sends a due run at about a quarter past its hour." },
    lastRunAt: nullable(dateTime),
    lastError: {
      ...nullable(str),
      description: "The error code of the last run that could not be sent, such as QUEUE_BUSY, CONSENT_REQUIRED or BOT_BUSY "
        + "(the bot was running or had an open card). null after a run that was sent.",
    },
  }),
  CreateBotScheduleBody: closed({ prompt, cadence, hour, weekday }, ["prompt", "cadence", "hour"]),
  UpdateBotScheduleBody: closed({ prompt, cadence, hour, weekday: nullable(weekday), enabled: bool }, []),
};

export const routes: Array<Route> = [
  get("core", "/api/v1/bots/{id}/schedules", {
    tag: "bots",
    summary: "List a bot's schedules",
    description: "Oldest first.",
    params: [id],
    responses: { 200: ok(arr(ref("BotSchedule"))) },
  }),
  post("core", "/api/v1/bots/{id}/schedules", {
    tag: "bots",
    summary: "Save a prompt the bot runs on its own",
    description: "Each run sends prompt to the bot's thread as the user would, with accessMode ALWAYS_ASK, so every write becomes a card. "
      + "A run is skipped when the bot is running or has an open card. 400 when weekday is missing for WEEKLY or set for another cadence. "
      + "403 CONSENT_REQUIRED without reference-data consent or with allowAiReadMyFiles off. 403 SCHEDULE_LIMIT when the user already has 5 schedules across all bots.",
    params: [id],
    body: body(ref("CreateBotScheduleBody")),
    responses: { 201: ok(ref("BotSchedule"), "Created") },
  }),
  patch("core", "/api/v1/bots/{id}/schedules/{scheduleId}", {
    tag: "bots",
    summary: "Change or pause a schedule",
    description: "Omitted keys keep their value. A schedule that leaves WEEKLY drops its weekday. nextRunAt moves when the timing changes or the schedule is enabled again.",
    params: [id, scheduleId],
    body: body(ref("UpdateBotScheduleBody")),
    responses: { 200: ok(ref("BotSchedule")) },
  }),
  del("core", "/api/v1/bots/{id}/schedules/{scheduleId}", {
    tag: "bots",
    summary: "Delete a schedule",
    params: [id, scheduleId],
    responses: { 204: noContent },
  }),
];
