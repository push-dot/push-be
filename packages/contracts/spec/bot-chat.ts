import type { Route, Schema } from "./shared.ts";
import {
  get, post, ref, obj, closed, arr, str, int, bool, uuid, dateTime, enumOf,
  body, ok, sse, pathParam, query,
} from "./shared.ts";
import { PERSONAL_INTENTS, aiOptions, chatEvents, messageText, stamped, statusPhases } from "./conversations.ts";

const id = pathParam("id", { type: "string", description: "A bot id, or the literal push for the caller's Push Bot." });

const attachmentRef = closed({ kind: enumOf("file", "document", "posting", "link"), id: uuid });

const sendBody = closed({
  text: messageText,
  attachments: { ...arr(attachmentRef), maxItems: 10, description: "Each is a material of the caller, or any posting that is not a draft. The message stores each with its title at send time." },
  intent: enumOf(...PERSONAL_INTENTS),
  accessMode: { ...enumOf("ALWAYS_ASK", "AUTO", "BYPASS"), description: "Defaults to the saved user setting" },
  ai: aiOptions,
}, ["text"]);

// A bot thread is personal, so the employer cards never run in it.
const { employer_research: _research, posting_draft: _draft, review_report: _report, interview_kit: _kit, ...personalEvents } = chatEvents;

const required = (event: Schema, field: string): Schema => ({ ...event, required: [...(event.required as string[]), field] });

const botEvents: Record<string, Schema> = Object.fromEntries(Object.entries({
  ...personalEvents,
  status: { oneOf: statusPhases },
  cancelled: required(chatEvents.cancelled, "resumable"),
}).map(([name, event]) => [name, stamped(event)]));

const botStreamDescription = "The frames of the conversation stream (POST /conversations/{id}/messages/stream), addressed by bot. "
  + "No frame holds the id of the conversation that stores the thread. turn equals the id of the turn in GET /bots/{id}/transcript. "
  + "Every status has a phase: a stored status row without one, from before phases or from a run of the AI service that does not write them yet, is not sent here. The conversation stream sends that row with text only. "
  + "The newest status is the run's phase. done, error, and cancelled end every phase but waiting, which ends when its card is answered or expires. "
  + "The stream closes after done, error, or cancelled, and every run ends with one of them. If the connection drops first, follow GET /bots/{id}/stream with ?after=<last seq>.";

export const schemas: Record<string, Schema> = {
  BotSendBody: sendBody,
  StreamEvent: { oneOf: Object.values(botEvents), description: "A frame of a bot stream" },
  TranscriptMatch: obj({
    messageId: uuid,
    turnId: { type: "string", description: "The turn that holds the message. Page GET /bots/{id}/transcript until it is loaded." },
    at: dateTime,
  }),
  BotCardAnswer: obj({
    id: uuid,
    status: enumOf("APPROVED", "REJECTED"),
    optionId: str,
    optionIds: arr(str),
  }, ["id", "status", "optionId"]),
};

export const routes: Route[] = [
  post("gateway", "/api/v1/bots/{id}/messages/stream", {
    tag: "bots",
    summary: "Send a message to a bot and stream the reply",
    description: "Creates the bot's thread on the first send; two sends at once share one thread. 403 CONSENT_REQUIRED without reference-data consent, before a thread exists. 409 ATTACHMENT_GONE with details.kind and details.id when an attached material is gone, archived, or not the caller's. 400 for more than 10 attachments or an unknown body key. 402 INSUFFICIENT_CREDITS and 429 QUEUE_BUSY as on a conversation send. 404 for an unknown bot, and for a bot deleted while the send was under way: no row of that send stays. A result that is not 202 from core is returned as is. " + botStreamDescription,
    params: [id],
    body: body(ref("BotSendBody")),
    responses: { 200: sse(botEvents, "Bot reply stream") },
  }),
  get("gateway", "/api/v1/bots/{id}/stream", {
    tag: "bots",
    summary: "Follow the bot's active run",
    description: "Streams the events of the bot's queued or running job after the given seq. 204 when nothing runs, also for a bot with no thread: the run is over and the newest transcript page holds its terminal event. " + botStreamDescription,
    params: [
      id,
      query("after", { type: "integer", minimum: 0 }, "Resume after this seq; the Last-Event-ID header is used when absent"),
      { name: "Last-Event-ID", in: "header", required: false, schema: str },
    ],
    responses: { 200: sse(botEvents, "Bot reply stream"), 204: { description: "Nothing runs" } },
  }),
  post("gateway", "/api/v1/bots/{id}/stream/cancel", {
    tag: "bots",
    summary: "Stop the bot's active run",
    description: "409 CONFLICT when nothing runs. The open stream receives a cancelled event with the same resumable, written with the cancel itself.",
    params: [id],
    responses: { 200: ok(obj({ status: enumOf("CANCELLED"), resumable: bool })) },
  }),
  post("core", "/api/v1/bots/{id}/approvals/{approvalId}", {
    tag: "bots",
    summary: "Answer a card of the bot's thread",
    description: "The answer rules of POST /conversations/{id}/approvals/{approvalId}. 202 when the answer resumes the run; follow GET /bots/{id}/stream. 403 CONSENT_REQUIRED without reference-data consent, because an answer starts a run. 404 for a bot with no thread or a card of another thread. 409 APPROVAL_ALREADY_RESOLVED, 410 APPROVAL_EXPIRED, 402 INSUFFICIENT_CREDITS.",
    params: [id, pathParam("approvalId")],
    body: body(closed({
      optionId: { type: "string", minLength: 1 },
      optionIds: arr({ type: "string", minLength: 1 }),
    }, [])),
    responses: {
      200: ok(ref("BotCardAnswer")),
      202: ok(ref("BotCardAnswer"), "Accepted; the run resumed"),
    },
  }),
  get("core", "/api/v1/bots/{id}/transcript/matches", {
    tag: "bots",
    summary: "Find text in a bot's chat",
    description: "Messages of the thread that contain q, case-insensitive, newest first. total counts every match; items holds at most 200. A bot with no thread has none.",
    params: [id, query("q", { type: "string", minLength: 1, maxLength: 200 }, "Required. 1 to 200 characters.")],
    responses: { 200: ok(obj({ total: int, items: arr(ref("TranscriptMatch")) })) },
  }),
];
