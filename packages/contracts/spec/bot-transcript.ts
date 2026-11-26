import type { Route, Schema } from "./shared.ts";
import { get, ref, obj, arr, str, int, bool, uuid, dateTime, nullable, enumOf, raw, pathParam, query } from "./shared.ts";
import { a2uiVersionHeader, chatEvents, statusPhases } from "./conversations.ts";

const id = pathParam("id", { type: "string", description: "A bot id, or the literal push for the caller's Push Bot." });

const at = { ...dateTime, description: "When the event was stored. A joined token has the time of its last row." };

const isSchema = (value: unknown): value is Schema => typeof value === "object" && value !== null && !Array.isArray(value);
const schemaList = (value: unknown): Array<Schema> | undefined => (Array.isArray(value) ? value.filter(isSchema) : undefined);
const stringList = (value: unknown): Array<string> => (Array.isArray(value) ? value.filter((item) => typeof item === "string") : []);
const schemaMap = (value: unknown): Record<string, Schema> =>
  (isSchema(value) ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, Schema] => isSchema(entry[1]))) : {});

/** A stored event: seq and at are always present. */
const stored = (event: Schema): Schema => {
  const variants = schemaList(event.oneOf ?? event.anyOf);
  if (variants) {return { ...event, [event.oneOf ? "oneOf" : "anyOf"]: variants.map(stored) };}
  return {
    ...event,
    properties: { ...schemaMap(event.properties), at },
    required: [...stringList(event.required).filter((field) => field !== "seq"), "seq", "at"],
  };
};

const narrowed = (event: Schema, fields: Record<string, Schema>): Schema => ({
  ...event,
  properties: { ...schemaMap(event.properties), ...fields },
});

// done ends a stored turn and is not kept.
const { status: _status, done: _done, cancelled, tool, ...kept } = chatEvents;

// The shared event list is looser than the rows the AI service stores. These are the stored values.
const turnEvents: Array<Schema> = [
  ...Object.values(kept),
  narrowed(tool, {
    tier: enumOf("READ", "SAFE_WRITE", "RISKY_WRITE"),
    result: { type: "object", additionalProperties: true },
  }),
  ...statusPhases,
  { ...cancelled, required: [...stringList(cancelled.required), "resumable"] },
].map(stored);

const attachment = obj({ kind: enumOf("file", "document", "posting", "link"), id: uuid, title: str });

export const schemas = {
  BotTurn: obj({
    id: { type: "string", description: "Opaque. Equals turn on the frames of this run's stream." },
    status: enumOf("PENDING", "RUNNING", "DONE", "FAILED", "CANCELLED"),
    createdAt: dateTime,
    user: {
      ...nullable(obj({ messageId: uuid, text: str, attachments: arr(attachment) })),
      description: "The message that started the turn, with the attachments stored at send. null for a card answer.",
    },
    answer: nullable(obj({ approvalId: uuid, optionId: nullable(str), optionIds: arr(str) }, ["approvalId", "optionId"])),
    events: {
      ...arr({ oneOf: turnEvents }),
      description: "The frames the bot stream sent, in seq order, without done. Tokens with nothing but status between them are one event, stored at its last row's seq and at. A tool, think, card, or any other frame between two tokens keeps two events. Only the first terminal event (error or cancelled) is kept. A PENDING or RUNNING turn keeps every status; a finished turn keeps only waiting ones.",
    },
    assistant: {
      ...nullable(obj({ messageId: uuid, text: str, sources: arr(attachment) })),
      description: "The bot's reply. null while it runs and for a turn that ended on a card or failed before replying.",
    },
  }),
  Transcript: obj({
    data: arr(ref("BotTurn")),
    page: obj({ nextCursor: nullable(str), hasMore: bool }),
    live: {
      ...nullable(obj({ turnId: str, lastSeq: int })),
      description: "First page only, while the newest turn is PENDING or RUNNING. Follow GET /bots/{id}/stream?after=lastSeq.",
    },
  }),
};

export const routes: Array<Route> = [
  get("ai", "/api/v1/bots/{id}/transcript", {
    tag: "bots",
    summary: "Read a bot's chat, newest turn first",
    description: "One item per chat job of the bot's thread, with its messages and its stored frames, so a reopened chat draws what the stream showed. A bot with no thread, and push before the Push Bot exists, has no turns. No body holds the id of the conversation that stores the thread. Turns stay until the bot is deleted or its chat is cleared. 404 for an unknown bot.",
    params: [
      id,
      query("limit", { type: "integer", minimum: 1, maximum: 100, default: 30 }, "1 to 100. A larger integer is clamped to 100. Zero or a non-integer is 400."),
      query("cursor", str, "Opaque cursor from page.nextCursor"),
      a2uiVersionHeader,
    ],
    responses: { 200: raw(ref("Transcript")) },
  }),
];
