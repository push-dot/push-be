import type { Route, Schema } from "./shared.ts";
import {
  get, post, patch, del, ref, obj, closed, arr, str, bool, uuid, dateTime, nullable, int,
  body, ok, okPage, noContent, pathParam, query, pageParams,
} from "./shared.ts";

const id = pathParam("id");

const botStatus = { type: "string", enum: ["DONE", "RUNNING", "NEEDS_APPROVAL"] };

const bot = obj({
  id: uuid,
  kind: { type: "string", enum: ["push", "company"] },
  displayName: str,
  companyId: nullable(uuid),
  companyName: str,
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

const companyHit = closed({ name: str, openPostingCount: int }, ["name", "openPostingCount"]);

export const schemas: Record<string, Schema> = {
  Bot: bot,
  BotCompanyHit: companyHit,
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
    summary: "Create a company bot",
    description: "403 BOT_LIMIT when the personal plan cap is reached (FREE 3, PRO 20, ULTRA unlimited). Push bot does not count.",
    body: body(closed({
      companyId: nullable(uuid),
      companyName: str,
      postingId: nullable(uuid),
      postingUrl: nullable(str),
      displayName: str,
    })),
    responses: { 201: ok(ref("Bot"), "Created") },
  }),
  post("core", "/api/v1/bots/link-preview", {
    tag: "bots",
    summary: "Resolve a job posting URL before creating a bot",
    body: body(closed({ url: str }, ["url"])),
    responses: { 200: ok(ref("BotLinkPreview")) },
  }),
  get("core", "/api/v1/bots/companies/search", {
    tag: "bots",
    summary: "Search companies by name with open posting counts",
    params: [...pageParams, query("q", str, "Required company name substring")],
    responses: { 200: okPage(ref("BotCompanyHit")) },
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
    params: [id],
    body: body(closed({
      expectedRevision: int,
      displayName: str,
      notificationsMuted: bool,
      avatarKey: nullable(str),
      mascotKey: nullable(str),
    }, ["expectedRevision"])),
    responses: { 200: ok(ref("Bot")) },
  }),
  del("core", "/api/v1/bots/{id}", {
    tag: "bots",
    summary: "Delete a company bot",
    description: "403 DEFAULT_BOT_PROTECTED for the Push bot.",
    params: [id],
    responses: { 204: noContent },
  }),
  get("core", "/api/v1/bots/{id}/conversations", {
    tag: "bots",
    summary: "List conversations under a bot",
    params: [id, ...pageParams],
    responses: { 200: okPage(ref("Conversation")) },
  }),
  post("core", "/api/v1/bots/{id}/conversations", {
    tag: "bots",
    summary: "Start a conversation under a bot",
    params: [id],
    body: body(closed({ title: str, applicationId: nullable(uuid) }, ["title"])),
    responses: { 201: ok(ref("Conversation"), "Created") },
  }),
  post("core", "/api/v1/bots/{id}/read", {
    tag: "bots",
    summary: "Mark a bot read",
    params: [id],
    responses: { 200: ok(closed({ readAt: dateTime }, ["readAt"])) },
  }),
];
