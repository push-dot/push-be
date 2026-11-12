import type { Route, Schema } from "./shared.ts";
import {
  get, post, patch, del, ref, obj, closed, arr, str, bool, uuid, dateTime, nullable, int, enumOf,
  body, ok, noContent, pathParam,
} from "./shared.ts";

const id = pathParam("id", { type: "string", description: "A bot id, or the literal push for the caller's Push Bot." });

const botColor = enumOf("teal", "sky", "blue", "violet", "pink", "red", "coral", "amber", "green", "brown", "gray");
const displayName = { type: "string", minLength: 1, maxLength: 120 };

const botStatus = { type: "string", enum: ["DONE", "RUNNING", "NEEDS_APPROVAL"] };

const bot = obj({
  id: uuid,
  kind: { type: "string", enum: ["push", "company"] },
  displayName: str,
  companyId: nullable(uuid),
  companyName: str,
  color: { ...nullable(botColor), description: "null exactly when kind is push." },
  postingId: nullable(uuid),
  postingUrl: nullable(str),
  avatarKey: nullable(str),
  mascotKey: nullable(str),
  notificationsMuted: bool,
  revision: int,
  createdAt: dateTime,
  updatedAt: dateTime,
  lastMessagePreview: str,
  unread: bool,
  status: botStatus,
});

const linkPreview = {
  oneOf: [
    closed({ status: { type: "string", const: "found" }, company: str, title: str, postingId: uuid }, ["status", "company", "title", "postingId"]),
    closed({ status: { type: "string", const: "not_a_posting" } }, ["status"]),
  ],
};

const createBotBody = closed({ postingId: uuid, displayName, color: botColor }, ["postingId"]);

const updateBotBody = closed({
  expectedRevision: int,
  displayName,
  notificationsMuted: bool,
  color: botColor,
}, ["expectedRevision"]);

export const schemas: Record<string, Schema> = {
  Bot: bot,
  CreateBotBody: createBotBody,
  UpdateBotBody: updateBotBody,
  BotLinkPreview: linkPreview,
};

export const routes: Route[] = [
  get("core", "/api/v1/bots", {
    tag: "bots",
    summary: "List bots for the signed-in user",
    description: "Ensures the default Push bot exists. Push bot is listed first. Includes last message preview, unread flag, and aggregate status when cheap.",
    responses: { 200: ok(arr(ref("Bot"))) },
  }),
  post("core", "/api/v1/bots", {
    tag: "bots",
    summary: "Open the company bot of a posting, creating it when the caller has none for that company",
    description: "One bot per company: the company is the posting's company name, compared without case and outer spaces. 201 when created. 200 with the existing bot when the caller already has one for that company; displayName and color are ignored then. Any other body key is 400. 403 CONSENT_REQUIRED without reference-data consent. 403 BOT_LIMIT, on the create path only, when the personal plan cap is reached (FREE 3, PRO 20, ULTRA unlimited). Push bot does not count. 404 when the posting does not exist or is a draft.",
    body: body(ref("CreateBotBody")),
    responses: { 200: ok(ref("Bot"), "The caller already has a bot for that company"), 201: ok(ref("Bot"), "Created") },
  }),
  post("core", "/api/v1/bots/link-preview", {
    tag: "bots",
    summary: "Resolve a job posting URL before creating a bot",
    body: body(closed({ url: str }, ["url"])),
    responses: { 200: ok(ref("BotLinkPreview")) },
  }),
  get("core", "/api/v1/bots/{id}", {
    tag: "bots",
    summary: "Get a bot profile",
    params: [id],
    responses: { 200: ok(ref("Bot")) },
  }),
  patch("core", "/api/v1/bots/{id}", {
    tag: "bots",
    summary: "Update a bot",
    description: "The Push bot accepts notificationsMuted only. Any other body key is 400.",
    params: [id],
    body: body(ref("UpdateBotBody")),
    responses: { 200: ok(ref("Bot")) },
  }),
  del("core", "/api/v1/bots/{id}", {
    tag: "bots",
    summary: "Delete a company bot and erase its chat",
    description: "Deletes the bot with its thread, messages, jobs, events, cards, workspace files, work-done notifications and read marker. Usage rows stay. 403 DEFAULT_BOT_PROTECTED for the Push bot.",
    params: [id],
    responses: { 204: noContent },
  }),
  del("core", "/api/v1/bots/{id}/transcript", {
    tag: "bots",
    summary: "Erase a bot's chat and keep the bot",
    description: "Deletes the thread with its messages, jobs, events, cards, workspace files and work-done notifications. The bot, its settings and its read marker stay. 204 when the bot has no thread.",
    params: [id],
    responses: { 204: noContent },
  }),
  post("core", "/api/v1/bots/{id}/read", {
    tag: "bots",
    summary: "Mark a bot read",
    params: [id],
    responses: { 200: ok(closed({ readAt: dateTime }, ["readAt"])) },
  }),
];
